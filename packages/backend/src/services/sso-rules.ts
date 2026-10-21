/**
 * Pure rules for single sign-on (requirements_sso.md): domain list, claim checks, return paths and
 * the provider form. No I/O, so every rule is unit tested on its own.
 */
import type { OidcProviderConfig, SamlProviderConfig } from '../db/entities/SsoProvider.js';
import { checkKeyPair, splitCertificates } from './saml-certs.js';

/** Why a sign-in was refused. Stored in the Decision Ledger and sent to the login page as `sso_error`. */
export type LoginFailureReason =
  | 'bad_password'
  | 'no_account'
  | 'user_disabled'
  | 'domain_not_allowed'
  | 'email_unverified'
  | 'email_missing'
  | 'claim_mismatch'
  | 'not_invited'
  | 'subject_mismatch'
  | 'invalid_response'
  | 'state_invalid'
  | 'provider_error'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'sso_only';

export const LOGIN_FAILURE_REASONS: readonly LoginFailureReason[] = [
  'bad_password',
  'no_account',
  'user_disabled',
  'domain_not_allowed',
  'email_unverified',
  'email_missing',
  'claim_mismatch',
  'not_invited',
  'subject_mismatch',
  'invalid_response',
  'state_invalid',
  'provider_error',
  'provider_unavailable',
  'rate_limited',
  'sso_only',
];

/** Plain words for the Decision Ledger. The login page has its own, shorter messages. */
export const FAILURE_DESCRIPTIONS: Record<LoginFailureReason, string> = {
  bad_password: 'Wrong password',
  no_account: 'No account with this email',
  user_disabled: 'The account is disabled',
  domain_not_allowed: 'The email domain is not an allowed sign-in domain',
  email_unverified: 'The identity provider did not mark the email as verified',
  email_missing: 'The identity provider sent no email address',
  claim_mismatch: 'A required claim was missing or had another value',
  not_invited: 'No DepGate account, and unlisted people may not sign in',
  subject_mismatch: 'Another account at this identity provider is already linked to this email',
  invalid_response: 'The identity provider response failed validation',
  state_invalid: 'The sign-in request expired or was already used',
  provider_error: 'The identity provider returned an error',
  provider_unavailable: 'The identity provider could not be reached',
  rate_limited: 'Too many attempts',
  sso_only: 'The account signs in with single sign-on, not a password',
};

const DOMAIN_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^(?=.{1,253}$)${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})+$`);

/** Lower-cased domain, or null when it is not a domain name. A leading `@` is dropped. */
export function normalizeDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return DOMAIN_PATTERN.test(value) ? value : null;
}

/** The part after the last `@`, lower-cased. */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).trim().toLowerCase();
}

/** R7: exact match only, so `hayageek.com` does not allow `sub.hayageek.com` or `evil-hayageek.com`. */
export function domainAllowed(email: string, allowedDomains: readonly string[]): boolean {
  const domain = emailDomain(email);
  return domain !== '' && allowedDomains.includes(domain);
}

/** OIDC sends `email_verified` as a boolean; a few providers send the string. */
export function claimIsTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function claimText(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'object') return [JSON.stringify(value)];
  return [String(value)];
}

/** The first required claim the token does not satisfy, or null. An array claim satisfies a row when it contains the value. */
export function requiredClaimMismatch(
  claims: Record<string, unknown>,
  required: ReadonlyArray<{ claim: string; value: string }>
): { claim: string; expected: string; actual: string | null } | null {
  for (const row of required) {
    const actual = claimText(claims[row.claim]);
    if (!actual.includes(row.value)) {
      return { claim: row.claim, expected: row.value, actual: actual.length ? actual.join(', ') : null };
    }
  }
  return null;
}

/** The email the provider sent under the configured claim, or null. */
export function claimEmail(claims: Record<string, unknown>, emailClaim: string): string | null {
  const value = claims[emailClaim];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * R20: only a same-origin path survives sign-in. Anything with a scheme, a host (`//evil`),
 * a backslash, or a control character is dropped.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 2048) return null;
  if (path.includes('\\') || [...path].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  if (path === '/login' || path.startsWith('/login?') || path.startsWith('/login/')) return null;
  return path;
}

