/**
 * Invitations, password reset and SMTP settings. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { User } from '../db/entities/User.js';
import { AuthToken } from '../db/entities/AuthToken.js';
import { MailSettings } from '../db/entities/MailSettings.js';
import { setMailSender, type OutgoingMail } from '../services/mailer.js';
import { issueToken } from '../services/auth-tokens.js';
import { hashPassword } from '../services/auth.js';
import { clearSsoPasswords } from '../services/sso-schema.js';

function tokenFrom(mail: OutgoingMail): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!match) throw new Error('no token in email');
  return match[1];
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Invitations and password reset', () => {
  let app: FastifyInstance;
  let admin: string;
  let adminCreds = { email: 'testadmin@depgate.local', password: 'testpass123' };
  const sent: OutgoingMail[] = [];
  const created: string[] = [];
  const email = `invitee-${Date.now()}@depgate.local`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const creds of [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'admin@depgate.local', password: 'admin' },
    ]) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200) {
        admin = res.body.token;
        adminCreds = creds;
        break;
      }
    }
    if (!admin) throw new Error('Could not obtain auth token');
  });

  beforeEach(async () => {
    // Repeated runs from one IP would otherwise exhaust the hourly limits.
    const keys = await app.redis.keys('rl:*');
    if (keys.length) await app.redis.del(...keys);
    sent.length = 0;
    setMailSender(async (mail) => {
      sent.push(mail);
    });
  });

  afterAll(async () => {
    setMailSender(null);
    if (!app) return;
    for (const id of created) {
      await app.db.getRepository(AuthToken).delete({ userId: id });
      await app.db.getRepository(User).delete({ id });
    }
    await app.db.getRepository(MailSettings).delete({ id: 'default' });
    await app.close();
  });

  const post = (path: string, body: object, token?: string) => {
    const req = supertest(app.server).post(path);
    return token ? req.set('Authorization', `Bearer ${token}`).send(body) : req.send(body);
  };

  it('creates an invited user without a password and emails a link', async () => {
    const res = await post('/api/admin/users', { email: email.toUpperCase(), role: 'User' }, admin).expect(201);
    created.push(res.body.id);
    expect(res.body).toMatchObject({ email, status: 'invited', emailSent: true });
    expect(res.body.inviteUrl).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].text).toContain('/set-password?token=');

    // Cannot sign in before accepting.
    await post('/api/auth/login', { email, password: 'anything-123' }).expect(401);
    const list = await supertest(app.server).get('/api/admin/users').query({ search: email }).set('Authorization', `Bearer ${admin}`).expect(200);
    expect(list.body.items.find((u: { email: string }) => u.email === email).status).toBe('invited');
  });

  it('shows the token owner, rejects a short password, then accepts the invite once', async () => {
    const token = tokenFrom(sent.length ? sent[0] : (await resend()));
    const info = await supertest(app.server).get('/api/auth/token-info').query({ token }).expect(200);
    expect(info.body).toEqual({ email, purpose: 'invite' });

    await post('/api/auth/set-password', { token, password: 'short' }).expect(400);
    await post('/api/auth/set-password', { token, password: 'first-password-1' }).expect(200);
    await post('/api/auth/login', { email, password: 'first-password-1' }).expect(200);

    // The link is single-use.
    await post('/api/auth/set-password', { token, password: 'second-password-1' }).expect(400);
    await supertest(app.server).get('/api/auth/token-info').query({ token }).expect(404);
  });

  /** Reset emails are sent by the email worker, so a test waits for them. */
  async function mailCount(count: number): Promise<void> {
    for (let i = 0; i < 100 && sent.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    // Room for a stray extra message to show up and fail the assertion.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async function resend(): Promise<OutgoingMail> {
    const id = created[0];
    await post(`/api/admin/users/${id}/resend-invite`, {}, admin);
    return sent[sent.length - 1];
  }

  it('refuses to resend an invitation to a user who already has a password', async () => {
    await post(`/api/admin/users/${created[0]}/resend-invite`, {}, admin).expect(409);
  });

  it('answers forgot-password the same for known and unknown addresses', async () => {
    const known = await post('/api/auth/forgot-password', { email }).expect(200);
    const unknown = await post('/api/auth/forgot-password', { email: `nobody-${Date.now()}@depgate.local` }).expect(200);
    expect(known.body).toEqual(unknown.body);
    await mailCount(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].subject).toContain('Reset');
  });

  it('resets the password with the emailed link and invalidates the older link', async () => {
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(1);
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(2);
    expect(sent).toHaveLength(2);
    const [older, newer] = sent.map(tokenFrom);

    await post('/api/auth/set-password', { token: older, password: 'reset-password-1' }).expect(400);
    await post('/api/auth/set-password', { token: newer, password: 'reset-password-1' }).expect(200);
    await post('/api/auth/login', { email, password: 'first-password-1' }).expect(401);
    await post('/api/auth/login', { email, password: 'reset-password-1' }).expect(200);
  });

  it('rejects an expired link', async () => {
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(1);
    const token = tokenFrom(sent[0]);
    await app.db.getRepository(AuthToken).update({ userId: created[0] }, { expiresAt: new Date(Date.now() - 1000) });
    await post('/api/auth/set-password', { token, password: 'late-password-1' }).expect(400);
  });

  it('lets an admin email a password reset without ever seeing the link', async () => {
    const res = await post(`/api/admin/users/${created[0]}/send-reset`, {}, admin).expect(200);
    expect(res.body).toEqual({ sentTo: email });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].subject).toContain('Reset');
    const token = tokenFrom(sent[0]);
    expect(JSON.stringify(res.body)).not.toContain(token);
    const info = await supertest(app.server).get('/api/auth/token-info').query({ token }).expect(200);
    expect(info.body).toEqual({ email, purpose: 'reset' });

    // Only Security may send one, and only to someone who has a password.
    const user = await post('/api/auth/login', { email, password: 'reset-password-1' }).expect(200);
    await post(`/api/admin/users/${created[0]}/send-reset`, {}, user.body.token).expect(403);
    await supertest(app.server).post(`/api/admin/users/${created[0]}/send-reset`).expect(401);
  });

  describe('an account created by single sign-on', () => {
    const ssoEmail = `sso-only-${Date.now()}@depgate.local`;
    let ssoUser: User;

    beforeAll(async () => {
      const repo = app.db.getRepository(User);
      ssoUser = await repo.save(repo.create({ email: ssoEmail, passwordHash: null, role: 'User', source: 'sso' }));
      created.push(ssoUser.id);
    });

    it('gets no email from forgot-password, and the same answer as anyone else', async () => {
      const known = await post('/api/auth/forgot-password', { email: ssoEmail }).expect(200);
      const unknown = await post('/api/auth/forgot-password', { email: `nobody-${Date.now()}@depgate.local` }).expect(200);
      expect(known.body).toEqual(unknown.body);
      await mailCount(1);
      expect(sent).toHaveLength(0);
    });

    it('cannot redeem a link issued for it', async () => {
      const token = await issueToken(app.db, ssoUser.id, 'invite');
      await supertest(app.server).get('/api/auth/token-info').query({ token }).expect(404);
      await post('/api/auth/set-password', { token, password: 'sso-password-1' }).expect(400);
      const row = await app.db.getRepository(User).findOneByOrFail({ id: ssoUser.id });
      expect(row.passwordHash).toBeNull();
    });

    it('is not sent an invitation or a password reset by an admin', async () => {
      await post(`/api/admin/users/${ssoUser.id}/resend-invite`, {}, admin).expect(409);
      await post(`/api/admin/users/${ssoUser.id}/send-reset`, {}, admin).expect(409);
      expect(sent).toHaveLength(0);
    });

    it('cannot sign in with a password it was given before, and loses it at startup', async () => {
      const repo = app.db.getRepository(User);
      await repo.update({ id: ssoUser.id }, { passwordHash: await hashPassword('old-sso-password-1') });
      const res = await post('/api/auth/login', { email: ssoEmail, password: 'old-sso-password-1' }).expect(403);
      expect(res.body.error).toContain('single sign-on');

      const before = await repo.findOneByOrFail({ id: ssoUser.id });
      expect(await clearSsoPasswords(app.db)).toBeGreaterThanOrEqual(1);
      const after = await repo.findOneByOrFail({ id: ssoUser.id });
      expect(after.passwordHash).toBeNull();
      expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    });
  });

  it('hands the admin the link when mail cannot be sent', async () => {
    setMailSender(async () => {
      throw new Error('smtp down');
    });
    const res = await post('/api/admin/users', { email: `nomail-${Date.now()}@depgate.local`, role: 'User' }, admin).expect(201);
    created.push(res.body.id);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.inviteUrl).toContain('/set-password?token=');
  });

  it('keeps the SMTP password secret and keeps it when omitted on save', async () => {
    const put = (body: object) => supertest(app.server).put('/api/admin/mail-settings').set('Authorization', `Bearer ${admin}`).send(body);
    const saved = await put({ host: 'smtp.example.com', port: 465, secure: true, user: 'mailer', password: 's3cret', from: 'DepGate <no-reply@example.com>' }).expect(200);
    expect(saved.body).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, hasPassword: true, source: 'ui' });
    expect(JSON.stringify(saved.body)).not.toContain('s3cret');
    const row = await app.db.getRepository(MailSettings).findOneByOrFail({ id: 'default' });
    expect(row.passwordEnc).not.toContain('s3cret');

    const again = await put({ host: 'smtp.example.com', port: 587, user: 'mailer', from: 'DepGate <no-reply@example.com>' }).expect(200);
    expect(again.body.hasPassword).toBe(true);

    await put({ host: 'bad host!', from: 'a@b.co' }).expect(400);
    await supertest(app.server).get('/api/admin/mail-settings').expect(401);
  });

  it('points email links at the address a Security admin signed in from', async () => {
    const url = (mail: OutgoingMail) => /(https?:\/\/[^\s]+)\/set-password/.exec(mail.text)![1];
    await app.db.getRepository(MailSettings).delete({ id: 'default' });

    // A forged Host or Origin on the unauthenticated request changes nothing.
    await supertest(app.server).post('/api/auth/forgot-password').set('Host', 'evil.example').set('Origin', 'https://evil.example').send({ email });
    await mailCount(1);
    expect(url(sent[0])).not.toContain('evil.example');

    // A Security sign-in teaches it.
    await supertest(app.server)
      .post('/api/auth/login')
      .set('Origin', 'https://gate.example.com')
      .send(adminCreds);
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(2);
    expect(url(sent[sent.length - 1])).toBe('https://gate.example.com');

    // A later Security sign-in from another address replaces it. A User sign-in does not.
    await supertest(app.server).post('/api/auth/login').set('Origin', 'https://depgate.corp.example').send(adminCreds);
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(3);
    expect(url(sent[sent.length - 1])).toBe('https://depgate.corp.example');
    await supertest(app.server).post('/api/auth/login').set('Origin', 'https://user.example').send({ email, password: 'reset-password-1' });
    await post('/api/auth/forgot-password', { email }).expect(200);
    await mailCount(4);
    expect(url(sent[sent.length - 1])).toBe('https://depgate.corp.example');
  });

  it('sends a test email to the signed-in admin only', async () => {
    await supertest(app.server).put('/api/admin/mail-settings').set('Authorization', `Bearer ${admin}`)
      .send({ host: 'smtp.example.com', port: 587, from: 'DepGate <no-reply@example.com>' }).expect(200);
    const res = await supertest(app.server).post('/api/admin/mail-settings/test').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(res.body.sentTo);
  });
});
