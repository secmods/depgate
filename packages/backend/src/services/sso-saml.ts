/**
 * SAML 2.0 service provider (requirements_sso.md R3, §8.2). SP-initiated only: the AuthnRequest goes
 * out with the HTTP-Redirect binding, the response comes back to the ACS with HTTP-POST.
 *
 * @node-saml/node-saml checks the XML signature against the configured certificates only, the
 * InResponseTo, the time conditions and the audience. It does not check the assertion's Issuer, the
 * Response Destination or the SubjectConfirmation Recipient, so those are checked here, along with
 * a replay cache of assertion IDs. Nothing here is vendor-specific.
 */
import { randomBytes } from 'node:crypto';
import { SAML, SamlStatusError, ValidateInResponseTo, generateServiceProviderMetadata, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { SamlProviderConfig } from '../db/entities/SsoProvider.js';
import { config as appConfig } from '../config.js';
import { splitCertificates } from './saml-certs.js';
import { idpUrlProblem } from './sso-rules.js';

export { NAMEID_EMAIL } from './sso-rules.js';

/**
 * The few DOM members read here. @xmldom/xmldom's own typings add the browser DOM library to the
 * whole build, whose ReadableStream clashes with Node's, so the module is loaded without them.
 */
interface XmlNode {
  nodeType: number;
  firstChild: XmlNode | null;
  nextSibling: XmlNode | null;
  textContent: string | null;
}
interface XmlElement extends XmlNode {
  namespaceURI: string | null;
  localName: string;
  getAttribute(name: string): string | null;
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<XmlElement>;
}
interface XmlDocument {
  documentElement: XmlElement | null;
  getElementsByTagNameNS(namespace: string, localName: string): ArrayLike<XmlElement>;
}
type XmlErrorHandler = (level: 'warning' | 'error' | 'fatalError', message: string) => void;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DOMParser } = require('@xmldom/xmldom') as {
  DOMParser: new (options: { onError: XmlErrorHandler }) => { parseFromString(xml: string, mimeType: string): XmlDocument | undefined };
};
export const NAMEID_PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
export const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
export const NAMEID_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified';

const MD_NS = 'urn:oasis:names:tc:SAML:2.0:metadata';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
const REDIRECT_BINDING = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BEARER = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';

/** Metadata and responses are small. Anything larger is refused before it is parsed. */
export const MAX_XML_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
/** How long an assertion ID is remembered when the assertion names no expiry of its own. */
const DEFAULT_REPLAY_TTL_SECONDS = 600;
const MAX_REPLAY_TTL_SECONDS = 24 * 3600;

export class SamlError extends Error {
  constructor(
    message: string,
    /** Same reasons as OIDC: unreachable, answered wrongly, or the IdP refused the person. */
    readonly reason: 'provider_unavailable' | 'invalid_response' | 'provider_error'
  ) {
    super(message);
  }
}

/** The URLs the admin registers at the IdP (R3). The entity ID is the metadata URL, so it resolves. */
export function samlUrls(id: string, publicUrl: string): { spEntityId: string; acsUrl: string; spMetadataUrl: string } {
  const base = publicUrl.replace(/\/+$/, '');
  const metadata = `${base}/api/auth/saml/${id}/metadata`;
  return { spEntityId: metadata, acsUrl: `${base}/api/auth/saml/${id}/acs`, spMetadataUrl: metadata };
}

// --- IdP metadata ---

export interface IdpMetadata {
  entityId: string;
  ssoUrl: string;
  certificates: string[];
  nameIdFormats: string[];
  wantAuthnRequestsSigned: boolean;
}

/**
 * Parses XML without DTDs: a DOCTYPE is refused outright, so no entity can be declared or expanded.
 * Throws on malformed XML.
 */
