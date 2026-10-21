/**
 * OpenID Connect client (requirements_sso.md §8.1). Authorization Code flow with PKCE through
 * openid-client, which checks the ID token signature, issuer, audience, expiry and nonce.
 * Nothing here is vendor-specific.
 */
import type { OidcProviderConfig } from '../db/entities/SsoProvider.js';
import { config as appConfig } from '../config.js';
import { ACCEPTED_ID_TOKEN_ALGS, idpUrlProblem, jwksHasSigningKey, jwsAlgorithm, RESERVED_AUTH_PARAMS } from './sso-rules.js';

type OidcLib = typeof import('openid-client', { with: { 'resolution-mode': 'import' } });
type OidcConfiguration = import('openid-client', { with: { 'resolution-mode': 'import' } }).Configuration;

let lib: Promise<OidcLib> | null = null;

/** openid-client ships as an ES module only; the backend is CommonJS, so it is loaded on first use. */
function oidcLib(): Promise<OidcLib> {
  lib ??= import('openid-client');
  return lib;
}

/** Discovery documents, JWKS and token responses are small. Anything larger is refused. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_SECONDS = 10;

export class OidcError extends Error {
  constructor(
    message: string,
    /** `provider_unavailable` when the provider could not be reached, `invalid_response` when it answered wrongly. */
    readonly reason: 'provider_unavailable' | 'invalid_response' | 'provider_error'
  ) {
    super(message);
  }
}

/** fetch with a size cap. openid-client already asks for `redirect: manual`, so redirects are never followed. */
async function cappedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, redirect: 'manual' });
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new OidcError(`Response from ${new URL(url).host} is larger than 1 MB`, 'invalid_response');
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new OidcError(`Response from ${new URL(url).host} is larger than 1 MB`, 'invalid_response');
  return new Response(res.status === 204 || res.status === 304 ? null : body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function getJson(url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await cappedFetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError(`Could not reach the ${what} at ${url}: ${err instanceof Error ? err.message : String(err)}`, 'provider_unavailable');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new OidcError(`The ${what} at ${url} redirects (HTTP ${res.status}); enter the final URL`, 'invalid_response');
  }
  if (!res.ok) throw new OidcError(`The ${what} at ${url} answered HTTP ${res.status}`, 'invalid_response');
  try {
    return await res.json();
  } catch {
    throw new OidcError(`The ${what} at ${url} is not JSON`, 'invalid_response');
  }
}

export function discoveryUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

export interface DiscoveredEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string;
  signingAlgs: string[];
  tokenEndpointAuthMethods: string[];
  scopesSupported: string[];
  claimsSupported: string[];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Reads `<issuer>/.well-known/openid-configuration` for the Discover button and the check on save (R2, R4).
 * The document's `issuer` must equal the one entered, character for character.
 */
export async function discoverOidc(issuer: string): Promise<DiscoveredEndpoints> {
  const problem = idpUrlProblem(issuer, appConfig.auth.ssoAllowInsecureHttp);
  if (problem) throw new OidcError(`Issuer URL ${problem}`, 'invalid_response');
  const doc = await getJson(discoveryUrl(issuer), 'discovery document');
  if (!doc || typeof doc !== 'object') throw new OidcError('The discovery document is not a JSON object', 'invalid_response');
  const record = doc as Record<string, unknown>;
  const published = typeof record.issuer === 'string' ? record.issuer : '';
  // A trailing slash is the usual slip (Auth0 publishes one, Okta does not). ID tokens carry the issuer
  // exactly as published, so that spelling is the one kept; anything else must match exactly.
  if (published !== issuer && published.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) {
    throw new OidcError(
      `The discovery document names issuer "${published || String(record.issuer)}", not "${issuer}". Enter the issuer exactly as the provider publishes it.`,
      'invalid_response'
    );
  }
  const result: DiscoveredEndpoints = {
    issuer: published,
    authorizationEndpoint: typeof record.authorization_endpoint === 'string' ? record.authorization_endpoint : '',
    tokenEndpoint: typeof record.token_endpoint === 'string' ? record.token_endpoint : '',
    jwksUri: typeof record.jwks_uri === 'string' ? record.jwks_uri : '',
    userinfoEndpoint: typeof record.userinfo_endpoint === 'string' ? record.userinfo_endpoint : '',
    signingAlgs: strings(record.id_token_signing_alg_values_supported),
    tokenEndpointAuthMethods: strings(record.token_endpoint_auth_methods_supported),
    scopesSupported: strings(record.scopes_supported),
    claimsSupported: strings(record.claims_supported),
  };
  if (!result.authorizationEndpoint || !result.tokenEndpoint || !result.jwksUri) {
    throw new OidcError('The discovery document has no authorization endpoint, token endpoint or JWKS URI', 'invalid_response');
  }
  if (!strings(record.response_types_supported).includes('code')) {
    throw new OidcError('The provider does not support the authorization code flow (response type "code")', 'invalid_response');
  }
  return result;
}