/** Parameters the admin may not set, because the flow depends on them. */
export const RESERVED_AUTH_PARAMS = new Set([
  'state',
  'nonce',
  'redirect_uri',
  'client_id',
  'response_type',
  'code_challenge',
  'code_challenge_method',
  'scope',
  'client_secret',
  'response_mode',
  'request',
  'request_uri',
]);

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

/** R4: HTTPS, or plain HTTP on localhost (and anywhere when SSO_ALLOW_INSECURE_HTTP is on, for test setups). */
export function idpUrlProblem(raw: string, allowInsecureHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'is not a valid URL';
  }
  if (url.username || url.password) return 'must not contain a user name or password';
  if (url.hash) return 'must not contain a #fragment';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && (allowInsecureHttp || isLocalHost(url.hostname))) return null;
  return 'must use https:// (plain http:// is accepted only for localhost)';
}

const CLAIM_NAME = /^[A-Za-z0-9_:./-]{1,128}$/;
const PARAM_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;
const MAX_ROWS = 20;

export const DEFAULT_OIDC_CONFIG: OidcProviderConfig = {
  issuer: '',
  clientId: '',
  scopes: 'openid email profile',
  emailClaim: 'email',
  requireVerifiedEmail: true,
  requiredClaims: [],
  useDiscovery: true,
  authorizationEndpoint: '',
  tokenEndpoint: '',
  jwksUri: '',
  userinfoEndpoint: '',
  clientAuthMethod: 'client_secret_basic',
  clockSkewSeconds: 60,
  extraAuthParams: [],
};

export const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

export const DEFAULT_SAML_CONFIG: SamlProviderConfig = {
  metadataUrl: '',
  idpEntityId: '',
  ssoUrl: '',
  idpCertificates: [],
  nameIdFormat: NAMEID_EMAIL,
  emailAttribute: '',
  subjectAttribute: '',
  requiredAttributes: [],
  requireSignedAssertion: true,
  signRequests: false,
  acceptEncryptedAssertions: false,
  spCertificate: '',
  clockSkewSeconds: 60,
};

export const DEFAULT_BUTTON_LABEL = 'Sign in with single sign-on';

export interface ProviderInput {
  type?: unknown;
  name?: unknown;
  buttonLabel?: unknown;
  enabled?: unknown;
  oidc?: Record<string, unknown>;
  saml?: Record<string, unknown>;
}

/** What to do with the SAML SP certificate and key on save (R3). */
export type SpKeyChange =
  | { action: 'keep' }
  | { action: 'generate' }
  | { action: 'upload'; certificate: string; privateKey: string }
  | { action: 'remove' };

interface NormalizedCommon {
  name: string;
  buttonLabel: string;
  enabled: boolean;
}

export type NormalizedProvider =
  | (NormalizedCommon & {
      type: 'oidc';
      config: OidcProviderConfig;
      /** Undefined keeps the saved secret. */
      clientSecret: string | undefined;
    })
  | (NormalizedCommon & {
      type: 'saml';
      /** `spCertificate` is the saved one; `spKey` says whether to replace it. */
      config: SamlProviderConfig;
      spKey: SpKeyChange;
    });

export interface NormalizeOptions {
  hasSavedSecret: boolean;
  allowInsecureHttp: boolean;
  /** SAML: the saved SP certificate, and whether its private key can still be read. */
  savedSpCertificate?: string;
  hasSpKey?: boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rows<K extends string, V extends string>(
  value: unknown,
  keyName: K,
  valueName: V
): Array<Record<K | V, string>> | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: Array<Record<K | V, string>> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const key = text(record[keyName]);
    const val = text(record[valueName]);
    if (!key && !val) continue;
    out.push({ [keyName]: key, [valueName]: val } as Record<K | V, string>);
  }
  return out;
}