export function parseXml(xml: string, what: string): XmlDocument & { documentElement: XmlElement } {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new SamlError(`The ${what} is larger than 1 MB`, 'invalid_response');
  if (/<!DOCTYPE/i.test(xml)) throw new SamlError(`The ${what} contains a DOCTYPE, which is not accepted`, 'invalid_response');
  const problems: string[] = [];
  let doc: XmlDocument | undefined;
  try {
    doc = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') problems.push(message);
      },
    }).parseFromString(xml, 'text/xml');
  } catch (err) {
    // A fatal error also stops the parser with a ParseError once it has been reported above.
    if (!problems.length) problems.push(err instanceof Error ? err.message : String(err));
  }
  const root = doc?.documentElement;
  if (problems.length || !doc || !root) {
    throw new SamlError(`The ${what} is not valid XML${problems.length ? `: ${problems[0].split('\n')[0]}` : ''}`, 'invalid_response');
  }
  return Object.assign(doc, { documentElement: root });
}

function children(parent: XmlElement, ns: string, localName: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const el = node as XmlElement;
      if (el.namespaceURI === ns && el.localName === localName) out.push(el);
    }
  }
  return out;
}

function descendants(parent: XmlElement | XmlDocument, ns: string, localName: string): XmlElement[] {
  return Array.from(parent.getElementsByTagNameNS(ns, localName));
}

/** Reads entity ID, Redirect-binding SSO URL and signing certificates from IdP metadata (R3). */
export function parseIdpMetadata(xml: string): IdpMetadata {
  const doc = parseXml(xml, 'metadata');
  const root = doc.documentElement;
  const entities =
    root.namespaceURI === MD_NS && root.localName === 'EntityDescriptor'
      ? [root]
      : descendants(doc, MD_NS, 'EntityDescriptor');
  const idps = entities.filter((entity) => children(entity, MD_NS, 'IDPSSODescriptor').length > 0);
  if (idps.length === 0) throw new SamlError('The metadata describes no SAML identity provider (no IDPSSODescriptor)', 'invalid_response');
  if (idps.length > 1) {
    throw new SamlError('The metadata describes several identity providers. Use the metadata of the one DepGate should trust.', 'invalid_response');
  }
  const entity = idps[0];
  const entityId = entity.getAttribute('entityID')?.trim() ?? '';
  if (!entityId) throw new SamlError('The metadata has no entityID', 'invalid_response');
  const descriptor = children(entity, MD_NS, 'IDPSSODescriptor')[0];

  const sso = children(descriptor, MD_NS, 'SingleSignOnService').find((el) => el.getAttribute('Binding') === REDIRECT_BINDING);
  if (!sso?.getAttribute('Location')) {
    throw new SamlError('The identity provider offers no HTTP-Redirect single sign-on endpoint, which DepGate needs', 'invalid_response');
  }

  const certificates: string[] = [];
  for (const key of children(descriptor, MD_NS, 'KeyDescriptor')) {
    const use = key.getAttribute('use');
    if (use && use !== 'signing') continue;
    for (const certEl of descendants(key, DS_NS, 'X509Certificate')) {
      const body = certEl.textContent?.trim() ?? '';
      if (!body) continue;
      let pems: string[];
      try {
        pems = splitCertificates(body);
      } catch (err) {
        throw new SamlError(`A signing certificate in the metadata could not be read: ${(err as Error).message}`, 'invalid_response');
      }
      for (const pem of pems) if (!certificates.includes(pem)) certificates.push(pem);
    }
  }
  if (certificates.length === 0) throw new SamlError('The metadata has no signing certificate', 'invalid_response');

  return {
    entityId,
    ssoUrl: sso.getAttribute('Location')!.trim(),
    certificates,
    nameIdFormats: children(descriptor, MD_NS, 'NameIDFormat').map((el) => el.textContent?.trim() ?? '').filter(Boolean),
    wantAuthnRequestsSigned: descriptor.getAttribute('WantAuthnRequestsSigned') === 'true',
  };
}

