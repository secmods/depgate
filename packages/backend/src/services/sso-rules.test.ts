import { describe, expect, it } from 'vitest';
import {
  claimIsTrue,
  domainAllowed,
  emailDomain,
  evaluateClaims,
  idpUrlProblem,
  jwksHasSigningKey,
  jwsAlgorithm,
  normalizeDomain,
  normalizeDomainList,
  normalizeProviderInput,
  normalizeScopes,
  requiredClaimMismatch,
  safeReturnTo,
  samlClaims,
  SAML_NAMEID_KEY,
  DEFAULT_SAML_CONFIG,
} from './sso-rules.js';
import { generateSpCertificate } from './saml-certs.js';

const oidc = {
  issuer: 'https://idp.example.com/realms/acme',
  clientId: 'depgate',
  clientSecret: 's3cret',
};

describe('allowed sign-in domains (R7, R8)', () => {
  it('normalizes domain entries and refuses things that are not domains', () => {
    expect(normalizeDomain('  HayaGeek.com ')).toBe('hayageek.com');
    expect(normalizeDomain('@hayageek.com')).toBe('hayageek.com');
    expect(normalizeDomain('hayageek.com.')).toBe('hayageek.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('*.hayageek.com')).toBeNull();
    expect(normalizeDomain('hay ageek.com')).toBeNull();
    expect(normalizeDomain('-bad.com')).toBeNull();
    expect(normalizeDomain('https://hayageek.com')).toBeNull();
  });

  it('matches only the exact domain after the last @', () => {
    const allowed = ['hayageek.com'];
    expect(domainAllowed('ravi@hayageek.com', allowed)).toBe(true);
    expect(domainAllowed('Ravi@HAYAGEEK.COM', allowed)).toBe(true);
    expect(domainAllowed('someone@gmail.com', allowed)).toBe(false);
    expect(domainAllowed('x@sub.hayageek.com', allowed)).toBe(false);
    expect(domainAllowed('x@evil-hayageek.com', allowed)).toBe(false);
    expect(domainAllowed('x@hayageek.com.evil.com', allowed)).toBe(false);
    expect(domainAllowed('"x@hayageek.com"@evil.com', allowed)).toBe(false);
    expect(domainAllowed('no-at-sign', allowed)).toBe(false);
    expect(domainAllowed('ravi@hayageek.com', [])).toBe(false);
    expect(emailDomain('a@b@c.com')).toBe('c.com');
  });

  it('cleans the settings list: lower-cased, de-duplicated, blanks dropped', () => {
    expect(normalizeDomainList(['Hayageek.com', 'hayageek.com', ' ', 'acme.io'])).toEqual({ ok: true, domains: ['hayageek.com', 'acme.io'] });
    expect(normalizeDomainList(['gmail'])).toEqual({ ok: false, error: '"gmail" is not a domain name' });
    expect(normalizeDomainList('hayageek.com')).toMatchObject({ ok: false });
  });
});

describe('claim checks', () => {
  const cfg = { emailClaim: 'email', requireVerifiedEmail: true, requiredClaims: [] as Array<{ claim: string; value: string }> };
  const allowed = ['hayageek.com'];

  it('passes a verified email in an allowed domain and lower-cases it', () => {
    expect(evaluateClaims({ email: 'Ravi@Hayageek.com', email_verified: true }, cfg, allowed)).toEqual({ ok: true, email: 'ravi@hayageek.com' });
  });

  it('refuses a missing or malformed email', () => {
    expect(evaluateClaims({ email_verified: true }, cfg, allowed)).toMatchObject({ ok: false, reason: 'email_missing' });
    expect(evaluateClaims({ email: 'not-an-email', email_verified: true }, cfg, allowed)).toMatchObject({ ok: false, reason: 'email_missing' });
  });

  it('refuses an unverified email unless the provider is set not to require it', () => {
    expect(evaluateClaims({ email: 'ravi@hayageek.com', email_verified: false }, cfg, allowed)).toMatchObject({ ok: false, reason: 'email_unverified' });
    expect(evaluateClaims({ email: 'ravi@hayageek.com' }, cfg, allowed)).toMatchObject({ ok: false, reason: 'email_unverified', detail: 'No email_verified claim' });
    expect(evaluateClaims({ email: 'ravi@hayageek.com', email_verified: 'true' }, cfg, allowed)).toMatchObject({ ok: true });
    expect(evaluateClaims({ email: 'ravi@hayageek.com' }, { ...cfg, requireVerifiedEmail: false }, allowed)).toMatchObject({ ok: true });
  });

  it('refuses a Gmail account even after a valid sign-in (the domain check runs last, on everyone)', () => {
    expect(evaluateClaims({ email: 'someone@gmail.com', email_verified: true }, cfg, allowed)).toMatchObject({
      ok: false,
      reason: 'domain_not_allowed',
      email: 'someone@gmail.com',
    });
  });

  it('reads the email from another claim when configured', () => {
    const upn = { ...cfg, emailClaim: 'upn', requireVerifiedEmail: false };
    expect(evaluateClaims({ upn: 'ravi@hayageek.com', email: 'other@gmail.com' }, upn, allowed)).toEqual({ ok: true, email: 'ravi@hayageek.com' });
  });

  it('checks required claims, including values inside an array claim', () => {
    const rows = [{ claim: 'hd', value: 'hayageek.com' }];
    expect(requiredClaimMismatch({ hd: 'hayageek.com' }, rows)).toBeNull();
    expect(requiredClaimMismatch({}, rows)).toEqual({ claim: 'hd', expected: 'hayageek.com', actual: null });
    expect(requiredClaimMismatch({ hd: 'other.com' }, rows)).toEqual({ claim: 'hd', expected: 'hayageek.com', actual: 'other.com' });
    expect(requiredClaimMismatch({ groups: ['a', 'depgate'] }, [{ claim: 'groups', value: 'depgate' }])).toBeNull();
    expect(requiredClaimMismatch({ tid: 42 }, [{ claim: 'tid', value: '42' }])).toBeNull();
    expect(
      evaluateClaims({ email: 'ravi@hayageek.com', email_verified: true }, { ...cfg, requiredClaims: rows }, allowed)
    ).toMatchObject({ ok: false, reason: 'claim_mismatch' });
  });

  it('accepts only true for email_verified', () => {
    expect(claimIsTrue(true)).toBe(true);
    expect(claimIsTrue('true')).toBe(true);
    expect(claimIsTrue(1)).toBe(false);
    expect(claimIsTrue('yes')).toBe(false);
    expect(claimIsTrue(undefined)).toBe(false);
  });
});

describe('return path after sign-in (R20)', () => {
  it('keeps same-origin paths', () => {
    expect(safeReturnTo('/policies/123')).toBe('/policies/123');
    expect(safeReturnTo('/package-check?ecosystem=npm&package=lodash')).toBe('/package-check?ecosystem=npm&package=lodash');
  });

  it('drops anything that could leave DepGate or loop back to sign-in', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'policies', '/login', '/login?x=1', '/x\ny', '/a\u0000b', 42, null, `/${'a'.repeat(3000)}`]) {
      expect(safeReturnTo(bad)).toBeNull();
    }
  });
});