/** Normalizes the scope list: whitespace-separated, de-duplicated, `openid` always first. */
export function normalizeScopes(raw: string): string[] | null {
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.some((token) => !SCOPE_TOKEN.test(token))) return null;
  return ['openid', ...new Set(tokens.filter((token) => token !== 'openid'))];
}

/**
 * Checks the provider form (R1, R2) without contacting the provider. `hasSavedSecret` lets an edit
 * leave the secret blank. Returns the first problem as a sentence for the form.
 */
export function normalizeProviderInput(
  body: ProviderInput,
  opts: NormalizeOptions
): { ok: true; value: NormalizedProvider } | { ok: false; error: string } {
  const type = body.type === undefined ? 'oidc' : body.type;
  if (type !== 'oidc' && type !== 'saml') return { ok: false, error: 'type must be oidc or saml' };

  const name = text(body.name);
  if (!name || name.length > 128) return { ok: false, error: 'Name must be 1–128 characters' };
  const buttonLabel = text(body.buttonLabel) || DEFAULT_BUTTON_LABEL;
  if (buttonLabel.length > 128) return { ok: false, error: 'Button label must be at most 128 characters' };
  const common: NormalizedCommon = { name, buttonLabel, enabled: body.enabled === true };

  if (type === 'saml') {
    const saml = normalizeSaml(body.saml ?? {}, opts);
    return saml.ok ? { ok: true, value: { ...common, type: 'saml', ...saml.value } } : saml;
  }
  const oidc = normalizeOidc(body.oidc ?? {}, opts);
  return oidc.ok ? { ok: true, value: { ...common, type: 'oidc', ...oidc.value } } : oidc;
}