/** Fetches IdP metadata: HTTPS only (localhost excepted), 5 s, 1 MB, redirects not followed (§10). */
export async function fetchIdpMetadata(url: string): Promise<IdpMetadata> {
  const problem = idpUrlProblem(url, appConfig.auth.ssoAllowInsecureHttp);
  if (problem) throw new SamlError(`Metadata URL ${problem}`, 'invalid_response');
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/samlmetadata+xml, application/xml, text/xml' } });
  } catch (err) {
    throw new SamlError(`Could not reach the metadata at ${url}: ${err instanceof Error ? err.message : String(err)}`, 'provider_unavailable');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new SamlError(`The metadata at ${url} redirects (HTTP ${res.status}); enter the final URL`, 'invalid_response');
  }
  if (!res.ok) throw new SamlError(`The metadata at ${url} answered HTTP ${res.status}`, 'invalid_response');
  if (Number(res.headers.get('content-length') ?? '0') > MAX_XML_BYTES) throw new SamlError('The metadata is larger than 1 MB', 'invalid_response');
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_XML_BYTES) throw new SamlError('The metadata is larger than 1 MB', 'invalid_response');
  return parseIdpMetadata(Buffer.from(body).toString('utf8'));
}

// --- Sign-in ---

export interface SamlProviderHandle {
  id: string;
  config: SamlProviderConfig;
  /** PKCS#8 PEM, empty when there is none or it can no longer be decrypted. */
  spPrivateKey: string;
}

export interface SamlUrls {
  spEntityId: string;
  acsUrl: string;
}

/** What the ACS needs to finish the flow. Stored server-side under RelayState. */
export interface PendingSamlLogin {
  relayState: string;
  requestId: string;
  acsUrl: string;
  /** ISO time the request was issued. */
  issuedAt: string;
}

/** A cache that knows exactly one request: the one this sign-in sent. Nothing else can be answered. */
function singleRequestCache(requestId: string | null, issuedAt: string): CacheProvider {
  return {
    saveAsync: async () => null,
    getAsync: async (key) => (requestId !== null && key === requestId ? issuedAt : null),
    removeAsync: async () => null,
  };
}

function samlClient(provider: SamlProviderHandle, urls: SamlUrls, expected: { requestId: string | null; issuedAt: string }): SAML {
  const cfg = provider.config;
  const signing = cfg.signRequests && provider.spPrivateKey ? { privateKey: provider.spPrivateKey, signatureAlgorithm: 'sha256' as const } : {};
  const decryption = cfg.acceptEncryptedAssertions && provider.spPrivateKey ? { decryptionPvk: provider.spPrivateKey } : {};
  return new SAML({
    entryPoint: cfg.ssoUrl,
    issuer: urls.spEntityId,
    audience: urls.spEntityId,
    callbackUrl: urls.acsUrl,
    idpCert: cfg.idpCertificates,
    identifierFormat: cfg.nameIdFormat || null,
    // Requesting PasswordProtectedTransport would refuse people who sign in with MFA or a passkey.
    disableRequestedAuthnContext: true,
    // With "Require signed assertion" on, the assertion itself must carry a valid signature; a signed
    // response around an unsigned assertion is refused. Off, the response must be signed instead.
    wantAssertionsSigned: cfg.requireSignedAssertion,
    wantAuthnResponseSigned: !cfg.requireSignedAssertion,
    acceptedClockSkewMs: cfg.clockSkewSeconds * 1000,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    cacheProvider: singleRequestCache(expected.requestId, expected.issuedAt),
    generateUniqueId: () => expected.requestId ?? newRequestId(),
    ...signing,
    ...decryption,
  });
}

/** An xs:ID: must not start with a digit. */
function newRequestId(): string {
  return `_${randomBytes(20).toString('hex')}`;
}

function checkProvider(provider: SamlProviderHandle): void {
  const cfg = provider.config;
  const problem = idpUrlProblem(cfg.ssoUrl, appConfig.auth.ssoAllowInsecureHttp);
  if (problem) throw new SamlError(`SSO URL ${problem}`, 'invalid_response');
  if (cfg.idpCertificates.length === 0) throw new SamlError('No IdP signing certificate is configured', 'invalid_response');
  if ((cfg.signRequests || cfg.acceptEncryptedAssertions) && !(cfg.spCertificate && provider.spPrivateKey)) {
    throw new SamlError('The SP certificate or its private key is missing or can no longer be read; generate or upload it again in Settings', 'provider_unavailable');
  }
}

