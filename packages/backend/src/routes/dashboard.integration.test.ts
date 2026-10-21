/**
 * Dashboard stats API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { countDecision, flushSummaries, pushCounts } from '../services/events/summary.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Dashboard routes', () => {
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

  it('GET /api/admin/dashboard/stats returns stats', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/dashboard/stats')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(typeof response.body.total).toBe('number');
    expect(typeof response.body.allow).toBe('number');
    expect(typeof response.body.block).toBe('number');
  });

  it('GET /api/admin/dashboard/stats accepts range param', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/dashboard/stats?range=24h')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(typeof response.body.total).toBe('number');
  });

  it('GET /api/admin/dashboard/stats returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/dashboard/stats').expect(401);
  });

  it('GET /api/admin/dashboard/charts returns chart data', async () => {
    // Charts read the hourly summary tables; allowed downloads are not stored row by row.
    const marker = `dashboard-test-${Date.now()}`;
    try {
      countDecision('npm', marker, `${marker}-npm`, 'ALLOW');
      countDecision('config', marker, `${marker}-config`, 'ALLOW');
      await pushCounts(app.redis);
      await flushSummaries(app.db, app.redis);

      const response = await supertest(app.server)
        .get('/api/admin/dashboard/charts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(response.body.topPackagesAllowed)).toBe(true);
      expect(Array.isArray(response.body.topPackagesBlocked)).toBe(true);
      expect(Array.isArray(response.body.byEcosystem)).toBe(true);
      expect(response.body.byEcosystem.some((row: { ecosystem: string }) => row.ecosystem === 'config')).toBe(false);
      expect(response.body.byEcosystem.some((row: { ecosystem: string }) => row.ecosystem === 'npm')).toBe(true);
    } finally {
      await app.db.query('DELETE FROM decision_counts_hourly WHERE repository = $1', [marker]);
      await app.db.query('DELETE FROM package_counts_hourly WHERE package_name LIKE $1', [`${marker}-%`]);
    }
  });
});
