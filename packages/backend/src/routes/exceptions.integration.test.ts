/**
 * Exceptions API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe.skipIf(!process.env.RUN_INTEGRATION)('Exceptions routes', () => {
  let app: FastifyInstance;
  let token: string;
  let createdId: string;

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

  it('GET /api/admin/exceptions returns list', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body.items)).toBe(true);
    expect(typeof response.body.total).toBe('number');
    expect(response.body.active + response.body.expired).toBe(response.body.total);
  });

  it('POST /api/admin/exceptions creates exception', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const response = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: 'test-exception-pkg-' + Date.now(),
        ecosystem: 'npm',
        version: '1.0.0',
        expiresAt,
        reason: 'Test exception',
      })
      .expect(201);

    expect(response.body.id).toBeDefined();
    expect(response.body.packageName).toContain('test-exception-pkg-');
    expect(response.body.ecosystem).toBe('npm');
    expect(response.body.version).toBe('1.0.0');
    expect(response.body.approvedBy).toBeDefined();
    createdId = response.body.id;
  });

  it('POST /api/admin/exceptions creates exception with multiple version ranges', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const response = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: 'multi-range-pkg-' + Date.now(),
        ecosystem: 'npm',
        version: '1.0.0 - 2.1.0 || 3.1.0 - 4.0.0',
        expiresAt,
      })
      .expect(201);

    expect(response.body.version).toBe('1.0.0 - 2.1.0 || 3.1.0 - 4.0.0');
  });

  it('GET /api/admin/exceptions filters by ecosystem', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/exceptions?ecosystem=npm')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items.every((e: { ecosystem: string }) => e.ecosystem === 'npm')).toBe(true);
  });

  it('GET /api/admin/exceptions pages with limit and offset', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/exceptions?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.items.length).toBeLessThanOrEqual(1);
    expect(response.body.total).toBeGreaterThanOrEqual(response.body.items.length);
  });

  it('DELETE /api/admin/exceptions/:id revokes exception', async () => {
    await supertest(app.server)
      .delete(`/api/admin/exceptions/${createdId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('DELETE /api/admin/exceptions/:id returns 404 for unknown id', async () => {
    await supertest(app.server)
      .delete('/api/admin/exceptions/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('GET /api/admin/exceptions returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/exceptions').expect(401);
  });
});