/** Builds the AuthnRequest redirect. RelayState is random and keys the server-side state. */
export async function beginSamlLogin(provider: SamlProviderHandle, urls: SamlUrls): Promise<{ url: string; pending: PendingSamlLogin }> {
  checkProvider(provider);
  const pending: PendingSamlLogin = {
    relayState: randomBytes(32).toString('base64url'),
    requestId: newRequestId(),
    acsUrl: urls.acsUrl,
    issuedAt: new Date().toISOString(),
  };
  const client = samlClient(provider, urls, pending);
  const url = await client.getAuthorizeUrlAsync(pending.relayState, undefined, {});
  return { url, pending };
}

export interface SamlIdentity {
  subject: string;
  nameId: string;
  nameIdFormat: string;
  /** Attribute name → value; several values become an array. */
  attributes: Record<string, string | string[]>;
  assertionId: string;
}

function attributeValues(profile: Profile): Record<string, string | string[]> {
  const raw = (profile.attributes ?? {}) as Record<string, unknown>;
  const out: Record<string, string | string[]> = {};
  const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
  for (const [name, value] of Object.entries(raw)) {
    out[name] = Array.isArray(value) ? value.map(text) : text(value);
  }
  return out;
}

export function firstValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof first === 'string' ? first.trim() : '';
  return trimmed || null;
}

/** The ID and the latest expiry the (verified) assertion names, and whether a bearer confirmation is for this ACS. */
function inspectAssertion(assertionXml: string, acsUrl: string): { id: string; expiresAt: number | null; recipientOk: boolean; recipients: string[] } {
  const doc = parseXml(assertionXml, 'assertion');
  const assertion = doc.documentElement;
  const id = assertion.getAttribute('ID') ?? '';
  const times: number[] = [];
  const recipients: string[] = [];
  const SAML_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
  for (const conditions of descendants(assertion, SAML_NS, 'Conditions')) {
    const t = Date.parse(conditions.getAttribute('NotOnOrAfter') ?? '');
    if (!Number.isNaN(t)) times.push(t);
  }
  for (const confirmation of descendants(assertion, SAML_NS, 'SubjectConfirmation')) {
    if (confirmation.getAttribute('Method') !== BEARER) continue;
    for (const data of children(confirmation, SAML_NS, 'SubjectConfirmationData')) {
      const t = Date.parse(data.getAttribute('NotOnOrAfter') ?? '');
      if (!Number.isNaN(t)) times.push(t);
      const recipient = data.getAttribute('Recipient');
      if (recipient) recipients.push(recipient);
    }
  }
  return { id, expiresAt: times.length ? Math.max(...times) : null, recipientOk: recipients.includes(acsUrl), recipients };
}

/**
 * Validates the POSTed SAMLResponse for the request this sign-in sent. `remember` records the assertion
 * ID for its lifetime and returns false when it was already seen (replay, §8.2).
 */