function normalizeOidc(
  oidc: Record<string, unknown>,
  opts: NormalizeOptions
): { ok: true; value: { config: OidcProviderConfig; clientSecret: string | undefined } } | { ok: false; error: string } {
  const issuer = text(oidc.issuer);
  const issuerProblem = idpUrlProblem(issuer, opts.allowInsecureHttp);
  if (!issuer) return { ok: false, error: 'Enter the issuer URL' };
  if (issuerProblem) return { ok: false, error: `Issuer URL ${issuerProblem}` };

  const clientId = text(oidc.clientId);
  if (!clientId || clientId.length > 255) return { ok: false, error: 'Enter the client ID (at most 255 characters)' };

  const rawSecret = typeof oidc.clientSecret === 'string' ? oidc.clientSecret : '';
  const clientSecret = rawSecret.trim() ? rawSecret.trim() : undefined;
  if (clientSecret && clientSecret.length > 1024) return { ok: false, error: 'Client secret is too long' };
  if (!clientSecret && !opts.hasSavedSecret) return { ok: false, error: 'Enter the client secret' };

  const scopes = normalizeScopes(text(oidc.scopes) || DEFAULT_OIDC_CONFIG.scopes);
  if (!scopes || scopes.length > 30) return { ok: false, error: 'Scopes must be space-separated names' };

  const emailClaim = text(oidc.emailClaim) || 'email';
  if (!CLAIM_NAME.test(emailClaim)) return { ok: false, error: 'Email claim must be a claim name' };

  const requiredClaims = rows(oidc.requiredClaims, 'claim', 'value');
  if (!requiredClaims) return { ok: false, error: 'Required claims must be a list of claim = value rows' };
  if (requiredClaims.length > MAX_ROWS) return { ok: false, error: `At most ${MAX_ROWS} required claims` };
  for (const row of requiredClaims) {
    if (!CLAIM_NAME.test(row.claim)) return { ok: false, error: `Required claim "${row.claim}" is not a claim name` };
    if (!row.value || row.value.length > 256) return { ok: false, error: `Required claim ${row.claim} needs a value (at most 256 characters)` };
  }

  const useDiscovery = oidc.useDiscovery === undefined ? true : oidc.useDiscovery === true;
  const endpoints = {
    authorizationEndpoint: text(oidc.authorizationEndpoint),
    tokenEndpoint: text(oidc.tokenEndpoint),
    jwksUri: text(oidc.jwksUri),
    userinfoEndpoint: text(oidc.userinfoEndpoint),
  };
  if (!useDiscovery) {
    const labels: Record<keyof typeof endpoints, string> = {
      authorizationEndpoint: 'Authorization endpoint',
      tokenEndpoint: 'Token endpoint',
      jwksUri: 'JWKS URI',
      userinfoEndpoint: 'Userinfo endpoint',
    };
    for (const key of Object.keys(endpoints) as Array<keyof typeof endpoints>) {
      const value = endpoints[key];
      if (!value) {
        if (key === 'userinfoEndpoint') continue;
        return { ok: false, error: `Enter the ${labels[key]}, or turn discovery on` };
      }
      const problem = idpUrlProblem(value, opts.allowInsecureHttp);
      if (problem) return { ok: false, error: `${labels[key]} ${problem}` };
    }
  }

  const clientAuthMethod = oidc.clientAuthMethod === undefined ? 'client_secret_basic' : oidc.clientAuthMethod;
  if (clientAuthMethod !== 'client_secret_basic' && clientAuthMethod !== 'client_secret_post') {
    return { ok: false, error: 'Client authentication must be client_secret_basic or client_secret_post' };
  }

  const skew = oidc.clockSkewSeconds === undefined ? 60 : Number(oidc.clockSkewSeconds);
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) return { ok: false, error: 'Clock skew must be 0–300 seconds' };

  const extraAuthParams = rows(oidc.extraAuthParams, 'key', 'value');
  if (!extraAuthParams) return { ok: false, error: 'Extra parameters must be a list of key = value rows' };
  if (extraAuthParams.length > MAX_ROWS) return { ok: false, error: `At most ${MAX_ROWS} extra parameters` };
  for (const row of extraAuthParams) {
    if (!PARAM_NAME.test(row.key)) return { ok: false, error: `Extra parameter "${row.key}" is not a parameter name` };
    if (RESERVED_AUTH_PARAMS.has(row.key.toLowerCase())) return { ok: false, error: `Extra parameter ${row.key} cannot be overridden` };
    if (row.value.length > 512) return { ok: false, error: `Extra parameter ${row.key} is too long` };
  }

  return {
    ok: true,
    value: {
      clientSecret,
      config: {
        issuer,
        clientId,
        scopes: scopes.join(' '),
        emailClaim,
        requireVerifiedEmail: oidc.requireVerifiedEmail === undefined ? true : oidc.requireVerifiedEmail === true,
        requiredClaims,
        useDiscovery,
        ...(useDiscovery
          ? { authorizationEndpoint: '', tokenEndpoint: '', jwksUri: '', userinfoEndpoint: '' }
          : endpoints),
        clientAuthMethod,
        clockSkewSeconds: skew,
        extraAuthParams,
      },
    },
  };
}

/** SAML names: URIs, OIDs or friendly names. Anything printable without control characters. */
const ATTRIBUTE_NAME = {
  test: (value: string) => value.length >= 1 && value.length <= 256 && ![...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f),
};
const NAMEID_FORMAT = /^urn:[A-Za-z0-9:._-]{1,250}$/;
const MAX_IDP_CERTIFICATES = 2;

/** IdP certificates: a list of PEM strings, or one string holding several. */
function certificateList(value: unknown): { ok: true; certs: string[] } | { ok: false; error: string } {
  const items = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  const certs: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') return { ok: false, error: 'IdP signing certificates must be PEM text' };
    try {
      for (const pem of splitCertificates(item)) if (!certs.includes(pem)) certs.push(pem);
    } catch (err) {
      return { ok: false, error: `IdP signing certificate: ${(err as Error).message}` };
    }
  }
  if (certs.length > MAX_IDP_CERTIFICATES) {
    return { ok: false, error: `At most ${MAX_IDP_CERTIFICATES} IdP signing certificates (the current one and the next)` };
  }
  return { ok: true, certs };
}

