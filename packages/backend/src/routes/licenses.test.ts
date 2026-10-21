import { describe, it, expect } from 'vitest';
import { buildApp } from '../app.js';

describe('licenses routes', () => {
  it('GET /api/licenses returns all licenses', async () => {
    const app = await buildApp({ skipInfra: true });
    const res = await app.inject({ method: 'GET', url: '/api/licenses' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(90);
    expect(body[0]).toHaveProperty('name');
    expect(body[0]).toHaveProperty('spdxId');
    expect(body[0]).toHaveProperty('category');
  });

  it('GET /api/licenses?q=MIT returns filtered licenses', async () => {
    const app = await buildApp({ skipInfra: true });
    const res = await app.inject({ method: 'GET', url: '/api/licenses?q=MIT' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((l: { spdxId: string }) => l.spdxId === 'MIT')).toBe(true);
  });
});
