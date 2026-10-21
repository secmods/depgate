/**
 * A small SAML 2.0 identity provider for tests. Test-only; excluded from the build.
 * It reads DepGate's AuthnRequest from the redirect, answers with a signed Response for `account`,
 * and can be told to misbehave (wrong audience, expired, unsigned, signed by another key, wrapped
 * signatures, tampered after signing...) so every check a real IdP never fails on demand is tested.
 */
import { createVerify, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { encrypt } from 'xml-encryption';
import { generateSpCertificate } from '../services/saml-certs.js';

const PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';
export const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
export const PERSISTENT_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const TRANSIENT_FORMAT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';

export interface MockSamlAccount {
  nameId: string;
  /** Default emailAddress. */
  nameIdFormat?: string;
  /** Attribute name → value(s). */
  attributes?: Record<string, string | string[]>;
  /** NameID XML as is, for comment-injection tests. */
  rawNameId?: string;
}

export interface SamlTamper {
  audience?: string;
  /** Assertion and Response Issuer. */
  issuer?: string;
  /** null leaves the attribute out. */
  destination?: string | null;
  recipient?: string | null;
  inResponseTo?: string | null;
  /** Seconds from now; negative means already expired. */
  expiresIn?: number;
  /** Seconds from now that the assertion becomes valid. */
  notBefore?: number;
  /** What carries a signature. Default: both, as most IdPs do. */
  sign?: 'assertion' | 'response' | 'both' | 'none';
  /** Sign with a key DepGate does not know, its certificate in KeyInfo. */
  otherKey?: boolean;
  /** Changes the XML after signing. */
  afterSign?: (xml: string) => string;
  /** Signature-wrapping attacks. */
  xsw?: 'extensions' | 'copy-signature';
  /** Encrypt the assertion to this SP certificate. */
  encryptTo?: string;
  /** A non-success status instead of an assertion. */
  status?: { code: string; subcode?: string; message?: string };
  assertionId?: string;
}

export interface ReceivedRequest {
  id: string;
  issuer: string;
  acsUrl: string;
  nameIdFormat: string | null;
  relayState: string;
  /** SigAlg and Signature were on the redirect. */
  signed: boolean;
  /** When signed: whether the signature verifies with `spCertificate`. */
  signatureValid: boolean | null;
  xml: string;
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const iso = (offsetSeconds: number) => new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const newId = () => `_${randomBytes(16).toString('hex')}`;

function sign(xml: string, localName: 'Assertion' | 'Response', key: string, cert: string): string {
  const sig = new SignedXml({
    privateKey: key,
    publicCert: cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  const target = localName === 'Response' ? "/*[local-name(.)='Response']" : "//*[local-name(.)='Assertion']";
  sig.addReference({
    xpath: target,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: `${target}/*[local-name(.)='Issuer']`, action: 'after' } });
  return sig.getSignedXml();
}

function encryptAssertion(assertionXml: string, certificate: string): Promise<string> {
  return new Promise((resolve, reject) => {
    encrypt(
      assertionXml,
      {
        rsa_pub: certificate,
        pem: certificate,
        encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
        keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
        disallowEncryptionWithInsecureAlgorithm: true,
      },
      (err, result) => (err ? reject(err) : resolve(`<saml:EncryptedAssertion xmlns:saml="${ASSERTION}">${result}</saml:EncryptedAssertion>`))
    );
  });
}

export class MockSamlIdp {
  entityId = 'https://idp.example.test/saml/metadata';
  /** Set by start(): the HTTP-Redirect SSO endpoint and the metadata URL. */
  ssoUrl = '';
  metadataUrl = '';
  readonly certificate: string;
  readonly privateKey: string;
  private readonly other = generateSpCertificate('Someone else');
  /** The account the next response is for. */
  account: MockSamlAccount = { nameId: 'someone@example.com' };
  /** Misbehaviour for the next response only. */
  tamper: SamlTamper = {};
  /** The SP certificate, to check signed AuthnRequests. */
  spCertificate = '';
  /** Changes to the metadata document, e.g. no Redirect binding. */
  metadataOverride: string | null = null;
  lastRequest: ReceivedRequest | null = null;
  private server: Server | null = null;

  constructor() {
    const pair = generateSpCertificate('Mock SAML IdP');
    this.certificate = pair.certificate;
    this.privateKey = pair.privateKey;
  }

  /** Serves the metadata over HTTP, for the metadata URL path. */
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      if (req.url === '/metadata') {
        res.setHeader('content-type', 'application/samlmetadata+xml');
        res.end(this.metadataOverride ?? this.metadataXml());
        return;
      }
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', '/metadata');
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    this.server.keepAliveTimeout = 120_000;
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.ssoUrl = `http://127.0.0.1:${port}/sso`;
    this.metadataUrl = `http://127.0.0.1:${port}/metadata`;
    return this;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  certificateBody(pem = this.certificate): string {
    return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  }

  metadataXml(opts: { certificates?: string[]; ssoUrl?: string } = {}): string {
    const certs = (opts.certificates ?? [this.certificate])
      .map((pem) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${this.certificateBody(pem)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(this.entityId)}">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certs}
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${this.certificateBody(this.other.certificate)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>${EMAIL_FORMAT}</md:NameIDFormat>
    <md:NameIDFormat>${PERSISTENT_FORMAT}</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(opts.ssoUrl ?? this.ssoUrl)}/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(opts.ssoUrl ?? this.ssoUrl)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
  }

  /** Reads the AuthnRequest from DepGate's redirect, as the IdP would. */
  readRequest(redirectUrl: string): ReceivedRequest {
    const url = new URL(redirectUrl);
    const raw = url.search.slice(1);
    const params = new URLSearchParams(raw);
    const encoded = params.get('SAMLRequest');
    if (!encoded) throw new Error('No SAMLRequest on the redirect');
    const xml = inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8');
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    const issuer = doc.getElementsByTagNameNS(ASSERTION, 'Issuer')[0]?.textContent ?? '';
    const policy = doc.getElementsByTagNameNS(PROTOCOL, 'NameIDPolicy')[0];
    const signature = params.get('Signature');
    let signatureValid: boolean | null = null;
    if (signature) {
      // HTTP-Redirect binding: the signature covers the raw query parameters, in this order.
      const pick = (name: string) => raw.split('&').find((part) => part.startsWith(`${name}=`));
      const signed = ['SAMLRequest', 'RelayState', 'SigAlg'].map(pick).filter(Boolean).join('&');
      signatureValid = this.spCertificate
        ? createVerify('RSA-SHA256').update(signed).verify(this.spCertificate, signature, 'base64')
        : false;
    }
    this.lastRequest = {
      id: root.getAttribute('ID') ?? '',
      issuer,
      acsUrl: root.getAttribute('AssertionConsumerServiceURL') ?? '',
      nameIdFormat: policy?.getAttribute('Format') ?? null,
      relayState: params.get('RelayState') ?? '',
      signed: Boolean(signature),
      signatureValid,
      xml,
    };
    return this.lastRequest;
  }

  /** Plays the IdP for one sign-in: the form the browser would post to the ACS. */
  async authorize(redirectUrl: string): Promise<{ acsUrl: string; form: { SAMLResponse: string; RelayState: string } }> {
    const request = this.readRequest(redirectUrl);
    const SAMLResponse = await this.response({ requestId: request.id, acsUrl: request.acsUrl, audience: request.issuer });
    this.tamper = {};
    return { acsUrl: request.acsUrl, form: { SAMLResponse, RelayState: request.relayState } };
  }

  /** A base64 SAMLResponse. */
  async response(to: { requestId: string; acsUrl: string; audience: string }): Promise<string> {
    const t = this.tamper;
    const issuer = t.issuer ?? this.entityId;
    const inResponseTo = t.inResponseTo === undefined ? to.requestId : t.inResponseTo;
    const destination = t.destination === undefined ? to.acsUrl : t.destination;
    const recipient = t.recipient === undefined ? to.acsUrl : t.recipient;
    const expires = iso(t.expiresIn ?? 300);
    const responseAttrs = [
      `ID="${newId()}"`,
      'Version="2.0"',
      `IssueInstant="${iso(0)}"`,
      destination === null ? '' : `Destination="${esc(destination)}"`,
      inResponseTo === null ? '' : `InResponseTo="${esc(inResponseTo)}"`,
    ].filter(Boolean).join(' ');

    if (t.status) {
      const sub = t.status.subcode ? `<samlp:StatusCode Value="${t.status.subcode}"/>` : '';
      const msg = t.status.message ? `<samlp:StatusMessage>${esc(t.status.message)}</samlp:StatusMessage>` : '';
      const xml = `<samlp:Response xmlns:samlp="${PROTOCOL}" xmlns:saml="${ASSERTION}" ${responseAttrs}><saml:Issuer>${esc(issuer)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${t.status.code}">${sub}</samlp:StatusCode>${msg}</samlp:Status></samlp:Response>`;
      return Buffer.from(xml).toString('base64');
    }

    const a = this.account;
    const format = a.nameIdFormat ?? EMAIL_FORMAT;
    const attributes = Object.entries(a.attributes ?? {})
      .map(([name, value]) => {
        const values = (Array.isArray(value) ? value : [value]).map((v) => `<saml:AttributeValue>${esc(v)}</saml:AttributeValue>`).join('');
        return `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${values}</saml:Attribute>`;
      })
      .join('');
    const assertionId = t.assertionId ?? newId();
    const confirmationAttrs = [
      inResponseTo === null ? '' : `InResponseTo="${esc(inResponseTo)}"`,
      `NotOnOrAfter="${expires}"`,
      recipient === null ? '' : `Recipient="${esc(recipient)}"`,
    ].filter(Boolean).join(' ');
    const assertion = `<saml:Assertion xmlns:saml="${ASSERTION}" ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}"><saml:Issuer>${esc(issuer)}</saml:Issuer><saml:Subject><saml:NameID Format="${format}">${a.rawNameId ?? esc(a.nameId)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData ${confirmationAttrs}/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(t.notBefore ?? -30)}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${esc(t.audience ?? to.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : ''}</saml:Assertion>`;

    const key = t.otherKey ? this.other.privateKey : this.privateKey;
    const cert = t.otherKey ? this.other.certificate : this.certificate;
    const mode = t.sign ?? 'both';
    let signedAssertion = mode === 'assertion' || mode === 'both' ? sign(assertion, 'Assertion', key, cert) : assertion;
    if (t.encryptTo) signedAssertion = await encryptAssertion(signedAssertion, t.encryptTo);

    const status = `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>`;
    let body = signedAssertion;
    if (t.xsw === 'extensions') {
      // The signed assertion is hidden in Extensions; an unsigned one for someone else takes its place.
      const evil = assertion.replace(/ID="[^"]+"/, `ID="${newId()}"`).replace(/>[^<]*<\/saml:NameID>/, '>attacker@evil.test</saml:NameID>');
      body = evil;
      const xml = `<samlp:Response xmlns:samlp="${PROTOCOL}" xmlns:saml="${ASSERTION}" ${responseAttrs}><saml:Issuer>${esc(issuer)}</saml:Issuer><samlp:Extensions>${signedAssertion}</samlp:Extensions>${status}${body}</samlp:Response>`;
      return Buffer.from(t.afterSign ? t.afterSign(xml) : xml).toString('base64');
    }
    if (t.xsw === 'copy-signature') {
      // Someone else's assertion carrying the genuine assertion's signature.
      const signature = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signedAssertion)?.[0] ?? '';
      body = assertion
        .replace(/ID="[^"]+"/, `ID="${newId()}"`)
        .replace(/>[^<]*<\/saml:NameID>/, '>attacker@evil.test</saml:NameID>')
        .replace('</saml:Issuer>', `</saml:Issuer>${signature}`);
    }
    let xml = `<samlp:Response xmlns:samlp="${PROTOCOL}" xmlns:saml="${ASSERTION}" ${responseAttrs}><saml:Issuer>${esc(issuer)}</saml:Issuer>${status}${body}</samlp:Response>`;
    if (mode === 'response' || mode === 'both') xml = sign(xml, 'Response', key, cert);
    if (t.afterSign) xml = t.afterSign(xml);
    return Buffer.from(xml).toString('base64');
  }
}
