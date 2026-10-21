/**
 * The OIDC client against a mock provider: the happy path, and every forgery the ID token
 * validation must refuse (requirements_sso.md §8.1). No database or Redis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OidcProviderConfig } from '../db/entities/SsoProvider.js';
import { MockOidcProvider } from '../test-support/mock-oidc.js';
import { DEFAULT_OIDC_CONFIG } from './sso-rules.js';
import {
  beginOidcLogin,
  checkOidcProvider,
  completeOidcLogin,
  discoverOidc,
  forgetOidcProvider,
  OidcError,
  type ProviderHandle,
} from './sso-oidc.js';

const REDIRECT = 'https://depgate.example.com/api/auth/sso/p1/callback';

describe('OIDC client', () => {
  const idp = new MockOidcProvider();
  let n = 0;

  beforeAll(async () => {
    await idp.start();
  });

  afterAll(async () => {
    await idp.stop();
  });

  beforeEach(() => {
    idp.account = { sub: 'subject-1', email: 'ravi@hayageek.com', email_verified: true };
    idp.tamper = {};
    idp.discoveryOverrides = {};
    idp.publishNoKeys = false;
  });

  function provider(overrides: Partial<OidcProviderConfig> = {}): ProviderHandle {
    n += 1;
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    forgetOidcProvider(id);
    return {
      id,
      updatedAt: new Date(),
      clientSecret: idp.clientSecret,
      config: { ...DEFAULT_OIDC_CONFIG, issuer: idp.issuer, clientId: idp.clientId, ...overrides },
    };
  }

  async function signIn(handle: ProviderHandle) {
    const { url, pending } = await beginOidcLogin(handle, REDIRECT);
    const back = await idp.authorize(url);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    return completeOidcLogin(handle, pending, back.search.slice(1));
  }

  async function refused(handle: ProviderHandle): Promise<OidcError> {
    const err = await signIn(handle).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OidcError);
    return err as OidcError;
  }

  it('discovers the endpoints and checks the issuer matches exactly', async () => {
    const found = await discoverOidc(idp.issuer);
    expect(found).toMatchObject({
      issuer: idp.issuer,
      authorizationEndpoint: `${idp.issuer}/authorize`,
      tokenEndpoint: `${idp.issuer}/token`,
      jwksUri: `${idp.issuer}/jwks`,
      signingAlgs: ['RS256'],
    });
    // A trailing slash is forgiven, and the issuer comes back exactly as published.
    await expect(discoverOidc(`${idp.issuer}/`)).resolves.toMatchObject({ issuer: idp.issuer });
    await expect(discoverOidc(`${idp.issuer}/realm`)).rejects.toThrow();
    idp.discoveryOverrides = { issuer: 'https://someone-else.example.com' };
    await expect(discoverOidc(idp.issuer)).rejects.toThrow(/names issuer/);
    idp.discoveryOverrides = { issuer: `${idp.issuer}/` };
    await expect(discoverOidc(idp.issuer)).resolves.toMatchObject({ issuer: `${idp.issuer}/` });
    idp.discoveryOverrides = {};
  });

  it('refuses a provider without the code flow, without an accepted algorithm, or without signing keys', async () => {
    idp.discoveryOverrides = { response_types_supported: ['id_token'] };
    await expect(discoverOidc(idp.issuer)).rejects.toThrow(/authorization code flow/);
    idp.discoveryOverrides = { id_token_signing_alg_values_supported: ['HS256'] };
    await expect(checkOidcProvider(provider().config)).rejects.toThrow(/HS256/);
    idp.discoveryOverrides = {};
    idp.publishNoKeys = true;
    await expect(checkOidcProvider(provider().config)).rejects.toThrow(/no RSA or EC signing key/);
    idp.publishNoKeys = false;
    await expect(checkOidcProvider(provider().config)).resolves.toMatchObject({ jwksUri: `${idp.issuer}/jwks` });
  });

  it('says the provider is unreachable when nothing answers', async () => {
    const err = await checkOidcProvider({ ...provider().config, issuer: 'http://127.0.0.1:9' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcError);
    expect((err as OidcError).reason).toBe('provider_unavailable');
  });

  it('signs in: PKCE S256, state and nonce, and the ID token claims come back', async () => {
    const handle = provider({ extraAuthParams: [{ key: 'prompt', value: 'login' }] });
    const { url } = await beginOidcLogin(handle, REDIRECT);
    const params = new URL(url).searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(params.get('scope')).toBe('openid email profile');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('prompt')).toBe('login');

    const identity = await signIn(handle);
    expect(identity.subject).toBe('subject-1');
    expect(identity.claims).toMatchObject({ email: 'ravi@hayageek.com', email_verified: true, iss: idp.issuer, aud: idp.clientId });
    expect(idp.lastTokenRequest?.authorization).toMatch(/^Basic /);
    expect(idp.lastTokenRequest?.body.get('code_verifier')).toBeTruthy();
  });

  it('sends the client secret in the body with client_secret_post', async () => {
    await signIn(provider({ clientAuthMethod: 'client_secret_post' }));
    expect(idp.lastTokenRequest?.authorization).toBeNull();
    expect(idp.lastTokenRequest?.body.get('client_secret')).toBe(idp.clientSecret);
  });

  it('works without discovery when the endpoints are entered by hand', async () => {
    const handle = provider({
      useDiscovery: false,
      authorizationEndpoint: `${idp.issuer}/authorize`,
      tokenEndpoint: `${idp.issuer}/token`,
      jwksUri: `${idp.issuer}/jwks`,
    });
    const before = idp.requests.filter((r) => r.includes('openid-configuration')).length;
    expect((await signIn(handle)).subject).toBe('subject-1');
    expect(idp.requests.filter((r) => r.includes('openid-configuration')).length).toBe(before);
  });

  it('fills in an email that only userinfo returns', async () => {
    idp.account = { sub: 'subject-2', userinfo: { email: 'dev@hayageek.com', email_verified: true } };
    const identity = await signIn(provider());
    expect(identity.claims).toMatchObject({ email: 'dev@hayageek.com', email_verified: true });
  });

  it('refuses a wrong client secret at the token endpoint', async () => {
    const handle = { ...provider(), clientSecret: 'wrong' };
    expect((await refused(handle)).reason).toBe('invalid_response');
  });

  it.each([
    ['an ID token for another client', { aud: 'someone-else' }],
    ['an ID token from another issuer', { iss: 'https://evil.example.com' }],
    ['an expired ID token', { expiresIn: -600 }],
    ['an unsigned ID token (alg none)', { alg: 'none' as const }],
    ['an HMAC-signed ID token', { alg: 'HS256' as const }],
    ['an ID token signed with another key', { alg: 'other-key' as const }],
    ['a replayed nonce', { nonce: 'not-the-nonce' }],
    ['a response without an ID token', { omitIdToken: true }],
  ])('refuses %s', async (_label, tamper) => {
    idp.tamper = tamper;
    expect((await refused(provider())).reason).toBe('invalid_response');
  });

  it('refuses a callback whose state does not match', async () => {
    const handle = provider();
    const { url, pending } = await beginOidcLogin(handle, REDIRECT);
    idp.tamper = { state: 'forged-state' };
    const back = await idp.authorize(url);
    await expect(completeOidcLogin(handle, pending, back.search.slice(1))).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('reports a provider error, such as a cancelled sign-in', async () => {
    idp.tamper = { error: 'access_denied' };
    const err = await refused(provider());
    expect(err.reason).toBe('provider_error');
    expect(err.message).toContain('access_denied');
  });

  it('cannot redeem the same code twice', async () => {
    const handle = provider();
    const { url, pending } = await beginOidcLogin(handle, REDIRECT);
    const back = await idp.authorize(url);
    await completeOidcLogin(handle, pending, back.search.slice(1));
    await expect(completeOidcLogin(handle, pending, back.search.slice(1))).rejects.toMatchObject({ reason: 'invalid_response' });
  });
});
