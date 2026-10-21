/**
 * Integration tests for database + Redis + readyz.
 * Requires PostgreSQL and Redis to be running (e.g. docker compose up -d postgres redis).
 * Run with: npm test -- --run database.integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { Policy } from '../db/entities/index.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Database integration', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('GET /readyz returns 200 when DB and Redis are available', async () => {
    const response = await supertest(app.server)
      .get('/readyz')
      .expect(200);

    expect(response.body).toMatchObject({ status: 'ready', queues: 'ok', evictionPolicy: 'noeviction' });
  });

  it('can query database', async () => {
    const count = await app.db.getRepository(Policy).count();
    expect(typeof count).toBe('number');
  });
});
