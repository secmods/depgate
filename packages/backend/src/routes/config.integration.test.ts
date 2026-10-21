/**
 * Config gateway API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe.skipIf(!process.env.RUN_INTEGRATION)('Config gateway routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const candidates = [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ];
    for (const creds of candidates) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200) {
        token = res.body.token;
        break;
      }
    }
    if (!token) throw new Error('Could not obtain auth token');
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('GET /api/admin/config/gateway returns baseUrl and gateway toggles', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.baseUrl).toBeDefined();
    expect(typeof response.body.baseUrl).toBe('string');
    expect(response.body).not.toHaveProperty('strictTokenMode');
    expect(response.body).not.toHaveProperty('streamThroughIntegrity');
    expect(response.body).not.toHaveProperty('strictIntegrityMode');
    expect(response.body.sessionTokenDays).toBeGreaterThanOrEqual(1);
    expect(response.body.sessionTokenDays).toBeLessThanOrEqual(365);
  });

  it('PATCH /api/admin/config/gateway returns 401 without auth', async () => {
    await supertest(app.server)
      .patch('/api/admin/config/gateway')
      .send({ sessionTokenDays: 30 })
      .expect(401);
  });

  it('PATCH /api/admin/config/gateway updates the registry token lifetime', async () => {
    const getRes = await supertest(app.server)
      .get('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const initial = getRes.body.sessionTokenDays;

    const patchRes = await supertest(app.server)
      .patch('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionTokenDays: 45 })
      .expect(200);
    expect(patchRes.body.sessionTokenDays).toBe(45);

    await supertest(app.server)
      .patch('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionTokenDays: 0 })
      .expect(400);

    await supertest(app.server)
      .patch('/api/admin/config/gateway')
      .set('Authorization', `Bearer ${token}`)
      .send({ sessionTokenDays: initial })
      .expect(200);
  });

  it('GET /api/admin/config/gateway returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/config/gateway').expect(401);
  });

});