describe('identity provider URLs (R4)', () => {
  it('requires https except on localhost', () => {
    expect(idpUrlProblem('https://idp.example.com', false)).toBeNull();
    expect(idpUrlProblem('http://localhost:8180/realms/x', false)).toBeNull();
    expect(idpUrlProblem('http://127.0.0.1:8180', false)).toBeNull();
    expect(idpUrlProblem('http://[::1]:8180', false)).toBeNull();
    expect(idpUrlProblem('http://keycloak:8180', false)).toMatch(/https/);
    expect(idpUrlProblem('http://keycloak:8180', true)).toBeNull();
    expect(idpUrlProblem('ftp://idp.example.com', true)).toMatch(/https/);
    expect(idpUrlProblem('https://user:pass@idp.example.com', false)).toMatch(/user name/);
    expect(idpUrlProblem('not a url', false)).toMatch(/valid URL/);
  });
});

describe('provider form (R1, R2)', () => {
  const opts = { hasSavedSecret: false, allowInsecureHttp: false };

  it('fills the defaults', () => {
    const result = normalizeProviderInput({ name: 'Corporate SSO', oidc }, opts);
    expect(result).toMatchObject({
      ok: true,
      value: {
        type: 'oidc',
        name: 'Corporate SSO',
        buttonLabel: 'Sign in with single sign-on',
        enabled: false,
        clientSecret: 's3cret',
        config: {
          issuer: oidc.issuer,
          clientId: 'depgate',
          scopes: 'openid email profile',
          emailClaim: 'email',
          requireVerifiedEmail: true,
          useDiscovery: true,
          clientAuthMethod: 'client_secret_basic',
          clockSkewSeconds: 60,
          requiredClaims: [],
          extraAuthParams: [],
        },
      },
    });
  });

  it('always includes the openid scope, once', () => {
    expect(normalizeScopes('email openid profile email')).toEqual(['openid', 'email', 'profile']);
    expect(normalizeScopes('email "bad"')).toBeNull();
  });

  it('refuses unknown types', () => {
    expect(normalizeProviderInput({ type: 'github', name: 'x', oidc }, opts)).toEqual({ ok: false, error: 'type must be oidc or saml' });
  });

  it('needs a client secret on create, but an edit may keep the saved one', () => {
    const noSecret = { ...oidc, clientSecret: '' };
    expect(normalizeProviderInput({ name: 'x', oidc: noSecret }, opts)).toEqual({ ok: false, error: 'Enter the client secret' });
    expect(normalizeProviderInput({ name: 'x', oidc: noSecret }, { ...opts, hasSavedSecret: true })).toMatchObject({
      ok: true,
      value: { clientSecret: undefined },
    });
  });

  it('refuses a plain-http issuer outside localhost', () => {
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, issuer: 'http://idp.example.com' } }, opts)).toMatchObject({
      ok: false,
      error: expect.stringContaining('https'),
    });
  });

  it('needs the endpoints when discovery is off, and drops them when it is on', () => {
    const manual = { ...oidc, useDiscovery: false, authorizationEndpoint: 'https://idp.example.com/auth' };
    expect(normalizeProviderInput({ name: 'x', oidc: manual }, opts)).toMatchObject({ ok: false, error: expect.stringContaining('Token endpoint') });
    const full = { ...manual, tokenEndpoint: 'https://idp.example.com/token', jwksUri: 'https://idp.example.com/jwks' };
    expect(normalizeProviderInput({ name: 'x', oidc: full }, opts)).toMatchObject({
      ok: true,
      value: { config: { useDiscovery: false, tokenEndpoint: 'https://idp.example.com/token', userinfoEndpoint: '' } },
    });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...full, useDiscovery: true } }, opts)).toMatchObject({
      ok: true,
      value: { config: { authorizationEndpoint: '', tokenEndpoint: '', jwksUri: '' } },
    });
  });

  it('keeps required claims and extra parameters, skipping blank rows', () => {
    const result = normalizeProviderInput(
      {
        name: 'x',
        oidc: {
          ...oidc,
          requiredClaims: [{ claim: 'hd', value: 'hayageek.com' }, { claim: '', value: '' }],
          extraAuthParams: [{ key: 'prompt', value: 'login' }],
        },
      },
      opts
    );
    expect(result).toMatchObject({
      ok: true,
      value: { config: { requiredClaims: [{ claim: 'hd', value: 'hayageek.com' }], extraAuthParams: [{ key: 'prompt', value: 'login' }] } },
    });
  });

  it('refuses parameters the flow depends on', () => {
    for (const key of ['state', 'nonce', 'redirect_uri', 'client_id', 'response_type', 'code_challenge', 'Code_Challenge_Method', 'scope']) {
      expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, extraAuthParams: [{ key, value: 'x' }] } }, opts)).toMatchObject({
        ok: false,
        error: expect.stringContaining('cannot be overridden'),
      });
    }
  });

  it('checks the remaining fields', () => {
    expect(normalizeProviderInput({ name: '', oidc }, opts)).toMatchObject({ ok: false, error: expect.stringContaining('Name') });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, clientId: '' } }, opts)).toMatchObject({ ok: false, error: expect.stringContaining('client ID') });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, clockSkewSeconds: 301 } }, opts)).toMatchObject({ ok: false });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, clientAuthMethod: 'private_key_jwt' } }, opts)).toMatchObject({ ok: false });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, emailClaim: 'e mail' } }, opts)).toMatchObject({ ok: false });
    expect(normalizeProviderInput({ name: 'x', oidc: { ...oidc, requiredClaims: [{ claim: 'hd', value: '' }] } }, opts)).toMatchObject({ ok: false });
  });
});

