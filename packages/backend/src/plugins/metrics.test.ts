import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import metricsPlugin from './metrics.js';

describe('metrics plugin', () => {
  let app: Awaited<ReturnType<typeof Fastify>>;

  beforeEach(async () => {
    app = Fastify();
    await app.register(metricsPlugin);
  });

  it('GET /metrics returns Prometheus format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).toContain('depgate_decisions_total');
    expect(res.payload).toContain('depgate_requests_total');
  });

  it('decorates fastify with metrics.recordDecision', () => {
    expect(app.metrics).toBeDefined();
    expect(typeof app.metrics.recordDecision).toBe('function');
    expect(typeof app.metrics.recordRequest).toBe('function');
    app.metrics.recordDecision('ALLOW');
    app.metrics.recordDecision('BLOCK');
  });
});
