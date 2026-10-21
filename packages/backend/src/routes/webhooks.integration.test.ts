/**
 * Webhooks API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe.skipIf(!process.env.RUN_INTEGRATION)('Webhooks routes', () => {
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

  it('GET /api/admin/webhooks returns list', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
  });

  it('POST /api/admin/webhooks creates webhook', async () => {
    const response = await supertest(app.server)
      .post('/api/admin/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        url: 'https://example.com/webhook',
        secret: 'test-secret',
        events: ['package_blocked', 'malware_requested'],
      })
      .expect(201);

    expect(response.body.id).toBeDefined();
    expect(response.body.url).toBe('https://example.com/webhook');
    expect(response.body.secretConfigured).toBe(true);
    expect(response.body.events).toContain('package_blocked');
  });

  it('GET /api/admin/webhooks returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/webhooks').expect(401);
  });
});