describe('ID token algorithms (§8.1)', () => {
  const jws = (header: object) => `${Buffer.from(JSON.stringify(header)).toString('base64url')}.e30.sig`;

  it('reads the alg from the token header', () => {
    expect(jwsAlgorithm(jws({ alg: 'RS256' }))).toBe('RS256');
    expect(jwsAlgorithm(jws({ alg: 'none' }))).toBe('none');
    expect(jwsAlgorithm('garbage')).toBeNull();
  });

  it('needs a JWKS signing key DepGate accepts', () => {
    expect(jwksHasSigningKey({ keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig' }] })).toBe(true);
    expect(jwksHasSigningKey({ keys: [{ kty: 'EC' }] })).toBe(true);
    expect(jwksHasSigningKey({ keys: [{ kty: 'oct', alg: 'HS256' }] })).toBe(false);
    expect(jwksHasSigningKey({ keys: [{ kty: 'RSA', use: 'enc' }] })).toBe(false);
    expect(jwksHasSigningKey({ keys: [] })).toBe(false);
    expect(jwksHasSigningKey(null)).toBe(false);
  });
});

describe('SAML provider form (R3)', () => {
  const opts = { hasSavedSecret: false, allowInsecureHttp: false };
  const idpCert = generateSpCertificate('IdP').certificate;
  const saml = { idpEntityId: 'https://idp.example.com/saml', ssoUrl: 'https://idp.example.com/sso', idpCertificates: [idpCert] };
  const value = (body: Record<string, unknown>, o: Parameters<typeof normalizeProviderInput>[1] = opts) => {
    const result = normalizeProviderInput({ type: 'saml', name: 'Corporate SAML', saml: body }, o);
    if (!result.ok) throw new Error(result.error);
    if (result.value.type !== 'saml') throw new Error('not saml');
    return result.value;
  };
  const error = (body: Record<string, unknown>, o: Parameters<typeof normalizeProviderInput>[1] = opts) => {
    const result = normalizeProviderInput({ type: 'saml', name: 'x', saml: body }, o);
    return result.ok ? null : result.error;
  };

  it('fills the defaults: signed assertions, email NameID, no SP key', () => {
    const v = value(saml);
    const { idpCertificates: _none, ...defaults } = DEFAULT_SAML_CONFIG;
    expect(_none).toEqual([]);
    expect(v.config).toMatchObject({
      ...defaults,
      idpEntityId: saml.idpEntityId,
      ssoUrl: saml.ssoUrl,
      requireSignedAssertion: true,
      signRequests: false,
      acceptEncryptedAssertions: false,
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    });
    expect(v.config.idpCertificates).toHaveLength(1);
    expect(v.spKey).toEqual({ action: 'keep' });
  });

  it('needs the IdP fields, unless a metadata URL will supply them', () => {
    expect(error({ ...saml, idpEntityId: '' })).toMatch(/entity ID/);
    expect(error({ ...saml, ssoUrl: '' })).toMatch(/SSO URL/);
    expect(error({ ...saml, idpCertificates: [] })).toMatch(/signing certificate/);
    expect(value({ metadataUrl: 'https://idp.example.com/metadata' }).config.metadataUrl).toBe('https://idp.example.com/metadata');
    expect(error({ metadataUrl: 'http://idp.example.com/metadata' })).toMatch(/https/);
  });

  it('accepts one or two PEM certificates, in one text or a list, and nothing else', () => {
    const next = generateSpCertificate('Next').certificate;
    expect(value({ ...saml, idpCertificates: [`${idpCert}\n${next}`] }).config.idpCertificates).toHaveLength(2);
    expect(value({ ...saml, idpCertificates: [idpCert, idpCert] }).config.idpCertificates).toHaveLength(1);
    expect(error({ ...saml, idpCertificates: [idpCert, next, generateSpCertificate('third').certificate] })).toMatch(/At most 2/);
    expect(error({ ...saml, idpCertificates: ['-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----'] })).toMatch(/could not be read/);
    expect(error({ ...saml, idpCertificates: [generateSpCertificate('k').privateKey] })).toMatch(/Expected a CERTIFICATE/);
  });

  it('refuses an http SSO URL except on localhost', () => {
    expect(error({ ...saml, ssoUrl: 'http://idp.example.com/sso' })).toMatch(/https/);
    expect(value({ ...saml, ssoUrl: 'http://localhost:8180/realms/x/protocol/saml' }).config.ssoUrl).toContain('localhost');
  });

  it('checks attribute names, required attributes and the clock skew', () => {
    expect(value({ ...saml, emailAttribute: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress' }).config.emailAttribute).toContain('emailaddress');
    expect(value({ ...saml, requiredAttributes: [{ attribute: 'department', value: 'Engineering' }] }).config.requiredAttributes).toEqual([
      { attribute: 'department', value: 'Engineering' },
    ]);
    expect(error({ ...saml, requiredAttributes: [{ attribute: 'department', value: '' }] })).toMatch(/needs a value/);
    expect(error({ ...saml, emailAttribute: 'bad\nname' })).toMatch(/Email attribute/);
    expect(error({ ...saml, nameIdFormat: 'email' })).toMatch(/NameID format/);
    expect(error({ ...saml, clockSkewSeconds: 301 })).toMatch(/Clock skew/);
  });

  it('needs an SP certificate to sign requests or decrypt assertions', () => {
    expect(error({ ...saml, signRequests: true })).toMatch(/Signing requests needs an SP certificate/);
    expect(error({ ...saml, acceptEncryptedAssertions: true })).toMatch(/Decrypting assertions needs/);
    expect(value({ ...saml, signRequests: true, spKey: { action: 'generate' } }).spKey).toEqual({ action: 'generate' });
    const saved = generateSpCertificate('saved').certificate;
    expect(value({ ...saml, signRequests: true }, { ...opts, savedSpCertificate: saved, hasSpKey: true }).config.spCertificate).toBe(saved);
    // A saved certificate whose key can no longer be decrypted does not count.
    expect(error({ ...saml, signRequests: true }, { ...opts, savedSpCertificate: saved, hasSpKey: false })).toMatch(/SP certificate/);
    expect(value({ ...saml, spKey: { action: 'remove' } }, { ...opts, savedSpCertificate: saved, hasSpKey: true }).config.spCertificate).toBe('');
  });

  it('takes an uploaded SP key pair only when the key belongs to the certificate', () => {
    const pair = generateSpCertificate('mine');
    const other = generateSpCertificate('other');
    const uploaded = value({ ...saml, spKey: { action: 'upload', certificate: pair.certificate, privateKey: pair.privateKey } }).spKey;
    expect(uploaded).toMatchObject({ action: 'upload', privateKey: expect.stringContaining('BEGIN PRIVATE KEY') });
    expect(error({ ...saml, spKey: { action: 'upload', certificate: pair.certificate, privateKey: other.privateKey } })).toMatch(/does not belong/);
    expect(error({ ...saml, spKey: { action: 'upload', certificate: pair.certificate } })).toMatch(/private key/);
    expect(error({ ...saml, spKey: { action: 'steal' } })).toMatch(/spKey.action/);
  });
});

describe('SAML attributes as claims', () => {
  const allowed = ['hayageek.com'];
  const cfg = { emailAttribute: '', requiredAttributes: [] as Array<{ attribute: string; value: string }> };
  const EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
  const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

  it('reads the email from an email NameID, otherwise from the email attribute', () => {
    const byNameId = samlClaims({ nameId: 'Ravi@Hayageek.com', nameIdFormat: EMAIL, attributes: {} }, cfg);
    expect(byNameId.rules).toMatchObject({ emailClaim: SAML_NAMEID_KEY, requireVerifiedEmail: false });
    expect(evaluateClaims(byNameId.claims, byNameId.rules, allowed, 'attribute')).toEqual({ ok: true, email: 'ravi@hayageek.com' });

    const persistent = samlClaims({ nameId: 'a1b2', nameIdFormat: PERSISTENT, attributes: { email: ['ravi@hayageek.com'] } }, cfg);
    expect(persistent.rules.emailClaim).toBe('email');
    expect(evaluateClaims(persistent.claims, persistent.rules, allowed, 'attribute')).toEqual({ ok: true, email: 'ravi@hayageek.com' });

    const missing = samlClaims({ nameId: 'a1b2', nameIdFormat: PERSISTENT, attributes: {} }, cfg);
    expect(evaluateClaims(missing.claims, missing.rules, allowed, 'attribute')).toMatchObject({ ok: false, reason: 'email_missing', detail: 'No email attribute' });
  });

  it('uses the configured email attribute, first value of several', () => {
    const claim = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
    const mapped = samlClaims(
      { nameId: 'ravi@hayageek.com', nameIdFormat: EMAIL, attributes: { [claim]: ['other@gmail.com', 'ravi@hayageek.com'] } },
      { ...cfg, emailAttribute: claim }
    );
    expect(evaluateClaims(mapped.claims, mapped.rules, allowed, 'attribute')).toMatchObject({ ok: false, reason: 'domain_not_allowed', email: 'other@gmail.com' });
  });

  it('enforces required attributes, matching any value of a multi-valued one', () => {
    const rules = { ...cfg, requiredAttributes: [{ attribute: 'groups', value: 'depgate' }] };
    const member = samlClaims({ nameId: 'ravi@hayageek.com', nameIdFormat: EMAIL, attributes: { groups: ['devs', 'depgate'] } }, rules);
    expect(evaluateClaims(member.claims, member.rules, allowed, 'attribute')).toMatchObject({ ok: true });
    const outsider = samlClaims({ nameId: 'ravi@hayageek.com', nameIdFormat: EMAIL, attributes: { groups: 'devs' } }, rules);
    expect(evaluateClaims(outsider.claims, outsider.rules, allowed, 'attribute')).toMatchObject({
      ok: false,
      reason: 'claim_mismatch',
      detail: 'Attribute groups must be "depgate" but is "devs"',
    });
  });

  it('never trusts an email the domain list does not allow', () => {
    const gmail = samlClaims({ nameId: 'someone@gmail.com', nameIdFormat: EMAIL, attributes: {} }, cfg);
    expect(evaluateClaims(gmail.claims, gmail.rules, allowed, 'attribute')).toMatchObject({ ok: false, reason: 'domain_not_allowed' });
  });
});
