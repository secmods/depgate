/**
 * Single sign-on end to end against a mock OIDC provider (requirements_sso.md §12.1).
 * Requires PostgreSQL + Redis (RUN_INTEGRATION=1). Leaves the sign-in settings as it found them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { Like } from 'typeorm';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import type { AuditEvent } from '../db/entities/AuditEvent.js';
import { auditFor, auditRows } from '../test-support/event-rows.js';
import { AuthToken } from '../db/entities/AuthToken.js';
import { SsoProvider } from '../db/entities/SsoProvider.js';
import { User } from '../db/entities/User.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { issueToken } from '../services/auth-tokens.js';
import { loadSigninSettings, saveSigninSettings, type SigninSettings } from '../services/signin-settings.js';
import { MockOidcProvider, type MockAccount } from '../test-support/mock-oidc.js';

const stamp = Date.now();
const DOMAIN = `sso-it-${stamp}.test`;
const email = (name: string) => `${name}@${DOMAIN}`;

interface SignInOutcome {
  error: string | null;
  token?: string;
  registryToken?: string;
  user?: { email: string; role: string };
  returnTo?: string | null;
  callback?: URL;
  finalLocation: string;
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Single sign-on (OIDC)', () => {
  let app: FastifyInstance;
  let admin: string;
  let adminEmail = '';
  let providerId = '';
  let original: SigninSettings;
  const idp = new MockOidcProvider();

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
        adminEmail = creds.email;
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
      .send({
        name: `sso-it ${stamp}`,
        buttonLabel: 'Sign in with Test SSO',
        enabled: true,
        oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret },
      })
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
    await app.db.getRepository(UserIdentity).delete({ subject: Like(`%-${stamp}`) });
    const providers = await app.db.getRepository(SsoProvider).find({ where: { name: Like(`sso-it%${stamp}%`) } });
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

  /** Plays the browser through start → provider → callback → exchange. */
  async function signIn(account: MockAccount, opts: { returnTo?: string; id?: string } = {}): Promise<SignInOutcome> {
    idp.account = account;
    const start = await api()
      .get(`/api/auth/sso/${opts.id ?? providerId}/start`)
      .query(opts.returnTo ? { returnTo: opts.returnTo } : {})
      .redirects(0);
    expect(start.status).toBe(302);
    const toProvider = start.headers.location as string;
    if (toProvider.includes('/login?sso_error=')) {
      return { error: new URL(toProvider).searchParams.get('sso_error'), finalLocation: toProvider };
    }
    const callback = await idp.authorize(toProvider);
    const back = await api().get(callback.pathname + callback.search).redirects(0);
    expect(back.status).toBe(302);
    const finalLocation = back.headers.location as string;
    const final = new URL(finalLocation);
    if (final.pathname !== '/login/sso') return { error: final.searchParams.get('sso_error'), callback, finalLocation };
    const exchange = await api().post('/api/auth/sso/exchange').send({ code: final.searchParams.get('code') }).expect(200);
    return { error: null, ...exchange.body, callback, finalLocation };
  }

  const account = (name: string, extra: Partial<MockAccount> = {}): MockAccount => ({
    sub: `${name}-${stamp}`,
    email: email(name),
    email_verified: true,
    ...extra,
  });

  async function addUser(name: string, role: 'User' | 'Security'): Promise<string> {
    const res = await api().post('/api/admin/users').set(auth(admin)).send({ email: email(name), role, sendInvite: false }).expect(201);
    expect(res.body.invited).toBe(false);
    return res.body.id;
  }

  /** Ledger rows are written after the response; wait for them. */
  async function ledger(type: string, targetName: string, until?: (rows: AuditEvent[]) => boolean): Promise<AuditEvent[]> {
    return auditFor(app.db, type, targetName, until);
  }

  const gatewayStatus = async (token: string) => (await api().get('/api/admin/config/gateway').set(auth(token))).status;

  it('lists the enabled provider for the login page, with nothing secret', async () => {
    const res = await api().get('/api/auth/providers').expect(200);
    expect(res.body).toContainEqual({ id: providerId, type: 'oidc', buttonLabel: 'Sign in with Test SSO' });

    const adminList = await api().get('/api/admin/sso-providers').set(auth(admin)).expect(200);
    const row = adminList.body.find((p: { id: string }) => p.id === providerId);
    expect(row.oidc).toMatchObject({ issuer: idp.issuer, clientId: idp.clientId, hasClientSecret: true, clientSecretUnreadable: false });
    expect(row.urls.redirectUri).toMatch(new RegExp(`/api/auth/sso/${providerId}/callback$`));
    expect(JSON.stringify(adminList.body)).not.toContain(idp.clientSecret);
    const stored = await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId });
    expect(stored.clientSecretEnc).not.toContain(idp.clientSecret);
  });

  it('signs in a listed Security user as Security, and records how', async () => {
    await addUser('ravi', 'Security');
    const result = await signIn(account('ravi'));
    expect(result.error).toBeNull();
    expect(result.user).toEqual({ email: email('ravi'), role: 'Security' });
    expect(await gatewayStatus(result.token!)).toBe(200);
    await api().get('/api/admin/users').set(auth(result.token!)).expect(200);

    const [linked] = await ledger('IDENTITY_LINKED', email('ravi'));
    expect(linked.details).toMatchObject({ providerId, subject: `ravi-${stamp}` });
    const [login] = await ledger('LOGIN_SUCCEEDED', email('ravi'));
    expect(login.details).toMatchObject({ method: 'oidc', providerId, role: 'Security', roleSource: 'configured' });

    const users = await api().get('/api/admin/users').query({ search: email('ravi') }).set(auth(admin)).expect(200);
    const row = users.body.items.find((u: { email: string }) => u.email === email('ravi'));
    expect(row).toMatchObject({ status: 'active', source: 'local', lastLoginMethod: 'oidc', lastLoginProvider: `sso-it ${stamp}` });
    expect(row.signInMethods).toEqual([`sso-it ${stamp}`]);
  });

  it('signs in a listed User as User, never Security', async () => {
    await addUser('dev', 'User');
    const result = await signIn(account('dev', { claims: { groups: ['admins'], role: 'Security' } }));
    expect(result.user?.role).toBe('User');
    await api().get('/api/admin/users').set(auth(result.token!)).expect(403);
  });

  it('adds an unlisted person in an allowed domain as User, once', async () => {
    const first = await signIn(account('newbie'));
    expect(first.user).toEqual({ email: email('newbie'), role: 'User' });
    const users = await app.db.getRepository(User).find({ where: { email: email('newbie') } });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ source: 'sso', role: 'User', passwordHash: null });
    const [provisioned] = await ledger('USER_PROVISIONED', email('newbie'));
    expect(provisioned.details).toMatchObject({ providerId });
    const [login] = await ledger('LOGIN_SUCCEEDED', email('newbie'));
    expect(login.details?.roleSource).toBe('provisioned');

    const again = await signIn(account('newbie'));
    expect(again.user?.role).toBe('User');
    expect(await app.db.getRepository(User).count({ where: { email: email('newbie') } })).toBe(1);
  });

  it('refuses an unlisted person when unlisted sign-in is off', async () => {
    const settings = await loadSigninSettings(app.db);
    await saveSigninSettings(app.db, { ...settings, allowUnlistedSso: false });
    try {
      const result = await signIn(account('stranger'));
      expect(result.error).toBe('not_invited');
      expect(await app.db.getRepository(User).count({ where: { email: email('stranger') } })).toBe(0);
    } finally {
      await saveSigninSettings(app.db, { ...settings, allowUnlistedSso: true });
    }
  });

  it('refuses a Gmail account that the provider vouches for', async () => {
    const result = await signIn({ sub: `gmail-${stamp}`, email: `someone-${stamp}@gmail.com`, email_verified: true });
    expect(result.error).toBe('domain_not_allowed');
    expect(result.finalLocation).toMatch(/\/login\?sso_error=domain_not_allowed$/);
    expect(await app.db.getRepository(User).count({ where: { email: `someone-${stamp}@gmail.com` } })).toBe(0);
    const [row] = await ledger('LOGIN_FAILED', `someone-${stamp}@gmail.com`);
    expect(row.details).toMatchObject({ method: 'oidc', reason: 'domain_not_allowed', providerId });
  });

  it('refuses an unverified email, and a missing one', async () => {
    expect((await signIn(account('unverified', { email_verified: false }))).error).toBe('email_unverified');
    expect((await signIn({ sub: `noemail-${stamp}` })).error).toBe('email_missing');
  });

  it('enforces required claims', async () => {
    const current = await api().get(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).expect(200);
    const body = (requiredClaims: Array<{ claim: string; value: string }>) => ({
      name: current.body.name,
      buttonLabel: current.body.buttonLabel,
      enabled: true,
      oidc: { issuer: idp.issuer, clientId: idp.clientId, requiredClaims },
    });
    await api().put(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send(body([{ claim: 'hd', value: DOMAIN }])).expect(200);
    try {
      expect((await signIn(account('claims'))).error).toBe('claim_mismatch');
      expect((await signIn(account('claims', { claims: { hd: DOMAIN } }))).error).toBeNull();
    } finally {
      const reset = await api().put(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send(body([])).expect(200);
      expect(reset.body.provider.enabled).toBe(true);
    }
  });

  it('refuses another provider account that carries an already-linked email', async () => {
    expect((await signIn(account('linked'))).error).toBeNull();
    const result = await signIn({ ...account('linked'), sub: `impostor-${stamp}` });
    expect(result.error).toBe('subject_mismatch');
    const [row] = await ledger('LOGIN_FAILED', email('linked'));
    expect(row.details?.reason).toBe('subject_mismatch');
  });

  it('disables and enables a user: every method refused, sessions ended, then allowed again', async () => {
    const id = await addUser('leaver', 'User');
    const before = await signIn(account('leaver'));
    expect(await gatewayStatus(before.token!)).toBe(200);
    expect(await gatewayStatus(before.registryToken!)).toBe(200);

    const disabled = await api().patch(`/api/admin/users/${id}`).set(auth(admin)).send({ disabled: true }).expect(200);
    expect(disabled.body.status).toBe('disabled');
    expect(await gatewayStatus(before.token!)).toBe(401);
    expect(await gatewayStatus(before.registryToken!)).toBe(401);
    expect((await signIn(account('leaver'))).error).toBe('user_disabled');
    expect(await ledger('USER_DISABLED', email('leaver'))).toHaveLength(1);

    await api().patch(`/api/admin/users/${id}`).set(auth(admin)).send({ disabled: false }).expect(200);
    expect((await signIn(account('leaver'))).error).toBeNull();
  });

  it('promotes an auto-added user: old tokens stop, the next sign-in is Security', async () => {
    const first = await signIn(account('promoted'));
    expect(first.user?.role).toBe('User');
    const user = await app.db.getRepository(User).findOneByOrFail({ email: email('promoted') });
    const changed = await api().patch(`/api/admin/users/${user.id}`).set(auth(admin)).send({ role: 'Security' }).expect(200);
    expect(changed.body.role).toBe('Security');
    expect(await gatewayStatus(first.token!)).toBe(401);
    const [audit] = await ledger('USER_ROLE_CHANGED', email('promoted'));
    expect(audit.details).toMatchObject({ from: 'User', to: 'Security' });
    expect((await signIn(account('promoted'))).user?.role).toBe('Security');
  });

  it('signs a user out everywhere', async () => {
    const result = await signIn(account('revoked'));
    const user = await app.db.getRepository(User).findOneByOrFail({ email: email('revoked') });
    await api().post(`/api/admin/users/${user.id}/revoke-sessions`).set(auth(admin)).expect(204);
    expect(await gatewayStatus(result.registryToken!)).toBe(401);
    expect(await ledger('SESSIONS_REVOKED', email('revoked'))).toHaveLength(1);
    expect((await signIn(account('revoked'))).error).toBeNull();
  });

  it('ends existing sessions when the password is reset', async () => {
    const userId = await addUser('resetter', 'User');
    const result = await signIn(account('resetter'));
    const token = await issueToken(app.db, userId, 'reset');
    await api().post('/api/auth/set-password').send({ token, password: 'a-new-password-1' }).expect(200);
    expect(await gatewayStatus(result.token!)).toBe(401);
  });

  it('never gives an auto-added user a password, so removing them at the provider ends their access', async () => {
    const result = await signIn(account('sso-only'));
    const user = await app.db.getRepository(User).findOneByOrFail({ email: email('sso-only') });
    expect(user.source).toBe('sso');
    const token = await issueToken(app.db, user.id, 'reset');
    await api().post('/api/auth/set-password').send({ token, password: 'a-new-password-1' }).expect(400);
    expect((await app.db.getRepository(User).findOneByOrFail({ id: user.id })).passwordHash).toBeNull();
    expect(await gatewayStatus(result.token!)).toBe(200);
  });

  it('refuses a replayed callback and a reused exchange code', async () => {
    const result = await signIn(account('replay'));
    expect(result.error).toBeNull();
    const again = await api().get(result.callback!.pathname + result.callback!.search).redirects(0);
    expect(new URL(again.headers.location as string).searchParams.get('sso_error')).toBe('state_invalid');

    const fresh = await api().get(`/api/auth/sso/${providerId}/start`).redirects(0);
    idp.account = account('replay');
    const callback = await idp.authorize(fresh.headers.location as string);
    const back = await api().get(callback.pathname + callback.search).redirects(0);
    const code = new URL(back.headers.location as string).searchParams.get('code');
    await api().post('/api/auth/sso/exchange').send({ code }).expect(200);
    await api().post('/api/auth/sso/exchange').send({ code }).expect(400);
    await api().post('/api/auth/sso/exchange').send({ code: 'made-up-code-made-up-code' }).expect(400);
  });

  it('refuses a forged ID token and notes the error on the provider', async () => {
    idp.tamper = { aud: 'another-client' };
    const result = await signIn(account('forged'));
    expect(result.error).toBe('invalid_response');
    const provider = await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId });
    expect(provider.lastError).toMatch(/ID token|aud/i);
    expect((await signIn(account('forged'))).error).toBeNull();
    const healed = await app.db.getRepository(SsoProvider).findOneByOrFail({ id: providerId });
    expect(healed.lastError).toBeNull();
    expect(healed.lastSuccessAt).not.toBeNull();
  });

  it('keeps a same-origin return path and drops anything else', async () => {
    expect((await signIn(account('deeplink'), { returnTo: '/policies/123' })).returnTo).toBe('/policies/123');
    expect((await signIn(account('deeplink'), { returnTo: 'https://evil.example' })).returnTo).toBeNull();
    expect((await signIn(account('deeplink'), { returnTo: '//evil.example/x' })).returnTo).toBeNull();
  });

  it('records the session sign-in method on admin events (A3)', async () => {
    await addUser('auditor', 'Security');
    const result = await signIn(account('auditor'));
    const settings = await api().get('/api/admin/signin-settings').set(auth(result.token!)).expect(200);
    await api()
      .put('/api/admin/signin-settings')
      .set(auth(result.token!))
      .send({ allowedDomains: [...settings.body.allowedDomains, `extra-${stamp}.test`], allowUnlistedSso: true })
      .expect(200);
    await api()
      .put('/api/admin/signin-settings')
      .set(auth(result.token!))
      .send({ allowedDomains: settings.body.allowedDomains, allowUnlistedSso: true })
      .expect(200);
    const byAuditor = (rows: AuditEvent[]) => rows.some((row) => row.actorName === email('auditor'));
    const rows = await ledger('SIGNIN_SETTINGS_UPDATED', 'Sign-in settings', byAuditor);
    const mine = rows.find((row) => row.actorName === email('auditor'));
    expect(mine?.actorAuthMethod).toBe('oidc');
  });

  it('filters the ledger by sign-in method', async () => {
    const res = await api().get('/api/admin/audit-events').query({ type: 'SIGNIN_SUCCEEDED', authMethod: 'oidc', limit: '50' }).set(auth(admin)).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((row: { actor: { authMethod?: string }; details: { method?: string } }) => row.actor.authMethod === 'oidc' && row.details.method === 'oidc')).toBe(true);
  });

  it('stops offering a turned-off provider, and refuses to start it', async () => {
    await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: false }).expect(200);
    try {
      const list = await api().get('/api/auth/providers').expect(200);
      expect(list.body.find((p: { id: string }) => p.id === providerId)).toBeUndefined();
      expect((await signIn(account('off'))).error).toBe('provider_unavailable');
    } finally {
      await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: true }).expect(200);
    }
  });

  it('cannot be turned on without an allowed domain, and the last domain cannot be removed while on (R9)', async () => {
    await api().put('/api/admin/signin-settings').set(auth(admin)).send({ allowedDomains: [], allowUnlistedSso: true }).expect(400);
    // Other enabled providers in a shared database would block the empty list, so this part runs only when ours is alone.
    const enabled = await app.db.getRepository(SsoProvider).count({ where: { enabled: true } });
    if (enabled !== 1) return;
    const settings = await loadSigninSettings(app.db);
    await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: false }).expect(200);
    try {
      await api().put('/api/admin/signin-settings').set(auth(admin)).send({ allowedDomains: [], allowUnlistedSso: true }).expect(200);
      const refused = await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: true }).expect(400);
      expect(refused.body.error).toMatch(/allowed sign-in domain/);
    } finally {
      await saveSigninSettings(app.db, settings);
      await api().patch(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ enabled: true }).expect(200);
    }
  });

  it('keeps a provider that cannot be reached as a turned-off draft with the reason (R4)', async () => {
    const res = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ name: `sso-it unreachable ${stamp}`, enabled: true, oidc: { issuer: 'http://127.0.0.1:9', clientId: 'x', clientSecret: 'y' } })
      .expect(201);
    expect(res.body.provider.enabled).toBe(false);
    expect(res.body.validationError).toMatch(/Could not reach/);
    expect(res.body.provider.lastError).toMatch(/Could not reach/);
    await api().delete(`/api/admin/sso-providers/${res.body.provider.id}`).set(auth(admin)).expect(204);
  });

  it('refuses bad provider input', async () => {
    const bad = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ name: 'x', oidc: { issuer: 'http://idp.example.com', clientId: 'x', clientSecret: 'y' } })
      .expect(400);
    expect(bad.body.error).toMatch(/https/);
    const emptySaml = await api().post('/api/admin/sso-providers').set(auth(admin)).send({ type: 'saml', name: 'x', oidc: {} }).expect(400);
    expect(emptySaml.body.error).toMatch(/IdP entity ID/);
  });

  it('will not change a saved provider from OIDC to SAML', async () => {
    const res = await api().put(`/api/admin/sso-providers/${providerId}`).set(auth(admin)).send({ type: 'saml', name: 'x', saml: {} }).expect(400);
    expect(res.body.error).toMatch(/cannot change/);
  });

  it('hands out the URLs before the first save, and keeps the id on create', async () => {
    const setup = await api().get('/api/admin/sso-providers/setup').set(auth(admin)).expect(200);
    expect(setup.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(setup.body.urls.redirectUri).toMatch(new RegExp(`/api/auth/sso/${setup.body.id}/callback$`));
    expect(['setting', 'learned', 'default']).toContain(setup.body.publicUrlSource);

    // Typed without the trailing slash the provider publishes, or with one it does not: saved as published.
    const created = await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ id: setup.body.id, name: `sso-it slash ${stamp}`, oidc: { issuer: `${idp.issuer}/`, clientId: idp.clientId, clientSecret: idp.clientSecret } })
      .expect(201);
    expect(created.body.provider.id).toBe(setup.body.id);
    expect(created.body.provider.urls.redirectUri).toBe(setup.body.urls.redirectUri);
    expect(created.body.provider.oidc.issuer).toBe(idp.issuer);
    expect(created.body.provider.lastError).toBeNull();

    await api()
      .post('/api/admin/sso-providers')
      .set(auth(admin))
      .send({ id: setup.body.id, name: `sso-it dup ${stamp}`, oidc: { issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret } })
      .expect(409);
    await api().delete(`/api/admin/sso-providers/${setup.body.id}`).set(auth(admin)).expect(204);
  });

  it('discovers a provider for the form', async () => {
    const res = await api().post('/api/admin/sso-providers/discover').set(auth(admin)).send({ issuer: idp.issuer }).expect(200);
    expect(res.body).toMatchObject({ issuer: idp.issuer, tokenEndpoint: `${idp.issuer}/token`, signingAlgs: ['RS256'] });
    const slash = await api().post('/api/admin/sso-providers/discover').set(auth(admin)).send({ issuer: `${idp.issuer}/` }).expect(200);
    expect(slash.body.issuer).toBe(idp.issuer);
    await api().post('/api/admin/sso-providers/discover').set(auth(admin)).send({ issuer: `${idp.issuer}/nope` }).expect(400);
  });

  it('tests a provider without signing anyone in or creating anything (R5)', async () => {
    const ticketRes = await api().post(`/api/admin/sso-providers/${providerId}/test`).set(auth(admin)).expect(200);
    const { ticket, startUrl } = ticketRes.body as { ticket: string; startUrl: string };
    expect((await api().get(`/api/admin/sso-providers/test/${ticket}`).set(auth(admin)).expect(200)).body).toEqual({ status: 'pending' });

    idp.account = account('tester');
    const start = await api().get(startUrl).redirects(0).expect(302);
    const callback = await idp.authorize(start.headers.location as string);
    const back = await api().get(callback.pathname + callback.search).redirects(0).expect(302);
    expect(new URL(back.headers.location as string).pathname).toBe('/sso-test-done');

    const result = await api().get(`/api/admin/sso-providers/test/${ticket}`).set(auth(admin)).expect(200);
    expect(result.body).toMatchObject({ status: 'done', ok: true, subject: `tester-${stamp}`, email: email('tester') });
    expect(result.body.outcome).toMatch(/Would add this person/);
    expect(result.body.claims.email).toBe(email('tester'));
    expect(await app.db.getRepository(User).count({ where: { email: email('tester') } })).toBe(0);
    expect(await app.db.getRepository(UserIdentity).count({ where: { subject: `tester-${stamp}` } })).toBe(0);

    // The ticket works once.
    const reuse = await api().get(startUrl).redirects(0).expect(302);
    expect(new URL(reuse.headers.location as string).pathname).toBe('/sso-test-done');
  });

  it('cannot change your own role or disable yourself', async () => {
    const self = await app.db.getRepository(User).findOneByOrFail({ email: adminEmail });
    await api().patch(`/api/admin/users/${self.id}`).set(auth(admin)).send({ disabled: true }).expect(400);
    await api().patch(`/api/admin/users/${self.id}`).set(auth(admin)).send({ role: 'User' }).expect(400);
  });

  describe('password sign-in', () => {
    it('records successful and failed sign-ins', async () => {
      await api().post('/api/auth/login').send({ email: email('nobody'), password: 'whatever' }).expect(401);
      const [missing] = await ledger('LOGIN_FAILED', email('nobody'));
      expect(missing.details).toMatchObject({ method: 'password', reason: 'no_account' });

      const id = await addUser('pw', 'User');
      const token = await issueToken(app.db, id, 'invite');
      await api().post('/api/auth/set-password').send({ token, password: 'pw-password-1' }).expect(200);
      await api().post('/api/auth/login').send({ email: email('pw'), password: 'wrong-password' }).expect(401);
      const [bad] = await ledger('LOGIN_FAILED', email('pw'));
      expect(bad.details?.reason).toBe('bad_password');
      const ok = await api().post('/api/auth/login').send({ email: email('pw'), password: 'pw-password-1' }).expect(200);
      expect(ok.body.user).toEqual({ email: email('pw'), role: 'User' });
      const [good] = await ledger('LOGIN_SUCCEEDED', email('pw'));
      expect(good.details).toMatchObject({ method: 'password', role: 'User' });

      await api().patch(`/api/admin/users/${id}`).set(auth(admin)).send({ disabled: true }).expect(200);
      const refused = await api().post('/api/auth/login').send({ email: email('pw'), password: 'pw-password-1' }).expect(403);
      expect(refused.body.error).toMatch(/disabled/);
    });

    it('limits failed sign-ins per email, not successful ones', async () => {
      const saved = config.auth.loginFailuresPerEmail;
      config.auth.loginFailuresPerEmail = 3;
      try {
        for (let i = 0; i < 3; i++) await api().post('/api/auth/login').send({ email: email('locked'), password: 'x' }).expect(401);
        await api().post('/api/auth/login').send({ email: email('locked'), password: 'x' }).expect(429);
        const limited = (rows: AuditEvent[]) => rows.some((row) => row.details?.reason === 'rate_limited');
        expect(limited(await ledger('LOGIN_FAILED', email('locked'), limited))).toBe(true);
      } finally {
        config.auth.loginFailuresPerEmail = saved;
      }
    });

    it('caps failed sign-ins written to the ledger per IP (A1)', async () => {
      const saved = config.auth.loginFailureAuditPerMinute;
      config.auth.loginFailureAuditPerMinute = 5;
      const target = email('flood');
      try {
        for (let i = 0; i < 12; i++) await api().post('/api/auth/login').send({ email: target, password: 'x' }).expect(401);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const rows = (await auditRows(app.db, { type: 'SIGNIN_FAILED', targetName: target }, 100)).length;
        expect(rows).toBeLessThanOrEqual(5);
        expect(rows).toBeGreaterThan(0);
      } finally {
        config.auth.loginFailureAuditPerMinute = saved;
      }
    });
  });
});
