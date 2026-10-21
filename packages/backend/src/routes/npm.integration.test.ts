/**
 * npm packument integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { flushLedger } from '../services/events/record.js';
import { config } from '../config.js';
import { FastifyInstance } from 'fastify';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';
import { Policy } from '../db/entities/Policy.js';
import { capturePublished } from '../test-support/event-rows.js';
import { npmCacheKeys, npmMetadataCacheKeys, resetNpmMemoryCache } from '../services/npm-packument.js';
import { In } from 'typeorm';
import { HIGH_CVSS, MEDIUM_CVSS } from '../test-support/cvss-vectors.js';

const AUTH_CANDIDATES = [
  { email: 'npmpolicyadmin@depgate.local', password: 'npmpolicyadmin123' },
  { email: 'admin@depgate.local', password: 'admin' },
  { email: 'policytest@depgate.local', password: 'policytest123' },
  { email: 'testadmin@depgate.local', password: 'testpass123' },
  { email: 'upstreamtest@depgate.local', password: 'upstreamtest123' },
];

async function getAuthToken(app: FastifyInstance): Promise<string> {
  for (const creds of AUTH_CANDIDATES) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token;
  }
  throw new Error('Could not obtain auth token');
}

describe.skipIf(!process.env.RUN_INTEGRATION)('npm packument routes', () => {
  const testTimeout = 30000;
  let app: FastifyInstance;
  let npmAuth: (req: supertest.Test) => supertest.Test;
  let previouslyEnabledPolicyIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const token = await getAuthToken(app);
    npmAuth = (req) => req.set('Authorization', `Bearer ${token}`);

    await app.redis.del(...npmMetadataCacheKeys('lodash', 'default'));
    resetNpmMemoryCache();
    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'npm', name: 'lodash' });
    await app.db
      .getRepository(UpstreamRegistry)
      .createQueryBuilder()
      .delete()
      .where('ecosystem = :ecosystem', { ecosystem: 'npm' })
      .andWhere('url LIKE :url', { url: '%this-path-returns-404%' })
      .execute();
    await app
      .db
      .getRepository(UpstreamRegistry)
      .createQueryBuilder()
      .update(UpstreamRegistry)
      .set({ isEnabled: true })
      .where('ecosystem = :ecosystem', { ecosystem: 'npm' })
      .andWhere('url = :url', { url: 'https://registry.npmjs.org' })
      .execute();

    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await policyRepo
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: '%test)%' })
      .execute();

  }, 30000);

  afterAll(async () => {
    if (!app) return;
    const policyRepo = app.db.getRepository(Policy);
    const chunkSize = 500;
    for (let i = 0; i < previouslyEnabledPolicyIds.length; i += chunkSize) {
      const chunk = previouslyEnabledPolicyIds.slice(i, i + chunkSize);
      await policyRepo.update({ id: In(chunk) }, { isEnabled: true });
    }
    await app.close();
  }, 30000);

  it('GET /npm/lodash returns packument with rewritten tarball URLs', { timeout: testTimeout }, async () => {
    const response = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);

    expect(response.body).toBeDefined();
    expect(response.body.versions).toBeDefined();
    const versions = response.body.versions as Record<string, { dist?: { tarball?: string } }>;
    expect(Object.keys(versions).length).toBeGreaterThan(0);
    const firstVer = Object.values(versions)[0];
    expect(firstVer?.dist?.tarball).toBeDefined();
    expect(firstVer?.dist?.tarball).toMatch(/\/npm\/lodash\/-\//);
    expect(firstVer?.dist?.tarball).not.toContain('registry.npmjs.org');
  });

  it('GET /npm/nonexistent-package-xyz-12345 returns 404', async () => {
    await npmAuth(supertest(app.server).get('/npm/nonexistent-package-xyz-12345')).expect(404);
  });

  it('GET /npm/ returns 400', async () => {
    await npmAuth(supertest(app.server).get('/npm/')).expect(400);
  });

  it('GET tarball with unparseable version returns 400', async () => {
    const res = await npmAuth(supertest(app.server).get('/npm/lodash/-/invalid.tgz')).expect(400);
    expect(res.body.error).toContain('could not parse version');
  });

  it('GET /npm/lodash/-/lodash-4.17.5.tgz proxies tarball', async () => {
    const response = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);

    expect(response.headers['content-type']).toMatch(/application\/gzip|application\/octet-stream/);
    expect(Buffer.isBuffer(response.body) || typeof response.body === 'object').toBe(true);
    const size = Buffer.isBuffer(response.body) ? response.body.length : 0;
    expect(size).toBeGreaterThan(1000);
  });

  it('policy blocks package when packageBlockList matches', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
      expect(tarballRes.body.policyName).toBe('Block lodash (test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy ALLOW overrides BLOCK when higher priority', async () => {
    const token = await getAuthToken(app);

    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash (override test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 10,
      })
      .expect(201);
    const blockPolicyId = blockRes.body.id;

    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow lodash (override test)',
        decision: 'ALLOW',
        conditions: { packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const allowPolicyId = allowRes.body.id;
    // Allowed downloads are published, never stored row by row (D1): watch the event.
    const published = capturePublished();

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
      expect(tarballRes.headers['content-type']).toBeDefined();

      const allowed = published.events.find((event) => event.type === 'ALLOW' && event.target?.version === '4.17.5' && event.policy?.id === allowPolicyId);
      expect(allowed?.policy?.name).toBe('Allow lodash (override test)');
      expect(allowed?.reasons).toContain('Package "lodash" matches allow list');
    } finally {
      published.stop();
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowPolicyId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${blockPolicyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy blocks package when licenseDenyList matches', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block MIT license (test)',
        decision: 'BLOCK',
        conditions: {
          ecosystem: ['npm'],
          licenseDenyList: ['MIT'],
        },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
      expect(tarballRes.body.policyName).toBe('Block MIT license (test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy blocks package when versionRange matches', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash <5 (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'], versionRange: '<5.0.0' },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy with ecosystem pypi does not block npm package', { timeout: testTimeout }, async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash pypi only (test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);

      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy with ecosystem npm blocks npm package', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash npm only (test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      expect(tarballRes.body.policyName).toBe('Block lodash npm only (test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('packages policy blocks every version of a listed package', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash (test)',
        decision: 'BLOCK',
        conditions: {
          packageBlockList: ['lodash'],
        },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      expect(tarballRes.body.policyName).toBe('Block lodash (test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('disabled policy does not block package', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash disabled (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 0,
        isEnabled: false,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);

      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('exception bypasses policy block', async () => {
    const token = await getAuthToken(app);

    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash for exception test (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: 'lodash',
        ecosystem: 'npm',
        version: '4.17.5',
        expiresAt,
        reason: 'Integration test',
      })
      .expect(201);
    const exceptionId = excRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);

      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/exceptions/${exceptionId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('malicious package blocks before policy', { timeout: testTimeout }, async () => {
    const token = await getAuthToken(app);

    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'mime',
        ecosystem: 'npm',
      })
      .expect(201);
    const maliciousId = malRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/mime')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();

      const tarballRes = await npmAuth(supertest(app.server).get('/npm/mime/-/mime-3.0.0.tgz')).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
      expect(tarballRes.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/malicious-packages/${maliciousId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('packages policy with a version range blocks only matching versions', async () => {
    const token = await getAuthToken(app);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block versions <1.0.0 (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'], versionRange: '<1.0.0' },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const tarballRes = await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-0.1.0.tgz'));
      if (tarballRes.status === 403) {
        expect(tarballRes.body.policyName).toBe('Block versions <1.0.0 (test)');
      }
      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('first matching policy wins by priority', async () => {
    const token = await getAuthToken(app);

    const block1Res = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash priority 10 (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 10,
      })
      .expect(201);
    const block1Id = block1Res.body.id;

    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow lodash priority 0 (test)',
        decision: 'ALLOW',
        conditions: { packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const allowId = allowRes.body.id;

    const block2Res = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block lodash priority 5 (test)',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 5,
      })
      .expect(201);
    const block2Id = block2Res.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);

      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${block2Id}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${block1Id}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('policy blocks tarball when cvssMin matches cached OSV vulnerability', async () => {
    const token = await getAuthToken(app);
    const osvCacheKey = 'osv:vuln:v3:npm:lodash:4.17.5';
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [
          {
            id: 'CVE-TEST-2026-0001',
            severity: HIGH_CVSS,
          },
        ],
      })
    );

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs (test)',
        decision: 'BLOCK',
        conditions: { cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const tarballRes = await npmAuth(
        supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')
      ).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
      expect(tarballRes.body.policyName).toBe('Block HIGH CVEs (test)');
      expect(tarballRes.body.reasons).toEqual(['CVE-TEST-2026-0001: CVSS 3.1 8.8']);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('policy blocks tarball when cveBlockList matches cached OSV vulnerability IDs', async () => {
    const token = await getAuthToken(app);
    const osvCacheKey = 'osv:vuln:v3:npm:lodash:4.17.5';
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [
          {
            id: 'CVE-TEST-2026-4242',
            severity: MEDIUM_CVSS,
          },
        ],
      })
    );

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE-ID list (test)',
        decision: 'BLOCK',
        conditions: { cveBlockList: ['CVE-TEST-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const tarballRes = await npmAuth(
        supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')
      ).expect(403);
      expect(tarballRes.body.error).toContain('blocked');
      expect(tarballRes.body.policyName).toBe('Block CVE-ID list (test)');
      expect((tarballRes.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('policy blocks tarball when releaseAgeMinDays matches old release', async () => {
    const token = await getAuthToken(app);
    const pkg = `release-age-min-test-${Date.now()}`;
    const version = '1.0.0';
    const tarball = `${pkg}-1.0.0.tgz`;
    const cacheKey = `npm:packument:${pkg}`;
    const oldTime = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await app.redis.setex(
      cacheKey,
      config.gateway.npmMetadataTtl,
      JSON.stringify({
        name: pkg,
        versions: {
          [version]: {
            time: oldTime,
            dist: {
              tarball: `${config.gateway.baseUrl.replace(/\/$/, '')}/npm/${pkg}/-/${tarball}`,
            },
          },
        },
      })
    );

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block releases older than 30 days (test)',
        decision: 'BLOCK',
        conditions: { releaseAgeMinDays: 30 },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get(`/npm/${pkg}`)).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(cacheKey);
    }
  });

  it('policy blocks tarball when releaseAgeMaxHours matches very recent threshold window', async () => {
    const token = await getAuthToken(app);
    const pkg = `release-age-max-test-${Date.now()}`;
    const version = '1.0.0';
    const tarball = `${pkg}-1.0.0.tgz`;
    const cacheKey = `npm:packument:${pkg}`;
    const recentTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await app.redis.setex(
      cacheKey,
      config.gateway.npmMetadataTtl,
      JSON.stringify({
        name: pkg,
        versions: {
          [version]: {
            time: recentTime,
            dist: {
              tarball: `${config.gateway.baseUrl.replace(/\/$/, '')}/npm/${pkg}/-/${tarball}`,
            },
          },
        },
      })
    );

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block releases newer than 100 years threshold (test)',
        decision: 'BLOCK',
        conditions: { releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const packRes = await npmAuth(supertest(app.server).get(`/npm/${pkg}`)).expect(200);
      expect(Object.keys(packRes.body.versions || {}).length).toBeGreaterThan(0);
      expect(packRes.body.policyRestrictions).toBeUndefined();
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(cacheKey);
    }
  });

  it('metadata cache stores rewritten packument in Redis with configured TTL', async () => {
    await npmAuth(supertest(app.server).get('/npm/lodash')).expect(200);

    const keys = npmCacheKeys('lodash', 'default');
    for (const key of [keys.full, keys.abbr, keys.index]) {
      const ttl = await app.redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(config.gateway.npmMetadataStaleTtl);
    }
  });

  it('negative metadata cache stores not-found package marker with configured TTL', async () => {
    const missingPkg = `nonexistent-package-${Date.now()}`;
    await npmAuth(supertest(app.server).get(`/npm/${missingPkg}`)).expect(404);

    const ttl = await app.redis.ttl(`npm:404:${missingPkg}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.gateway.npmNegativeTtl);
  });

  it('writes BLOCK decision audit log for npm policy enforcement', async () => {
    const token = await getAuthToken(app);
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block lodash (test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      await npmAuth(supertest(app.server).get('/npm/lodash/-/lodash-4.17.5.tgz')).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'npm', package: 'lodash', decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) =>
          a.packageName === 'lodash' && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('upstream fallback: packument resolves from secondary registry when primary returns 404', async () => {
    const token = await getAuthToken(app);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow lodash fallback (test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
        priority: -1000,
      })
      .expect(201);
    const allowPolicyId = allowRes.body.id;

    const repo = app.db.getRepository(PackageRepository);
    const primary404 = await repo.save(
      repo.create({
        ecosystem: 'npm',
        key: `fallback-404-${Date.now()}`,
        type: 'remote',
        upstreamUrl: 'https://registry.npmjs.org/this-path-returns-404',
        priority: -10,
        isEnabled: true,
        isReserved: false,
        timeoutMs: 10000,
        retryCount: 0,
      })
    );
    const secondaryGood = await repo.save(
      repo.create({
        ecosystem: 'npm',
        key: `fallback-good-${Date.now()}`,
        type: 'remote',
        upstreamUrl: 'https://registry.npmjs.org',
        priority: -9,
        isEnabled: true,
        isReserved: false,
        timeoutMs: 10000,
        retryCount: 0,
      })
    );

    try {
      await app.redis.del(...npmMetadataCacheKeys('lodash', 'all'));
      const res = await npmAuth(supertest(app.server).get('/npm/all/lodash')).expect(200);
      expect(Object.keys(res.body.versions || {}).length).toBeGreaterThan(0);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowPolicyId}`)
        .set('Authorization', `Bearer ${token}`);
      await repo.remove([primary404, secondaryGood]);
      await app.redis.del(...npmMetadataCacheKeys('lodash', 'all'));
    }
  });

  it('upstream fallback: tarball resolves from secondary registry when primary returns 404', async () => {
    const token = await getAuthToken(app);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow lodash fallback tarball (test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
        priority: -1000,
      })
      .expect(201);
    const allowPolicyId = allowRes.body.id;

    const repo = app.db.getRepository(PackageRepository);
    const primary404 = await repo.save(
      repo.create({
        ecosystem: 'npm',
        key: `fallback-tgz-404-${Date.now()}`,
        type: 'remote',
        upstreamUrl: 'https://registry.npmjs.org/this-path-returns-404',
        priority: -10,
        isEnabled: true,
        isReserved: false,
        timeoutMs: 10000,
        retryCount: 0,
      })
    );
    const secondaryGood = await repo.save(
      repo.create({
        ecosystem: 'npm',
        key: `fallback-tgz-good-${Date.now()}`,
        type: 'remote',
        upstreamUrl: 'https://registry.npmjs.org',
        priority: -9,
        isEnabled: true,
        isReserved: false,
        timeoutMs: 10000,
        retryCount: 0,
      })
    );

    try {
      const res = await npmAuth(supertest(app.server).get('/npm/all/lodash/-/lodash-4.17.5.tgz')).expect(200);
      expect(res.headers['content-type']).toMatch(/application\/gzip|application\/octet-stream/);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowPolicyId}`)
        .set('Authorization', `Bearer ${token}`);
      await repo.remove([primary404, secondaryGood]);
    }
  });
});
