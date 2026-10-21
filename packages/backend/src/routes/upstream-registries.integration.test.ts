/**
 * Upstream registries integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { parseAuth } from '../services/upstream-provider.js';
import { ensureUpstreamAuthEncrypted } from '../services/upstream-auth-schema.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Upstream registries routes', () => {
  let app: FastifyInstance;
  let token: string;
  let registryId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const candidates = [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'apikeytest@depgate.local', password: 'apikeytest123' },
      { email: 'admin@depgate.local', password: 'admin' },
    ];
    for (const creds of candidates) {
      const res = await supertest(app.server)
        .post('/api/auth/login')
        .send(creds);
      if (res.status === 200) {
        token = res.body.token;
        return;
      }
    }
    if (!token) throw new Error('Could not obtain auth token');
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('GET /api/admin/upstream-registries returns list (seeded defaults)', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThanOrEqual(5);
    const npm = response.body.find((r: { ecosystem: string }) => r.ecosystem === 'npm');
    expect(npm).toBeDefined();
    expect(npm.url).toContain('registry.npmjs.org');
  });

  it('GET /api/admin/upstream-registries?ecosystem=npm filters by ecosystem', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'npm' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.every((r: { ecosystem: string }) => r.ecosystem === 'npm')).toBe(true);
  });

  it('GET /api/admin/upstream-registries filters for pypi, go, maven, nuget, cargo, composer, and rubygems ecosystems', async () => {
    const pypiRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'pypi' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(pypiRes.body.length).toBeGreaterThan(0);
    expect(pypiRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'pypi')).toBe(true);

    const goRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'go' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(goRes.body.length).toBeGreaterThan(0);
    expect(goRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'go')).toBe(true);

    const mavenRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'maven' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(mavenRes.body.length).toBeGreaterThan(0);
    expect(mavenRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'maven')).toBe(true);

    const nugetRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'nuget' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(nugetRes.body.length).toBeGreaterThan(0);
    expect(nugetRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'nuget')).toBe(true);

    const cargoRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'cargo' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(cargoRes.body.length).toBeGreaterThan(0);
    expect(cargoRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'cargo')).toBe(true);

    const composerRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'composer' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(composerRes.body.length).toBeGreaterThan(0);
    expect(composerRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'composer')).toBe(true);

    const rubygemsRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'rubygems' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(rubygemsRes.body.length).toBeGreaterThan(0);
    expect(rubygemsRes.body.every((r: { ecosystem: string }) => r.ecosystem === 'rubygems')).toBe(true);
  });

  it('POST /api/admin/upstream-registries creates registry', async () => {
    const response = await supertest(app.server)
      .post('/api/admin/upstream-registries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'npm',
        url: 'https://registry.example.com',
        priority: 99,
        timeoutMs: 10000,
      })
      .expect(201);

    expect(response.body.id).toBeDefined();
    expect(response.body.ecosystem).toBe('npm');
    expect(response.body.url).toBe('https://registry.example.com');
    expect(response.body.priority).toBe(99);
    registryId = response.body.id;
  });

  it('PUT /api/admin/upstream-registries/:id updates registry', async () => {
    const response = await supertest(app.server)
      .put(`/api/admin/upstream-registries/${registryId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: false, priority: 100 })
      .expect(200);

    expect(response.body.id).toBe(registryId);
  });

  it('stores credentials encrypted, and keeps them when the masked value is sent back', async () => {
    const repo = app.db.getRepository(UpstreamRegistry);
    const put = (body: object) =>
      supertest(app.server).put(`/api/admin/upstream-registries/${registryId}`).set('Authorization', `Bearer ${token}`).send(body).expect(200);

    await put({ authType: 'basic', authUsername: 'ci-bot', authPassword: 'hunter2-secret' });
    const row = await repo.findOneByOrFail({ id: registryId });
    expect(row.authEncrypted!.startsWith('v1:')).toBe(true);
    expect(row.authEncrypted).not.toContain('hunter2-secret');
    expect(Buffer.from(row.authEncrypted!, 'base64').toString('utf8')).not.toContain('hunter2-secret');
    expect(parseAuth(row)).toEqual({ type: 'basic', username: 'ci-bot', password: 'hunter2-secret' });

    await put({ authType: 'basic', authUsername: '********', authPassword: '********' });
    expect(parseAuth(await repo.findOneByOrFail({ id: registryId }))).toEqual({ type: 'basic', username: 'ci-bot', password: 'hunter2-secret' });
  });

  it('encrypts credentials an older version stored as base64', async () => {
    const repo = app.db.getRepository(UpstreamRegistry);
    const legacy = Buffer.from(JSON.stringify({ token: 'legacy-token' })).toString('base64');
    await repo.update({ id: registryId }, { authType: 'bearer', authEncrypted: legacy });

    expect((await ensureUpstreamAuthEncrypted(app.db)).encrypted).toBeGreaterThanOrEqual(1);
    const row = await repo.findOneByOrFail({ id: registryId });
    expect(row.authEncrypted!.startsWith('v1:')).toBe(true);
    expect(row.authEncrypted).not.toBe(legacy);
    expect(parseAuth(row)).toEqual({ type: 'bearer', token: 'legacy-token' });

    // Run again: already encrypted, left alone.
    const encrypted = row.authEncrypted;
    await ensureUpstreamAuthEncrypted(app.db);
    expect((await repo.findOneByOrFail({ id: registryId })).authEncrypted).toBe(encrypted);
  });

  it('POST /api/admin/upstream-registries/test-connection tests URL without creating registry', async () => {
    const response = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'npm',
        url: 'https://registry.npmjs.org',
      })
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(typeof response.body.latencyMs).toBe('number');
  });

  it('POST /api/admin/upstream-registries/test-connection works for pypi, go, maven, nuget, cargo, composer, and rubygems URLs', async () => {
    const pypi = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'pypi',
        url: 'https://pypi.org',
      })
      .expect(200);
    expect(pypi.body.ok).toBe(true);

    const go = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'go',
        url: 'https://proxy.golang.org',
      })
      .expect(200);
    expect(go.body.ok).toBe(true);

    const maven = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'maven',
        url: 'https://repo1.maven.org/maven2',
      })
      .expect(200);
    expect(maven.body.ok).toBe(true);

    const nuget = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'nuget',
        url: 'https://api.nuget.org',
      })
      .expect(200);
    expect(nuget.body.ok).toBe(true);

    const cargo = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'cargo',
        url: 'https://crates.io',
      })
      .expect(200);
    expect(cargo.body.ok).toBe(true);

    const composer = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'composer',
        url: 'https://repo.packagist.org',
      })
      .expect(200);
    expect(composer.body.ok).toBe(true);

    const rubygems = await supertest(app.server)
      .post('/api/admin/upstream-registries/test-connection')
      .set('Authorization', `Bearer ${token}`)
      .send({
        ecosystem: 'rubygems',
        url: 'https://rubygems.org',
      })
      .expect(200);
    expect(rubygems.body.ok).toBe(true);
  });

  it('POST /api/admin/upstream-registries/:id/test tests npm registry', async () => {
    const listRes = await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .query({ ecosystem: 'npm' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const npmReg = listRes.body.find((r: { url: string }) => new URL(r.url).hostname === 'registry.npmjs.org');
    expect(npmReg).toBeDefined();

    const response = await supertest(app.server)
      .post(`/api/admin/upstream-registries/${npmReg.id}/test`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.ok).toBe(true);
    expect(typeof response.body.latencyMs).toBe('number');
  });

  it('DELETE /api/admin/upstream-registries/:id removes registry', async () => {
    await supertest(app.server)
      .delete(`/api/admin/upstream-registries/${registryId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('GET /api/admin/upstream-registries returns 401 without auth', async () => {
    await supertest(app.server)
      .get('/api/admin/upstream-registries')
      .expect(401);
  });
});