export async function completeSamlLogin(
  provider: SamlProviderHandle,
  urls: SamlUrls,
  pending: PendingSamlLogin,
  samlResponse: unknown,
  remember: (assertionId: string, ttlSeconds: number) => Promise<boolean>
): Promise<SamlIdentity> {
  if (typeof samlResponse !== 'string' || !samlResponse) throw new SamlError('The identity provider posted no SAMLResponse', 'invalid_response');
  if (samlResponse.length > Math.ceil((MAX_XML_BYTES * 4) / 3) + 4) throw new SamlError('The SAMLResponse is larger than 1 MB', 'invalid_response');
  const responseXml = Buffer.from(samlResponse, 'base64').toString('utf8');
  const responseDoc = parseXml(responseXml, 'SAML response');
  const root = responseDoc.documentElement;
  if (root.localName !== 'Response' || root.namespaceURI !== 'urn:oasis:names:tc:SAML:2.0:protocol') {
    throw new SamlError('The SAMLResponse is not a SAML 2.0 Response', 'invalid_response');
  }
  checkProvider(provider);

  const client = samlClient(provider, urls, { requestId: pending.requestId, issuedAt: pending.issuedAt });
  let profile: Profile | null;
  try {
    ({ profile } = await client.validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (err) {
    if (err instanceof SamlStatusError) throw new SamlError(err.message, 'provider_error');
    throw new SamlError(`SAML response refused: ${err instanceof Error ? err.message : String(err)}`, 'invalid_response');
  }
  if (!profile) throw new SamlError('The SAML response carries no assertion', 'invalid_response');

  const cfg = provider.config;
  if (profile.issuer !== cfg.idpEntityId) {
    throw new SamlError(`The assertion was issued by "${profile.issuer ?? 'nobody'}", not "${cfg.idpEntityId}"`, 'invalid_response');
  }
  const destination = root.getAttribute('Destination');
  if (destination && destination !== urls.acsUrl) {
    throw new SamlError(`The response is addressed to ${destination}, not ${urls.acsUrl}`, 'invalid_response');
  }
  const assertionXml = profile.getAssertionXml?.() ?? '';
  const facts = inspectAssertion(assertionXml, urls.acsUrl);
  if (!facts.recipientOk) {
    throw new SamlError(
      facts.recipients.length ? `The assertion is for ${facts.recipients.join(', ')}, not ${urls.acsUrl}` : 'The assertion names no Recipient',
      'invalid_response'
    );
  }
  if (!facts.id) throw new SamlError('The assertion has no ID', 'invalid_response');

  const attributes = attributeValues(profile);
  const nameId = typeof profile.nameID === 'string' ? profile.nameID.trim() : '';
  const nameIdFormat = typeof profile.nameIDFormat === 'string' ? profile.nameIDFormat : NAMEID_UNSPECIFIED;
  let subject: string | null;
  if (cfg.subjectAttribute) {
    subject = firstValue(attributes[cfg.subjectAttribute]);
    if (!subject) throw new SamlError(`The assertion has no ${cfg.subjectAttribute} attribute, which is set as the subject`, 'invalid_response');
  } else {
    if (nameIdFormat === NAMEID_TRANSIENT) {
      throw new SamlError(
        'The NameID is transient, so it changes at every sign-in. Ask the identity provider for a persistent or email NameID, or set a Subject attribute.',
        'invalid_response'
      );
    }
    subject = nameId || null;
    if (!subject) throw new SamlError('The assertion has no NameID', 'invalid_response');
  }
  if (subject.length > 255) throw new SamlError('The subject is longer than 255 characters', 'invalid_response');

  const now = Date.now();
  const ttl = facts.expiresAt
    ? Math.min(MAX_REPLAY_TTL_SECONDS, Math.max(60, Math.ceil((facts.expiresAt - now) / 1000) + cfg.clockSkewSeconds))
    : DEFAULT_REPLAY_TTL_SECONDS;
  if (!(await remember(facts.id, ttl))) throw new SamlError(`Assertion ${facts.id} was already used`, 'invalid_response');

  return { subject, nameId, nameIdFormat, attributes, assertionId: facts.id };
}

/** SP metadata for the IdP (R3). Includes the SP certificate for whichever of signing and decryption is on. */
export function spMetadataXml(provider: { config: SamlProviderConfig; hasPrivateKey: boolean }, urls: SamlUrls): string {
  const cfg = provider.config;
  const cert = cfg.spCertificate && provider.hasPrivateKey ? cfg.spCertificate : null;
  // The key itself is not needed to describe it; node-saml only checks that one is configured.
  const placeholderKey = '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----';
  return generateServiceProviderMetadata({
    issuer: urls.spEntityId,
    callbackUrl: urls.acsUrl,
    identifierFormat: cfg.nameIdFormat || null,
    wantAssertionsSigned: cfg.requireSignedAssertion,
    ...(cert && cfg.signRequests ? { privateKey: placeholderKey, publicCerts: [cert] } : {}),
    ...(cert && cfg.acceptEncryptedAssertions ? { decryptionPvk: placeholderKey, decryptionCert: cert } : {}),
  });
}