function spKeyChange(value: unknown): { ok: true; change: SpKeyChange } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, change: { action: 'keep' } };
  if (typeof value !== 'object') return { ok: false, error: 'spKey must be an object' };
  const record = value as Record<string, unknown>;
  switch (record.action) {
    case undefined:
    case 'keep':
      return { ok: true, change: { action: 'keep' } };
    case 'generate':
    case 'remove':
      return { ok: true, change: { action: record.action } };
    case 'upload': {
      const certs = certificateList(record.certificate);
      if (!certs.ok) return { ok: false, error: certs.error.replace('IdP signing certificate', 'SP certificate') };
      if (certs.certs.length !== 1) return { ok: false, error: 'Upload exactly one SP certificate' };
      const rawKey = typeof record.privateKey === 'string' ? record.privateKey.trim() : '';
      if (!rawKey) return { ok: false, error: 'Upload the SP private key with the certificate' };
      try {
        return { ok: true, change: { action: 'upload', certificate: certs.certs[0], privateKey: checkKeyPair(certs.certs[0], rawKey) } };
      } catch (err) {
        return { ok: false, error: `SP certificate: ${(err as Error).message}` };
      }
    }
    default:
      return { ok: false, error: 'spKey.action must be generate, upload, remove or keep' };
  }
}

/**
 * Checks the SAML form (R3) without contacting the IdP. With a metadata URL, the entity ID, SSO URL
 * and certificates may be left empty: the save reads them from the metadata.
 */
