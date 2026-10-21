/**
 * Identity and token authorization. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { User } from '../db/entities/User.js';
import { hashPassword } from '../services/auth.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Account authorization', () => {
  let app: FastifyInstance;
  let securityToken: string;
  let userToken: string;
  let userId: string;
  const username = `auth-user-${Date.now()}@depgate.local`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const candidates = [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'apikeytest@depgate.local', password: 'apikeytest123' },
      { email: 'admin@depgate.local', password: 'admin' },
    ];
    for (const creds of candidates) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200) {
        securityToken = res.body.token;
        break;
      }
    }
    if (!securityToken) throw new Error('Could not obtain auth token');

    const passwordHash = await hashPassword('user-pass-123');
    const user = await app.db.getRepository(User).save(
      app.db.getRepository(User).create({ email: username, passwordHash, role: 'User' })
    );
    userId = user.id;
    const userLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: username, password: 'user-pass-123' })
      .expect(200);
    userToken = userLogin.body.token;
  });

  afterAll(async () => {
    if (!app) return;
    if (userId) await app.db.getRepository(User).delete({ id: userId });
    await app.close();
  });

  it('rejects role-bearing API keys', async () => {
    await supertest(app.server)
      .post('/api/admin/api-keys')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ name: 'Test key', role: 'Security' })
      .expect(403);
  });

  it('lets Security create a service account that alone can mint a CI token', async () => {
    const created = await supertest(app.server)
      .post('/api/admin/service-accounts')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ name: 'pipeline' })
      .expect(201);
    expect(created.body.key).toMatch(/^dgk_/);

    await supertest(app.server)
      .post('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ name: 'job', expiresIn: '30m' })
      .expect(403);

    await supertest(app.server)
      .post('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'job', expiresIn: '30m' })
      .expect(403);

    const minted = await supertest(app.server)
      .post('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${created.body.key}`)
      .send({ name: 'job', expiresIn: '30m', metadata: { build_number: '1' } })
      .expect(201);
    expect(minted.body.token).toBeTruthy();

    await supertest(app.server)
      .get('/api/admin/policies?limit=1')
      .set('Authorization', `Bearer ${created.body.key}`)
      .expect(403);

    await supertest(app.server)
      .get('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${created.body.key}`)
      .expect(403);

    await supertest(app.server)
      .get('/api/admin/service-accounts')
      .set('Authorization', `Bearer ${created.body.key}`)
      .expect(403);

    const ciPayload = JSON.parse(Buffer.from(minted.body.token.split('.')[1], 'base64url').toString()) as {
      role: string;
      type: string;
    };
    expect(ciPayload).toMatchObject({ role: 'User', type: 'ci' });

    await supertest(app.server)
      .get('/api/admin/policies?limit=1')
      .set('Authorization', `Bearer ${minted.body.token}`)
      .expect(403);

    await supertest(app.server)
      .post('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${minted.body.token}`)
      .send({ name: 'nested', expiresIn: '30m' })
      .expect(403);

    const list = await supertest(app.server)
      .get('/api/admin/ci-tokens')
      .set('Authorization', `Bearer ${securityToken}`)
      .expect(200);
    expect(list.body.items.some((row: { id: string }) => row.id === minted.body.id)).toBe(true);

    await supertest(app.server)
      .delete(`/api/admin/ci-tokens/${minted.body.id}`)
      .set('Authorization', `Bearer ${securityToken}`)
      .expect(204);

    await supertest(app.server)
      .delete(`/api/admin/service-accounts/${created.body.id}`)
      .set('Authorization', `Bearer ${securityToken}`)
      .expect(204);
  });

  it('lets a User read registry config and blocks admin APIs', async () => {
    await supertest(app.server)
      .get('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    await supertest(app.server)
      .get('/api/admin/repositories')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    await supertest(app.server)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);

    const forbidden = [
      '/api/admin/policies?limit=1',
      '/api/admin/audit-logs',
      '/api/admin/webhooks',
      '/api/admin/malicious-packages',
      '/api/admin/exceptions',
      '/api/admin/users',
      '/api/admin/service-accounts',
      '/api/admin/ci-tokens',
      '/api/admin/upstream-registries',
    ];
    for (const path of forbidden) {
      await supertest(app.server).get(path).set('Authorization', `Bearer ${userToken}`).expect(403);
    }

    await supertest(app.server)
      .patch('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ sessionTokenDays: 30 })
      .expect(403);

    await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        name: 'user cannot write',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['left-pad'] },
      })
      .expect(403);
  });

  it('maps a legacy Admin row to Security at login and rejects a bad password', async () => {
    await app.db.query(`UPDATE users SET role = 'Admin' WHERE id = $1`, [userId]);
    const login = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: username, password: 'user-pass-123' })
      .expect(200);
    expect(login.body.user.role).toBe('Security');
    await app.db.query(`UPDATE users SET role = 'User' WHERE id = $1`, [userId]);

    await supertest(app.server)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ email: 'not-an-email', role: 'User' })
      .expect(400);

    await supertest(app.server)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ email: username, role: 'User' })
      .expect(409);

    await supertest(app.server)
      .post('/api/admin/service-accounts')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ name: ' ' })
      .expect(400);
  });

  it('lets Security create another user and refuses to delete the signed-in account', async () => {
    const created = await supertest(app.server)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${securityToken}`)
      .send({ email: `sec-${Date.now()}@depgate.local`, role: 'Security' })
      .expect(201);
    expect(created.body.role).toBe('Security');

    await supertest(app.server)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ email: `nope-${Date.now()}@depgate.local`, role: 'User' })
      .expect(403);

    const payload = JSON.parse(Buffer.from(securityToken.split('.')[1], 'base64url').toString()) as { sub: string };
    await supertest(app.server)
      .delete(`/api/admin/users/${payload.sub}`)
      .set('Authorization', `Bearer ${securityToken}`)
      .expect(400);

    await supertest(app.server)
      .delete(`/api/admin/users/${created.body.id}`)
      .set('Authorization', `Bearer ${securityToken}`)
      .expect(204);
  });
});
