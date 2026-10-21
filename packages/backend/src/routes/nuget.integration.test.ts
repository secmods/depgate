/**
 * NuGet proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { flushLedger } from '../services/events/record.js';
import { FastifyInstance } from 'fastify';
import { Policy } from '../db/entities/Policy.js';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { HIGH_CVSS, MEDIUM_CVSS } from '../test-support/cvss-vectors.js';

const NUGET_PACKAGE = 'newtonsoft.json';
const NUGET_VERSION = '13.0.3';
const NUGET_METADATA_PATH = `v3-flatcontainer/${NUGET_PACKAGE}/index.json`;
const NUGET_ARTIFACT_PATH = `v3-flatcontainer/${NUGET_PACKAGE}/${NUGET_VERSION}/${NUGET_PACKAGE}.${NUGET_VERSION}.nupkg`;

const AUTH_CANDIDATES = [
  { email: 'nugetadmin@depgate.local', password: 'nugetadmin123' },
  { email: 'admin@depgate.local', password: 'admin' },
  { email: 'testadmin@depgate.local', password: 'testpass123' },
];

async function getAuthToken(app: FastifyInstance): Promise<string> {
  for (const creds of AUTH_CANDIDATES) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token;
  }
  throw new Error('Could not obtain auth token');
}

// Shared lock because integration suites mutate global policy/config state.
const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';

async function acquireSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const timeoutMs = 120000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await app.redis.set(SUITE_LOCK_KEY, owner, 'NX', 'PX', 300000);
    if (ok === 'OK') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for integration suite lock');
}

async function releaseSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const current = await app.redis.get(SUITE_LOCK_KEY);
  if (current === owner) await app.redis.del(SUITE_LOCK_KEY);
}

describe.skipIf(!process.env.RUN_INTEGRATION)('NuGet proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let nugetAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `nuget-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    nugetAuth = (req) => req.set('Authorization', `Bearer ${token}`);


    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'nuget', name: NUGET_PACKAGE });
    await policyRepo
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: '%test)%' })
      .execute();
  }, 30000);

  afterAll(async () => {
    if (!app) return;
    try {
      const policyRepo = app.db.getRepository(Policy);
      const chunkSize = 500;
      for (let i = 0; i < previouslyEnabledPolicyIds.length; i += chunkSize) {
        const chunk = previouslyEnabledPolicyIds.slice(i, i + chunkSize);
        await policyRepo.update({ id: In(chunk) }, { isEnabled: true });
      }
    } finally {
      await releaseSuiteLock(app, lockOwner);
      await app.close();
    }
  }, 30000);

  it('GET /nuget/* metadata proxies flatcontainer index and rewrites urls', async () => {
    const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_METADATA_PATH}`)).expect(200);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions.length).toBeGreaterThan(0);
  }, 15000);

  it('GET /nuget/* artifact proxies nupkg', async () => {
    const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream|application\/x-zip-compressed|application\/zip/);
    const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
    expect(contentLength).toBeGreaterThan(1000);
  }, 20000);

  it('policy BLOCK for nuget hides blocked version from metadata and blocks artifact', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block Newtonsoft NuGet version (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE], versionRange: NUGET_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const metadataRes = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_METADATA_PATH}`)).expect(200);
      expect(metadataRes.body.versions).toContain(NUGET_VERSION);
      const artifactRes = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(artifactRes.body.policyName).toBe('Block Newtonsoft NuGet version (nuget test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem-scoped policy: npm-scoped policy does not block nuget', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'npm-only block (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [NUGET_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;
    try {
      await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyId}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('ALLOW with higher priority overrides BLOCK for nuget', async () => {
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block nuget low priority (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow nuget high priority (nuget test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${blockRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('exception bypasses nuget policy block', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block nuget for exception test (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: NUGET_PACKAGE,
        ecosystem: 'nuget',
        version: NUGET_VERSION,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: 'nuget exception test',
      })
      .expect(201);
    try {
      await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/exceptions/${excRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('malicious package list blocks before ALLOW policy for nuget', async () => {
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow nuget but malicious first (nuget test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: NUGET_PACKAGE, ecosystem: 'nuget' })
      .expect(201);
    try {
      const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server).delete(`/api/admin/malicious-packages/${malRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('CVE severity threshold policy blocks nuget artifact when OSV cache indicates HIGH', async () => {
    const osvCacheKey = `osv:vuln:v3:nuget:${NUGET_PACKAGE}:${NUGET_VERSION}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-NUGET-2026-0001', severity: HIGH_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs nuget (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs nuget (nuget test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 20000);

  it('CVE ID block list policy blocks nuget artifact when OSV cache has matching CVE', async () => {
    const osvCacheKey = `osv:vuln:v3:nuget:${NUGET_PACKAGE}:${NUGET_VERSION}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-NUGET-2026-4242', severity: MEDIUM_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs nuget (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], cveBlockList: ['CVE-NUGET-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs nuget (nuget test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 20000);

  it('license policy blocks nuget artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block nuget licenses wildcard (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], licenseDenyList: ['*'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block nuget licenses wildcard (nuget test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('release-age policy blocks nuget artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block nuget release age max (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block nuget release age max (nuget test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('writes BLOCK decision audit log for nuget policy enforcement', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block nuget (nuget test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['nuget'], packageBlockList: [NUGET_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await nugetAuth(supertest(app.server).get(`/nuget/${NUGET_ARTIFACT_PATH}`)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'nuget', package: NUGET_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) => a.packageName === NUGET_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);
});