function normalizeSaml(
  saml: Record<string, unknown>,
  opts: NormalizeOptions
): { ok: true; value: { config: SamlProviderConfig; spKey: SpKeyChange } } | { ok: false; error: string } {
  const metadataUrl = text(saml.metadataUrl);
  if (metadataUrl) {
    const problem = idpUrlProblem(metadataUrl, opts.allowInsecureHttp);
    if (problem) return { ok: false, error: `Metadata URL ${problem}` };
  }

  const idpEntityId = text(saml.idpEntityId);
  if (idpEntityId.length > 1024) return { ok: false, error: 'IdP entity ID is too long' };
  const ssoUrl = text(saml.ssoUrl);
  if (ssoUrl) {
    const problem = idpUrlProblem(ssoUrl, opts.allowInsecureHttp);
    if (problem) return { ok: false, error: `IdP SSO URL ${problem}` };
  }
  const certs = certificateList(saml.idpCertificates);
  if (!certs.ok) return certs;
  if (!metadataUrl) {
    if (!idpEntityId) return { ok: false, error: 'Enter the IdP entity ID, or read it from the metadata' };
    if (!ssoUrl) return { ok: false, error: 'Enter the IdP SSO URL, or read it from the metadata' };
    if (certs.certs.length === 0) return { ok: false, error: 'Add the IdP signing certificate, or read it from the metadata' };
  }

  const nameIdFormat = text(saml.nameIdFormat) || DEFAULT_SAML_CONFIG.nameIdFormat;
  if (!NAMEID_FORMAT.test(nameIdFormat)) return { ok: false, error: 'NameID format must be a urn:oasis:names:tc:SAML URN' };
  const emailAttribute = text(saml.emailAttribute);
  if (emailAttribute && !ATTRIBUTE_NAME.test(emailAttribute)) return { ok: false, error: 'Email attribute must be an attribute name' };
  const subjectAttribute = text(saml.subjectAttribute);
  if (subjectAttribute && !ATTRIBUTE_NAME.test(subjectAttribute)) return { ok: false, error: 'Subject attribute must be an attribute name' };

  const requiredAttributes = rows(saml.requiredAttributes, 'attribute', 'value');
  if (!requiredAttributes) return { ok: false, error: 'Required attributes must be a list of attribute = value rows' };
  if (requiredAttributes.length > MAX_ROWS) return { ok: false, error: `At most ${MAX_ROWS} required attributes` };
  for (const row of requiredAttributes) {
    if (!ATTRIBUTE_NAME.test(row.attribute)) return { ok: false, error: `Required attribute "${row.attribute}" is not an attribute name` };
    if (!row.value || row.value.length > 256) return { ok: false, error: `Required attribute ${row.attribute} needs a value (at most 256 characters)` };
  }

  const skew = saml.clockSkewSeconds === undefined ? 60 : Number(saml.clockSkewSeconds);
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) return { ok: false, error: 'Clock skew must be 0–300 seconds' };

  const signRequests = saml.signRequests === true;
  const acceptEncryptedAssertions = saml.acceptEncryptedAssertions === true;
  const spKey = spKeyChange(saml.spKey);
  if (!spKey.ok) return spKey;
  const willHaveKey =
    spKey.change.action === 'generate' ||
    spKey.change.action === 'upload' ||
    (spKey.change.action === 'keep' && Boolean(opts.savedSpCertificate) && opts.hasSpKey === true);
  if ((signRequests || acceptEncryptedAssertions) && !willHaveKey) {
    const needs = signRequests && acceptEncryptedAssertions ? 'Signing requests and decrypting assertions need' : signRequests ? 'Signing requests needs' : 'Decrypting assertions needs';
    return { ok: false, error: `${needs} an SP certificate. Generate or upload one.` };
  }

  return {
    ok: true,
    value: {
      spKey: spKey.change,
      config: {
        metadataUrl,
        idpEntityId,
        ssoUrl,
        idpCertificates: certs.certs,
        nameIdFormat,
        emailAttribute,
        subjectAttribute,
        requiredAttributes,
        requireSignedAssertion: saml.requireSignedAssertion === undefined ? true : saml.requireSignedAssertion === true,
        signRequests,
        acceptEncryptedAssertions,
        spCertificate: spKey.change.action === 'remove' ? '' : opts.savedSpCertificate ?? '',
        clockSkewSeconds: skew,
      },
    },
  };
}

/** Normalizes the allowed-domain list. Returns the bad entry when one is not a domain name. */
export function normalizeDomainList(value: unknown): { ok: true; domains: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'allowedDomains must be a list' };
  const domains: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return { ok: false, error: 'allowedDomains must be a list of domain names' };
    if (!item.trim()) continue;
    const domain = normalizeDomain(item);
    if (!domain) return { ok: false, error: `"${item.trim()}" is not a domain name` };
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > 100) return { ok: false, error: 'At most 100 domains' };
  return { ok: true, domains };
}

/** Only asymmetric signatures are trusted for ID tokens (§8.1). `none` and HMAC are refused. */
export const ACCEPTED_ID_TOKEN_ALGS = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA']);

/** The `alg` in a compact JWS header, or null when it cannot be read. */
export function jwsAlgorithm(token: string): string | null {
  const header = token.split('.')[0];
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: unknown };
    return typeof parsed.alg === 'string' ? parsed.alg : null;
  } catch {
    return null;
  }
}

