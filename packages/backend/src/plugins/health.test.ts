import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe('Health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ skipInfra: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns 200 with status ok', async () => {
    const response = await supertest(app.server)
      .get('/healthz')
      .expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /readyz returns 200 with status ready (skipInfra)', async () => {
    const response = await supertest(app.server)
      .get('/readyz')
      .expect(200);

    expect(response.body).toEqual({ status: 'ready' });
  });

  it('GET /healthz returns correct content-type', async () => {
    const response = await supertest(app.server)
      .get('/healthz')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('GET /nonexistent returns 404', async () => {
    await supertest(app.server)
      .get('/nonexistent')
      .expect(404);
  });
});