/**
 * R4: the provider answers and publishes a key DepGate can verify ID tokens with. Returns the
 * endpoints that will be used, so the admin sees what discovery found.
 */
export async function checkOidcProvider(cfg: OidcProviderConfig): Promise<DiscoveredEndpoints> {
  const endpoints: DiscoveredEndpoints = cfg.useDiscovery
    ? await discoverOidc(cfg.issuer)
    : {
        issuer: cfg.issuer,
        authorizationEndpoint: cfg.authorizationEndpoint,
        tokenEndpoint: cfg.tokenEndpoint,
        jwksUri: cfg.jwksUri,
        userinfoEndpoint: cfg.userinfoEndpoint,
        signingAlgs: [],
        tokenEndpointAuthMethods: [],
        scopesSupported: [],
        claimsSupported: [],
      };
  for (const url of [endpoints.authorizationEndpoint, endpoints.tokenEndpoint, endpoints.jwksUri]) {
    const problem = idpUrlProblem(url, appConfig.auth.ssoAllowInsecureHttp);
    if (problem) throw new OidcError(`${url} ${problem}`, 'invalid_response');
  }
  if (endpoints.signingAlgs.length && !endpoints.signingAlgs.some((alg) => ACCEPTED_ID_TOKEN_ALGS.has(alg))) {
    throw new OidcError(
      `The provider signs ID tokens only with ${endpoints.signingAlgs.join(', ')}. DepGate needs RS256, PS256, ES256 or another asymmetric algorithm.`,
      'invalid_response'
    );
  }
  const jwks = await getJson(endpoints.jwksUri, 'JWKS');
  if (!jwksHasSigningKey(jwks)) {
    throw new OidcError('The JWKS has no RSA or EC signing key, so ID tokens could not be verified', 'invalid_response');
  }
  return endpoints;
}

type CacheEntry = { configuration: OidcConfiguration; at: number };
const configurations = new Map<string, CacheEntry>();
const CONFIGURATION_TTL_MS = 10 * 60_000;

/** Drops cached provider metadata, e.g. after the provider is edited or deleted. */
export function forgetOidcProvider(providerId: string): void {
  for (const key of configurations.keys()) {
    if (key.startsWith(`${providerId}:`)) configurations.delete(key);
  }
}

export interface ProviderHandle {
  id: string;
  updatedAt: Date;
  config: OidcProviderConfig;
  clientSecret: string;
}

/** Provider metadata and client settings, cached per provider version for 10 minutes. */
async function configurationFor(provider: ProviderHandle): Promise<OidcConfiguration> {
  const key = `${provider.id}:${provider.updatedAt.getTime()}`;
  const hit = configurations.get(key);
  if (hit && Date.now() - hit.at < CONFIGURATION_TTL_MS) return hit.configuration;

  const client = await oidcLib();
  const cfg = provider.config;
  const auth =
    cfg.clientAuthMethod === 'client_secret_post'
      ? client.ClientSecretPost(provider.clientSecret)
      : client.ClientSecretBasic(provider.clientSecret);
  const metadata = { [client.clockTolerance]: cfg.clockSkewSeconds };
  const insecure = new URL(cfg.issuer).protocol === 'http:';
  for (const url of [cfg.issuer, cfg.authorizationEndpoint, cfg.tokenEndpoint, cfg.jwksUri, cfg.userinfoEndpoint]) {
    if (!url) continue;
    const problem = idpUrlProblem(url, appConfig.auth.ssoAllowInsecureHttp);
    if (problem) throw new OidcError(`${url} ${problem}`, 'invalid_response');
  }

  let configuration: OidcConfiguration;
  try {
    if (cfg.useDiscovery) {
      configuration = await client.discovery(new URL(cfg.issuer), cfg.clientId, metadata, auth, {
        timeout: FETCH_TIMEOUT_SECONDS,
        // The token endpoint is reached over TLS, which OIDC lets a client trust instead of the signature.
        // DepGate checks the ID token signature against the JWKS anyway (§8.1).
        execute: insecure ? [client.allowInsecureRequests, client.enableNonRepudiationChecks] : [client.enableNonRepudiationChecks],
        [client.customFetch]: cappedFetch,
      });
    } else {
      configuration = new client.Configuration(
        {
          issuer: cfg.issuer,
          authorization_endpoint: cfg.authorizationEndpoint,
          token_endpoint: cfg.tokenEndpoint,
          jwks_uri: cfg.jwksUri,
          ...(cfg.userinfoEndpoint ? { userinfo_endpoint: cfg.userinfoEndpoint } : {}),
        },
        cfg.clientId,
        metadata,
        auth
      );
      configuration.timeout = FETCH_TIMEOUT_SECONDS;
      configuration[client.customFetch] = cappedFetch;
      if ([cfg.authorizationEndpoint, cfg.tokenEndpoint, cfg.jwksUri].some((url) => url.startsWith('http:'))) {
        client.allowInsecureRequests(configuration);
      }
      client.enableNonRepudiationChecks(configuration);
    }
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError(`Could not load the provider's discovery document: ${describe(err)}`, 'provider_unavailable');
  }
  configurations.set(key, { configuration, at: Date.now() });
  return configuration;
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const extra = cause instanceof Error ? ` (${cause.message})` : '';
  return `${err.message}${extra}`;
}

