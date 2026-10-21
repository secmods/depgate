import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { certificateBody, checkKeyPair, describeCertificate, generateSpCertificate, normalizeCertificate, splitCertificates } from './saml-certs.js';

describe('SAML certificates (R3)', () => {
  const pair = generateSpCertificate('DepGate single sign-on');

  it('generates a self-signed RSA 2048 / SHA-256 certificate valid for 5 years', () => {
    const cert = new X509Certificate(pair.certificate);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.subject).toBe('CN=DepGate single sign-on');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(cert.ca).toBe(false);
    const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(4.99);
    expect(years).toBeLessThan(5.01);
    expect(pair.privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(cert.checkPrivateKey(createPrivateKey(pair.privateKey))).toBe(true);
  });

  it('gives each certificate its own serial and key', () => {
    const other = generateSpCertificate('DepGate single sign-on');
    expect(new X509Certificate(other.certificate).serialNumber).not.toBe(new X509Certificate(pair.certificate).serialNumber);
    expect(other.privateKey).not.toBe(pair.privateKey);
  });

  it('uses GeneralizedTime after 2049, as RFC 5280 requires', () => {
    const late = new X509Certificate(generateSpCertificate('late', new Date('2048-06-01T00:00:00Z')).certificate);
    expect(new Date(late.validTo).getUTCFullYear()).toBe(2053);
  });

  it('describes a certificate: subject, issuer, SHA-256 fingerprint, validity, expiry warnings', () => {
    const info = describeCertificate(pair.certificate);
    expect(info.subject).toBe('CN=DepGate single sign-on');
    expect(info.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(info).toMatchObject({ expired: false, expiresSoon: false });
    const nearEnd = new Date(Date.parse(info.notAfter) - 10 * 86_400_000);
    expect(describeCertificate(pair.certificate, nearEnd)).toMatchObject({ expired: false, expiresSoon: true });
    expect(describeCertificate(pair.certificate, new Date(Date.parse(info.notAfter) + 1000))).toMatchObject({ expired: true });
  });

  it('reads PEM blocks and a bare base64 body, and refuses anything else', () => {
    const other = generateSpCertificate('second');
    expect(splitCertificates(`${pair.certificate}\n\n${other.certificate}`)).toHaveLength(2);
    expect(splitCertificates(certificateBody(pair.certificate))).toEqual([normalizeCertificate(pair.certificate)]);
    expect(splitCertificates('   ')).toEqual([]);
    expect(() => splitCertificates(pair.privateKey)).toThrow(/Expected a CERTIFICATE/);
    expect(() => splitCertificates('hello <world>')).toThrow(/not a PEM certificate/);
    expect(() => splitCertificates('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(/could not be read/);
  });

  it('accepts only an RSA private key that belongs to the certificate', () => {
    expect(checkKeyPair(pair.certificate, pair.privateKey)).toContain('BEGIN PRIVATE KEY');
    expect(() => checkKeyPair(pair.certificate, generateSpCertificate('x').privateKey)).toThrow(/does not belong/);
    expect(() => checkKeyPair(pair.certificate, 'not a key')).toThrow(/could not be read/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => checkKeyPair(pair.certificate, ec)).toThrow(/RSA/);
  });
});
