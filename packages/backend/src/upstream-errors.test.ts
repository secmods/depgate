import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { UpstreamUnavailableError } from './services/upstream-provider.js';

const REMOTE = { id: '11111111-1111-4111-8111-111111111111', key: 'default' };

/** Upstream failures thrown where a route has no catch, as when policy evaluation probes the remotes. */
describe('root error handler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ skipInfra: true });
    // A plugin of its own, like the registry routes, so the handler is inherited, not local.
    await app.register(async (routes) => {
      routes.get('/test/breaker-open', async () => {
        throw new UpstreamUnavailableError('cargo', REMOTE, 'circuit breaker open', 2500);
      });
      routes.get('/test/timed-out', async () => {
        throw new UpstreamUnavailableError('cargo', REMOTE, 'timed out after 30000 ms');
      });
      routes.get('/test/remembered-open', async () => {
        throw Object.assign(new Error('Upstream cargo/default is unavailable: circuit breaker open'), { retryAfterSeconds: 4 });
      });
      routes.get('/test/bug', async () => {
        throw new Error('something else broke');
      });
      routes.get('/test/bad-request', async () => {
        throw Object.assign(new Error('bad input'), { statusCode: 400 });
      });
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers an open breaker with 503 and Retry-After', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/breaker-open' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('3');
    expect(res.json()).toEqual({ error: 'Upstream cargo/default is unavailable: circuit breaker open' });
  });

  it('answers a remembered open-breaker failure with 503 too', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/remembered-open' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('4');
  });

  it('answers any other upstream failure with 502', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/timed-out' });
    expect(res.statusCode).toBe(502);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.json().error).toContain('timed out');
  });

  it('leaves every other error to the default handler', async () => {
    const bug = await app.inject({ method: 'GET', url: '/test/bug' });
    expect(bug.statusCode).toBe(500);
    expect(bug.json()).toMatchObject({ statusCode: 500, error: 'Internal Server Error', message: 'something else broke' });

    const bad = await app.inject({ method: 'GET', url: '/test/bad-request' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ statusCode: 400, message: 'bad input' });
  });
});