/** What the callback needs to finish the flow. Stored server-side under `state`, never sent to the browser. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Builds the authorization request: PKCE S256, a random state and nonce, and the admin's extra parameters. */
export async function beginOidcLogin(provider: ProviderHandle, redirectUri: string): Promise<{ url: string; pending: PendingLogin }> {
  const client = await oidcLib();
  const configuration = await configurationFor(provider);
  const codeVerifier = client.randomPKCECodeVerifier();
  const pending: PendingLogin = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
    redirectUri,
  };
  const params: Record<string, string> = {};
  for (const row of provider.config.extraAuthParams) {
    if (!RESERVED_AUTH_PARAMS.has(row.key.toLowerCase())) params[row.key] = row.value;
  }
  Object.assign(params, {
    redirect_uri: redirectUri,
    scope: provider.config.scopes,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { url: client.buildAuthorizationUrl(configuration, params).href, pending };
}

export interface OidcIdentity {
  subject: string;
  /** ID token claims, with userinfo filling in an email the ID token left out. */
  claims: Record<string, unknown>;
}

/**
 * Exchanges the code and validates the ID token. `callbackQuery` is the raw query string the
 * provider sent. Throws OidcError with the reason the Decision Ledger records.
 */
export async function completeOidcLogin(provider: ProviderHandle, pending: PendingLogin, callbackQuery: string): Promise<OidcIdentity> {
  const query = new URLSearchParams(callbackQuery);
  const providerError = query.get('error');
  if (providerError) {
    const description = query.get('error_description');
    throw new OidcError(`The provider returned ${providerError}${description ? `: ${description}` : ''}`, 'provider_error');
  }

  const client = await oidcLib();
  const configuration = await configurationFor(provider);
  const currentUrl = new URL(pending.redirectUri);
  currentUrl.search = query.toString();

  let tokens: Awaited<ReturnType<OidcLib['authorizationCodeGrant']>>;
  try {
    tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
  } catch (err) {
    const unreachable = err instanceof TypeError || (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError';
    throw new OidcError(`Code exchange or ID token validation failed: ${describe(err)}`, unreachable ? 'provider_unavailable' : 'invalid_response');
  }

  const idToken = tokens.id_token;
  const alg = idToken ? jwsAlgorithm(idToken) : null;
  if (!alg || !ACCEPTED_ID_TOKEN_ALGS.has(alg)) {
    throw new OidcError(`ID token signed with ${alg ?? 'no algorithm'}, which DepGate does not accept`, 'invalid_response');
  }
  const idClaims = tokens.claims();
  if (!idClaims || typeof idClaims.sub !== 'string' || !idClaims.sub) {
    throw new OidcError('The ID token has no subject', 'invalid_response');
  }
  const claims: Record<string, unknown> = { ...idClaims };

  // Some providers put the email only in userinfo. ID token claims win when both have one.
  const emailClaim = provider.config.emailClaim;
  const needsUserinfo =
    claims[emailClaim] === undefined || (provider.config.requireVerifiedEmail && claims.email_verified === undefined);
  const hasUserinfo = Boolean(configuration.serverMetadata().userinfo_endpoint);
  if (needsUserinfo && hasUserinfo && tokens.access_token) {
    try {
      const info = await client.fetchUserInfo(configuration, tokens.access_token, idClaims.sub);
      for (const [key, value] of Object.entries(info)) {
        if (claims[key] === undefined) claims[key] = value;
      }
    } catch {
      // Userinfo is a fallback. Without it, the missing claim is reported as such.
    }
  }
  return { subject: idClaims.sub, claims };
}
