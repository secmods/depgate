/**
 * Single sign-on with SAML 2.0 end to end against a mock IdP (requirements_sso.md §12.1 cases 3 and 12).
 * Requires PostgreSQL + Redis (RUN_INTEGRATION=1). Leaves the sign-in settings as it found them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { Like } from 'typeorm';
import { buildApp } from '../app.js';
import type { AuditEvent } from '../db/entities/AuditEvent.js';
import { auditFor } from '../test-support/event-rows.js';
import { AuthToken } from '../db/entities/AuthToken.js';
import { SsoProvider } from '../db/entities/SsoProvider.js';
import { User } from '../db/entities/User.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { generateSpCertificate } from '../services/saml-certs.js';
import { loadSigninSettings, saveSigninSettings, type SigninSettings } from '../services/signin-settings.js';
import { EMAIL_FORMAT, MockSamlIdp, PERSISTENT_FORMAT, type MockSamlAccount } from '../test-support/mock-saml.js';

const stamp = Date.now();
const DOMAIN = `saml-it-${stamp}.test`;
const email = (name: string) => `${name}@${DOMAIN}`;

interface SignInOutcome {
  error: string | null;
  token?: string;
  registryToken?: string;
  user?: { email: string; role: string };
  returnTo?: string | null;
  form?: { SAMLResponse: string; RelayState: string };
  acsPath?: string;
  finalLocation: string;
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Single sign-on (SAML)', () => {
  let app: FastifyInstance;
  let admin: string;
  let providerId = '';
  let original: SigninSettings;
  const idp = new MockSamlIdp();

  const api = () => supertest(app.server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const creds of [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'admin@depgate.local', password: 'admin' },
    ]) {
      const res = await api().post('/api/auth/login').send(creds);
      if (res.status === 200) {
        admin = res.body.token;
        break;
      }
    }
    if (!admin) throw new Error('Could not obtain auth token');

    await idp.start();
    original = await loadSigninSettings(app.db);
    await saveSigninSettings(app.db, { allowedDomains: [...original.allowedDomains, DOMAIN], allowUnlistedSso: true });

    const created = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ type: 'saml', name: `saml-it ${stamp}`, buttonLabel: 'Sign in with Test SAML', enabled: true, saml: { metadataUrl: idp.metadataUrl } })
      .expect(201);
    expect(created.body.validationError).toBeNull();
    expect(created.body.provider.enabled).toBe(true);
    providerId = created.body.provider.id;
  });

  afterAll(async () => {
    if (!app) return;
    const users = await app.db.getRepository(User).find({ where: { email: Like(`%@${DOMAIN}`) } });
    for (const user of users) {
      await app.db.getRepository(UserIdentity).delete({ userId: user.id });
      await app.db.getRepository(AuthToken).delete({ userId: user.id });
      await app.db.getRepository(User).delete({ id: user.id });
    }
    const providers = await app.db.getRepository(SsoProvider).find({ where: { name: Like(`saml-it%${stamp}%`) } });
    for (const provider of providers) {
      await app.db.getRepository(UserIdentity).delete({ providerId: provider.id });
      await app.db.getRepository(SsoProvider).delete({ id: provider.id });
    }
    await saveSigninSettings(app.db, original);
    await idp.stop();
    await app.close();
  });

  beforeEach(async () => {
    const keys = await app.redis.keys('rl:*');
    if (keys.length) await app.redis.del(...keys);
  });

  /** Plays the browser through start → IdP → ACS form post → exchange. */
  async function signIn(account: MockSamlAccount, opts: { returnTo?: string; id?: string } = {}): Promise<SignInOutcome> {
    idp.account = account;
    const start = await api()
      .get(`/api/auth/sso/${opts.id ?? providerId}/start`)
      .query(opts.returnTo ? { returnTo: opts.returnTo } : {})
      .redirects(0);
    expect(start.status).toBe(302);
    const toIdp = start.headers.location as string;
    if (toIdp.includes('/login?sso_error=')) return { error: new URL(toIdp).searchParams.get('sso_error'), finalLocation: toIdp };
    const { acsUrl, form } = await idp.authorize(toIdp);
    const acsPath = new URL(acsUrl).pathname;
    const back = await api().post(acsPath).type('form').send(form).redirects(0);
    expect(back.status).toBe(303);
    const finalLocation = back.headers.location as string;
    const final = new URL(finalLocation);
    if (final.pathname !== '/login/sso') return { error: final.searchParams.get('sso_error'), form, acsPath, finalLocation };
    const exchange = await api().post('/api/auth/sso/exchange').send({ code: final.searchParams.get('code') }).expect(200);
    return { error: null, ...exchange.body, form, acsPath, finalLocation };
  }

  const account = (name: string, extra: Partial<MockSamlAccount> = {}): MockSamlAccount => ({
    nameId: email(name),
    attributes: { email: email(name), displayName: name },
    ...extra,
  });

  async function addUser(name: string, role: 'User' | 'Security'): Promise<string> {
    const res = await api().post('/api/admin/users').set(auth(admin)).send({ email: email(name), role, sendInvite: false }).expect(201);
    return res.body.id;
  }

  async function ledger(type: string, targetName: string, until?: (rows: AuditEvent[]) => boolean): Promise<AuditEvent[]> {
    return auditFor(app.db, type, targetName, until);
  }

  const view = async () => (await api().get(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).expect(200)).body;

  async function update(saml: Record<string, unknown>) {
    const current = await view();
    const readOnly = ['idpCertificateInfo', 'spCertificateInfo', 'hasSpPrivateKey', 'spPrivateKeyUnreadable', 'spCertificate'];
    const settings = Object.fromEntries(Object.entries(current.saml as Record<string, unknown>).filter(([key]) => !readOnly.includes(key)));
    return api()
      .put(`/api/admin/sso-providers/${providerId}`)
      .set(auth(admin))
      .send({ type: 'saml', name: current.name, buttonLabel: current.buttonLabel, enabled: true, saml: { ...settings, ...saml } });
  }

  it('reads the IdP from its metadata URL, and shows the URLs to register and the certificate', async () => {
    const provider = await view();
    expect(provider.type).toBe('saml');
    expect(provider.oidc).toBeNull();
    expect(provider.saml).toMatchObject({
      metadataUrl: idp.metadataUrl,
      idpEntityId: idp.entityId,
      ssoUrl: idp.ssoUrl,
      requireSignedAssertion: true,
      hasSpPrivateKey: false,
    });
    expect(provider.saml.idpCertificates).toHaveLength(1);
    expect(provider.saml.idpCertificateInfo[0]).toMatchObject({ subject: 'CN=Mock SAML IdP', expired: false });
    expect(provider.certificateExpiresAt).toBe(provider.saml.idpCertificateInfo[0].notAfter);
    expect(provider.urls.spEntityId).toMatch(new RegExp(`/api/auth/saml/${providerId}/metadata$`));
    expect(provider.urls.acsUrl).toMatch(new RegExp(`/api/auth/saml/${providerId}/acs$`));

    const list = await api().get('/api/auth/providers').expect(200);
    expect(list.body).toContainEqual({ id: providerId, type: 'saml', buttonLabel: 'Sign in with Test SAML' });
  });

  it('serves SP metadata at the entity ID, and only for SAML providers', async () => {
    const res = await api().get(`/api/auth/saml/${providerId}/metadata`).expect(200);
    expect(res.headers['content-type']).toContain('application/samlmetadata+xml');
    const provider = await view();
    expect(res.text).toContain(`entityID="${provider.urls.spEntityId}"`);
    expect(res.text).toContain(`Location="${provider.urls.acsUrl}"`);
    await api().get('/api/auth/saml/00000000-0000-4000-8000-000000000000/metadata').expect(404);
  });

  it('signs in a listed User as User, and records the SAML method (case 3)', async () => {
    await addUser('dev', 'User');
    const result = await signIn(account('dev', { attributes: { email: email('dev'), role: 'Security', groups: ['admins'] } }));
    expect(result.error).toBeNull();
    expect(result.user).toEqual({ email: email('dev'), role: 'User' });
    await api().get('/api/admin/users').set(auth(result.token!)).expect(403);

    const [linked] = await ledger('IDENTITY_LINKED', email('dev'));
    expect(linked.details).toMatchObject({ providerId, subject: email('dev'), method: 'saml' });
    const [login] = await ledger('LOGIN_SUCCEEDED', email('dev'));
    expect(login.details).toMatchObject({ method: 'saml', providerId, role: 'User', roleSource: 'configured' });
    const user = await app.db.getRepository(User).findOneByOrFail({ email: email('dev') });
    expect(user).toMatchObject({ lastLoginMethod: 'saml', lastLoginProviderId: providerId });
  });

  it('signs in a listed Security user as Security', async () => {
    await addUser('ravi', 'Security');
    const result = await signIn(account('ravi'));
    expect(result.user).toEqual({ email: email('ravi'), role: 'Security' });
    await api().get('/api/admin/users').set(auth(result.token!)).expect(200);
  });

  it('adds an unlisted person in an allowed domain as User', async () => {
    const result = await signIn(account('newbie'));
    expect(result.user).toEqual({ email: email('newbie'), role: 'User' });
    expect(await app.db.getRepository(User).findOneByOrFail({ email: email('newbie') })).toMatchObject({ source: 'sso', role: 'User' });
    const [provisioned] = await ledger('USER_PROVISIONED', email('newbie'));
    expect(provisioned.details).toMatchObject({ providerId, method: 'saml' });
  });

  it('refuses a Gmail address the IdP vouches for', async () => {
    const gmail = `someone-${stamp}@gmail.com`;
    const result = await signIn({ nameId: gmail });
    expect(result.error).toBe('domain_not_allowed');
    expect(await app.db.getRepository(User).count({ where: { email: gmail } })).toBe(0);
    const [row] = await ledger('LOGIN_FAILED', gmail);
    expect(row.details).toMatchObject({ method: 'saml', reason: 'domain_not_allowed', providerId });
  });

  it('reads the email from an attribute when the NameID is persistent, and ties the account to that NameID', async () => {
    const first = await signIn({ nameId: `persist-a-${stamp}`, nameIdFormat: PERSISTENT_FORMAT, attributes: { email: email('persist') } });
    expect(first.user?.email).toBe(email('persist'));
    const impostor = await signIn({ nameId: `persist-b-${stamp}`, nameIdFormat: PERSISTENT_FORMAT, attributes: { email: email('persist') } });
    expect(impostor.error).toBe('subject_mismatch');
  });

  it('keeps a same-origin return path and drops anything else', async () => {
    expect((await signIn(account('deeplink'), { returnTo: '/policies/123' })).returnTo).toBe('/policies/123');
    expect((await signIn(account('deeplink'), { returnTo: 'https://evil.example' })).returnTo).toBeNull();
  });

  it('refuses a tampered response, audits it, and notes the error on the provider (case 12)', async () => {
    idp.tamper = { afterSign: (xml) => xml.replace(`>${email('tampered')}</saml:NameID>`, `>${email('ravi')}</saml:NameID>`) };
    const result = await signIn(account('tampered'));
    expect(result.error).toBe('invalid_response');
    expect(result.finalLocation).toMatch(/\/login\?sso_error=invalid_response$/);
    expect(await app.db.getRepository(User).count({ where: { email: email('tampered') } })).toBe(0);
    const provider = await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId });
    expect(provider.lastError).toMatch(/signature/i);
    const failures = await ledger('LOGIN_FAILED', '(unknown)', (rows) => rows.some((row) => row.details?.providerId === providerId && row.details?.reason === 'invalid_response'));
    expect(failures.some((row) => row.details?.method === 'saml')).toBe(true);

    expect((await signIn(account('tampered'))).error).toBeNull();
    expect((await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId })).lastError).toBeNull();
  });

  it('refuses another audience, an expired assertion and an unsigned one', async () => {
    idp.tamper = { audience: 'https://another-sp.example.com' };
    expect((await signIn(account('forged'))).error).toBe('invalid_response');
    idp.tamper = { expiresIn: -600 };
    expect((await signIn(account('forged'))).error).toBe('invalid_response');
    idp.tamper = { sign: 'none' };
    expect((await signIn(account('forged'))).error).toBe('invalid_response');
    idp.tamper = { xsw: 'extensions', sign: 'assertion' };
    expect((await signIn(account('forged'))).error).toBe('invalid_response');
    expect(await app.db.getRepository(User).count({ where: { email: email('forged') } })).toBe(0);
  });

  it('refuses a replayed form post, and an assertion ID seen before', async () => {
    const result = await signIn(account('replay'));
    expect(result.error).toBeNull();
    const again = await api().post(result.acsPath!).type('form').send(result.form!).redirects(0).expect(303);
    expect(new URL(again.headers.location as string).searchParams.get('sso_error')).toBe('state_invalid');

    // A fresh request, answered with a correctly signed assertion that reuses an earlier assertion ID.
    const reused = `_reused-${stamp}`;
    idp.tamper = { assertionId: reused };
    expect((await signIn(account('replay'))).error).toBeNull();
    idp.tamper = { assertionId: reused };
    expect((await signIn(account('replay'))).error).toBe('invalid_response');
  });

  it('refuses an IdP-initiated (unsolicited) response, and one posted to another provider', async () => {
    const start = await api().get(`/api/auth/sso/${providerId}/start`).redirects(0);
    idp.account = account('unsolicited');
    const { acsUrl, form } = await idp.authorize(start.headers.location as string);
    const noRelay = await api().post(new URL(acsUrl).pathname).type('form').send({ SAMLResponse: form.SAMLResponse }).redirects(0).expect(303);
    expect(new URL(noRelay.headers.location as string).searchParams.get('sso_error')).toBe('state_invalid');
    const elsewhere = await api().post(`/api/auth/saml/00000000-0000-4000-8000-000000000000/acs`).type('form').send(form).redirects(0).expect(303);
    expect(new URL(elsewhere.headers.location as string).searchParams.get('sso_error')).toBe('state_invalid');
    const [row] = await ledger('LOGIN_FAILED', '(unknown)', (rows) => rows.some((r) => r.details?.method === 'saml' && r.details?.reason === 'state_invalid'));
    expect(row).toBeTruthy();
  });

  it('reports an IdP that refused the person as a provider error', async () => {
    idp.tamper = { status: { code: 'urn:oasis:names:tc:SAML:2.0:status:Responder', subcode: 'urn:oasis:names:tc:SAML:2.0:status:AuthnFailed' } };
    expect((await signIn(account('cancelled'))).error).toBe('provider_error');
  });

  it('generates an SP certificate, signs requests with it, and accepts encrypted assertions', async () => {
    const generated = await api().post(`/api/admin/sso-providers/${providerId}/sp-certificate`).set(auth(admin)).send({ action: 'generate' }).expect(200);
    expect(generated.body.saml).toMatchObject({ hasSpPrivateKey: true, spPrivateKeyUnreadable: false });
    expect(generated.body.saml.spCertificateInfo.subject).toBe(`CN=DepGate saml-it ${stamp}`);
    expect(JSON.stringify(generated.body)).not.toContain('PRIVATE KEY');
    const stored = await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId });
    expect(stored.spPrivateKeyEnc).toMatch(/^v1:/);
    expect(stored.spPrivateKeyEnc).not.toContain('PRIVATE KEY');

    const spCert = generated.body.saml.spCertificate as string;
    try {
      const saved = await update({ signRequests: true, acceptEncryptedAssertions: true });
      expect(saved.status).toBe(200);
      expect(saved.body.validationError).toBeNull();
      const metadata = await api().get(`/api/auth/saml/${providerId}/metadata`).expect(200);
      expect(metadata.text).toContain('AuthnRequestsSigned="true"');
      expect(metadata.text).toContain('use="encryption"');

      idp.spCertificate = spCert;
      idp.tamper = { encryptTo: spCert };
      const result = await signIn(account('encrypted'));
      expect(result.error).toBeNull();
      expect(idp.lastRequest).toMatchObject({ signed: true, signatureValid: true });
    } finally {
      idp.spCertificate = '';
      expect((await update({ signRequests: false, acceptEncryptedAssertions: false, spKey: { action: 'remove' } })).status).toBe(200);
    }
    expect((await view()).saml).toMatchObject({ hasSpPrivateKey: false, spCertificate: '' });
  });

  it('refuses to sign requests without an SP certificate', async () => {
    const res = await update({ signRequests: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SP certificate/);
  });

  it('keeps a provider whose certificate expired as a turned-off draft (R4)', async () => {
    const expired = generateSpCertificate('Old IdP key', new Date(Date.now() - 6 * 365 * 86_400_000)).certificate;
    const res = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ type: 'saml', name: `saml-it expired ${stamp}`, enabled: true, saml: { idpEntityId: idp.entityId, ssoUrl: idp.ssoUrl, idpCertificates: [expired] } })
      .expect(201);
    expect(res.body.provider.enabled).toBe(false);
    expect(res.body.validationError).toMatch(/expired/);
    expect(res.body.provider.saml.idpCertificateInfo[0].expired).toBe(true);
    await api().delete(`/api/admin/sso-providers/${res.body.provider.id}`).set(auth(admin)).expect(204);
  });

  it('keeps typed values when the metadata URL cannot be read', async () => {
    const res = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({
        type: 'saml',
        name: `saml-it unreachable ${stamp}`,
        enabled: true,
        saml: { metadataUrl: 'http://127.0.0.1:9/metadata', idpEntityId: idp.entityId, ssoUrl: idp.ssoUrl, idpCertificates: [idp.certificate] },
      })
      .expect(201);
    expect(res.body.provider.enabled).toBe(false);
    expect(res.body.validationError).toMatch(/Metadata could not be read/);
    expect(res.body.provider.saml.idpEntityId).toBe(idp.entityId);
    await api().delete(`/api/admin/sso-providers/${res.body.provider.id}`).set(auth(admin)).expect(204);
  });

  it('will not change a saved provider from SAML to OIDC', async () => {
    const res = await api()
      .put(`/api/admin/sso-providers/${providerId}`)
      .set(auth(admin))
      .send({ type: 'oidc', name: 'x', oidc: { issuer: 'https://idp.example.com', clientId: 'x', clientSecret: 'y' } })
      .expect(400);
    expect(res.body.error).toMatch(/cannot change/);
  });

  it('reads metadata and describes certificates for the form', async () => {
    const byUrl = await api().post('/api/admin/sso-providers/saml-metadata').set(auth(admin)).send({ url: idp.metadataUrl }).expect(200);
    expect(byUrl.body).toMatchObject({ entityId: idp.entityId, ssoUrl: idp.ssoUrl });
    expect(byUrl.body.certificates[0].info.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const byXml = await api().post('/api/admin/sso-providers/saml-metadata').set(auth(admin)).send({ xml: idp.metadataXml() }).expect(200);
    expect(byXml.body.entityId).toBe(idp.entityId);
    await api().post('/api/admin/sso-providers/saml-metadata').set(auth(admin)).send({ xml: '<html/>' }).expect(400);
    await api().post('/api/admin/sso-providers/saml-metadata').set(auth(admin)).send({}).expect(400);

    const info = await api().post('/api/admin/sso-providers/certificate-info').set(auth(admin)).send({ certificates: [idp.certificate] }).expect(200);
    expect(info.body.certificates[0].info.subject).toBe('CN=Mock SAML IdP');
    await api().post('/api/admin/sso-providers/certificate-info').set(auth(admin)).send({ certificates: ['nope'] }).expect(400);
  });

  it('tests the provider without signing anyone in or creating anything (R5)', async () => {
    const ticketRes = await api().post(`/api/admin/sso-providers/${providerId}/test`).set(auth(admin)).expect(200);
    const { ticket, startUrl } = ticketRes.body as { ticket: string; startUrl: string };
    idp.account = account('tester', { attributes: { email: email('tester'), department: 'Engineering' } });
    const start = await api().get(startUrl).redirects(0).expect(302);
    const { acsUrl, form } = await idp.authorize(start.headers.location as string);
    const back = await api().post(new URL(acsUrl).pathname).type('form').send(form).redirects(0).expect(303);
    expect(new URL(back.headers.location as string).pathname).toBe('/sso-test-done');

    const result = await api().get(`/api/admin/sso-providers/test/${ticket}`).set(auth(admin)).expect(200);
    expect(result.body).toMatchObject({ status: 'done', ok: true, subject: email('tester'), email: email('tester') });
    expect(result.body.outcome).toMatch(/Would add this person/);
    expect(result.body.claims).toMatchObject({ NameID: email('tester'), NameIDFormat: EMAIL_FORMAT, department: 'Engineering' });
    expect(result.body.checks.map((c: { label: string }) => c.label)).toEqual([
      'Identity provider response',
      'Email (NameID)',
      'Required attributes',
      'Allowed sign-in domain',
      'DepGate account',
    ]);
    expect(await app.db.getRepository(User).count({ where: { email: email('tester') } })).toBe(0);
  });

  it('enforces required attributes', async () => {
    await update({ requiredAttributes: [{ attribute: 'department', value: 'Engineering' }] });
    try {
      expect((await signIn(account('attrs'))).error).toBe('claim_mismatch');
      expect((await signIn(account('attrs', { attributes: { email: email('attrs'), department: 'Engineering' } }))).error).toBeNull();
    } finally {
      await update({ requiredAttributes: [] });
    }
  });

  it('stops offering a turned-off provider, and refuses to start it', async () => {
    await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: false }).expect(200);
    try {
      expect((await signIn(account('off'))).error).toBe('provider_unavailable');
    } finally {
      await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: true }).expect(200);
    }
  });

  it('filters the ledger by the SAML sign-in method', async () => {
    const res = await api().get('/api/admin/audit-events').query({ type: 'SIGNIN_SUCCEEDED', authMethod: 'saml', limit: '50' }).set(auth(admin)).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((row: { actor: { authMethod?: string }; details: { method?: string } }) => row.actor.authMethod === 'saml' && row.details.method === 'saml')).toBe(true);
  });
});