/** True when a JWKS holds at least one key that can verify an accepted ID token signature. */
export function jwksHasSigningKey(jwks: unknown): boolean {
  if (!jwks || typeof jwks !== 'object') return false;
  const keys = (jwks as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return false;
  return keys.some((key) => {
    if (!key || typeof key !== 'object') return false;
    const record = key as { kty?: unknown; use?: unknown; alg?: unknown };
    if (record.use === 'enc') return false;
    if (record.kty !== 'RSA' && record.kty !== 'EC' && record.kty !== 'OKP') return false;
    return record.alg === undefined || (typeof record.alg === 'string' && ACCEPTED_ID_TOKEN_ALGS.has(record.alg));
  });
}

export type ClaimCheck =
  | { ok: true; email: string }
  | { ok: false; reason: LoginFailureReason; detail: string; email: string | null };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ClaimRules = Pick<OidcProviderConfig, 'emailClaim' | 'requireVerifiedEmail' | 'requiredClaims'>;

/**
 * The checks every sign-in passes before DepGate looks at its users, in order: an email, a verified
 * email (when required), the required claims, then the allowed domains (R8). SAML passes its
 * attributes through `samlClaims` and reads as "attribute" in the messages.
 */
export function evaluateClaims(
  claims: Record<string, unknown>,
  cfg: ClaimRules,
  allowedDomains: readonly string[],
  noun: 'claim' | 'attribute' = 'claim'
): ClaimCheck {
  const Noun = noun === 'claim' ? 'Claim' : 'Attribute';
  const raw = claimEmail(claims, cfg.emailClaim);
  const email = raw ? raw.toLowerCase() : null;
  if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) {
    return {
      ok: false,
      reason: 'email_missing',
      detail: raw ? `${Noun} ${cfg.emailClaim} is not an email address` : `No ${cfg.emailClaim} ${noun}`,
      email: null,
    };
  }
  if (cfg.requireVerifiedEmail && !claimIsTrue(claims.email_verified)) {
    return {
      ok: false,
      reason: 'email_unverified',
      detail: claims.email_verified === undefined ? 'No email_verified claim' : `email_verified is ${String(claims.email_verified)}`,
      email,
    };
  }
  const mismatch = requiredClaimMismatch(claims, cfg.requiredClaims);
  if (mismatch) {
    return {
      ok: false,
      reason: 'claim_mismatch',
      detail: `${Noun} ${mismatch.claim} must be "${mismatch.expected}" but is ${mismatch.actual === null ? 'missing' : `"${mismatch.actual}"`}`,
      email,
    };
  }
  if (!domainAllowed(email, allowedDomains)) {
    return {
      ok: false,
      reason: 'domain_not_allowed',
      detail: allowedDomains.length
        ? `${emailDomain(email)} is not one of: ${allowedDomains.join(', ')}`
        : 'No allowed sign-in domains are set',
      email,
    };
  }
  return { ok: true, email };
}

/** The NameID under this key in `samlClaims`; real attribute names are URIs, OIDs or lower-case words. */
export const SAML_NAMEID_KEY = 'NameID';

/**
 * A SAML assertion as claims for `evaluateClaims` (R3): the attributes, plus the NameID and its
 * format. The email is the configured attribute; without one, the NameID when its format is
 * emailAddress, otherwise the attribute `email`. SAML has no verified-email flag.
 */
export function samlClaims(
  identity: { nameId: string; nameIdFormat: string; attributes: Record<string, string | string[]> },
  cfg: Pick<SamlProviderConfig, 'emailAttribute' | 'requiredAttributes'>
): { claims: Record<string, unknown>; rules: ClaimRules } {
  const claims: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(identity.attributes)) {
    claims[name] = Array.isArray(value) && value.length === 1 ? value[0] : value;
  }
  claims[SAML_NAMEID_KEY] = identity.nameId;
  claims.NameIDFormat = identity.nameIdFormat;
  const emailClaim = cfg.emailAttribute || (identity.nameIdFormat === NAMEID_EMAIL ? SAML_NAMEID_KEY : 'email');
  // A multi-valued email attribute: the first value is the address.
  if (Array.isArray(claims[emailClaim])) claims[emailClaim] = (claims[emailClaim] as string[])[0];
  return {
    claims,
    rules: {
      emailClaim,
      requireVerifiedEmail: false,
      requiredClaims: cfg.requiredAttributes.map((row) => ({ claim: row.attribute, value: row.value })),
    },
  };
}
