/**
 * X.509 certificates for SAML (requirements_sso.md R3): reading the IdP signing certificates the admin
 * pastes or the metadata carries, and generating the SP's own self-signed certificate. Node's crypto
 * only; no certificate library.
 */
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Certificates within this many days of expiry are flagged in the UI (R3). */
export const EXPIRY_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

export interface CertificateInfo {
  subject: string;
  issuer: string;
  /** SHA-256 over the DER, colon-separated upper-case hex, as most providers show it. */
  fingerprint: string;
  notBefore: string;
  notAfter: string;
  expired: boolean;
  /** Expires within EXPIRY_WARNING_DAYS. */
  expiresSoon: boolean;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

function wrapPem(label: string, base64: string): string {
  const body = base64.replace(/\s+/g, '');
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`;
}

/**
 * Every certificate in the text, as PEM: PEM blocks, or one bare base64 body as metadata's
 * X509Certificate element carries it. Throws when a block is not a certificate.
 */
export function splitCertificates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  const blocks = [...trimmed.matchAll(PEM_BLOCK)];
  if (blocks.length === 0) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) throw new Error('This is not a PEM certificate');
    out.push(normalizeCertificate(wrapPem('CERTIFICATE', trimmed)));
    return out;
  }
  for (const block of blocks) {
    if (block[1] !== 'CERTIFICATE') throw new Error(`Expected a CERTIFICATE, found ${block[1]}`);
    out.push(normalizeCertificate(block[0]));
  }
  return out;
}

/** The certificate re-encoded as canonical PEM. Throws when it does not parse. */
export function normalizeCertificate(pem: string): string {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new Error('The certificate could not be read. Paste the whole PEM, including the BEGIN and END lines.');
  }
  return cert.toString();
}

function oneLine(name: string): string {
  return name.split('\n').filter(Boolean).join(', ');
}

export function describeCertificate(pem: string, now = new Date()): CertificateInfo {
  const cert = new X509Certificate(pem);
  const notAfter = new Date(cert.validTo);
  return {
    subject: oneLine(cert.subject),
    issuer: oneLine(cert.issuer),
    fingerprint: cert.fingerprint256,
    notBefore: new Date(cert.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    expired: notAfter.getTime() <= now.getTime(),
    expiresSoon: notAfter.getTime() - now.getTime() < EXPIRY_WARNING_DAYS * DAY_MS,
  };
}

/** The private key as PKCS#8 PEM, after checking it is an RSA key that belongs to the certificate. */
export function checkKeyPair(certificatePem: string, privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error('The private key could not be read. Paste an unencrypted PEM private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('The private key must be an RSA key');
  const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fromCert = new X509Certificate(certificatePem).publicKey.export({ type: 'spki', format: 'der' });
  if (!fromKey.equals(fromCert)) throw new Error('The private key does not belong to the certificate');
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

// --- DER, just enough for one self-signed certificate ---

function tlv(tag: number, value: Buffer): Buffer {
  const len = value.length;
  if (len < 0x80) return Buffer.concat([Buffer.from([tag, len]), value]);
  const bytes: number[] = [];
  for (let n = len; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.concat([Buffer.from([tag, 0x80 | bytes.length, ...bytes]), value]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const explicit = (n: number, inner: Buffer) => tlv(0xa0 | n, inner);
const nullValue = () => Buffer.from([0x05, 0x00]);
const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes: Buffer, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
const octetString = (bytes: Buffer) => tlv(0x04, bytes);
const boolean = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

function integer(bytes: Buffer): Buffer {
  let body = bytes;
  while (body.length > 1 && body[0] === 0 && (body[1] & 0x80) === 0) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [];
    let n = arc;
    do {
      chunk.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime up to 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const SHA256_WITH_RSA = seq(oid('1.2.840.113549.1.1.11'), nullValue());

function name(commonName: string): Buffer {
  return seq(set(seq(oid('2.5.4.3'), utf8(commonName))));
}

export interface GeneratedKeyPair {
  certificate: string;
  privateKey: string;
}

/** R3 Generate: a self-signed RSA 2048 / SHA-256 certificate, valid for 5 years. */
export function generateSpCertificate(commonName: string, now = new Date()): GeneratedKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 5);
  const subject = name(commonName.slice(0, 64));
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const extensions = seq(
    // basicConstraints, critical: not a CA.
    seq(oid('2.5.29.19'), boolean(true), octetString(seq())),
    // keyUsage, critical: digitalSignature and keyEncipherment (signing requests, decrypting assertions).
    seq(oid('2.5.29.15'), boolean(true), octetString(bitString(Buffer.from([0xa0]), 5)))
  );
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    SHA256_WITH_RSA,
    subject,
    seq(time(now), time(notAfter)),
    subject,
    spki,
    explicit(3, extensions)
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, SHA256_WITH_RSA, bitString(signature));
  return {
    certificate: wrapPem('CERTIFICATE', der.toString('base64')),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** The PEM body only, as metadata and xml-crypto's KeyInfo want it. */
export function certificateBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}
