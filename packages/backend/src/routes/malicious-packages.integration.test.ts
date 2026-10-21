/**
 * Malicious packages API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Malicious packages routes', () => {
  let app: FastifyInstance;
  let token: string;
  let maliciousId: string;

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

    const pkg = app.db.getRepository(MaliciousPackage).create({
      name: 'test-malicious-pkg-' + Date.now(),
      ecosystem: 'npm',
      reason: 'Test malicious entry',
      sourceUrl: 'https://example.com',
      source: 'custom',
      overrideStatus: 'BLOCK',
    });
    const saved = await app.db.getRepository(MaliciousPackage).save(pkg);
    maliciousId = saved.id;
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('GET /api/admin/malicious-packages returns list', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.items).toBeDefined();
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(typeof response.body.total).toBe('number');
  });

  it('GET /api/admin/malicious-packages filters by ecosystem', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/malicious-packages?ecosystem=npm')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.items.every((m: { ecosystem: string }) => m.ecosystem === 'npm')).toBe(
      true
    );
  });

  it('PUT /api/admin/malicious-packages/:id/override updates override', async () => {
    const response = await supertest(app.server)
      .put(`/api/admin/malicious-packages/${maliciousId}/override`)
      .set('Authorization', `Bearer ${token}`)
      .send({ overrideStatus: 'ALLOW', overrideReason: 'False positive' })
      .expect(200);

    expect(response.body.overrideStatus).toBe('ALLOW');
    expect(response.body.overrideReason).toBe('False positive');
  });

  it('POST /api/admin/malicious-packages/sync starts sync in background', async () => {
    const response = await supertest(app.server)
      .post('/api/admin/malicious-packages/sync')
      .set('Authorization', `Bearer ${token}`);

    // Sync can legitimately return 409 if another sync is currently running.
    expect([202, 409]).toContain(response.status);
    if (response.status === 202) {
      expect(response.body.started).toBe(true);
    } else {
      expect(response.body.error).toBeDefined();
    }
  });

  it('GET /api/admin/malicious-packages returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/malicious-packages').expect(401);
  });
});
