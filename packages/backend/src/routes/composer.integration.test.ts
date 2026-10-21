/**
 * Composer proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
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

const COMPOSER_PACKAGE = 'monolog/monolog';
const COMPOSER_METADATA_PATH = `p2/${COMPOSER_PACKAGE}.json`;

const AUTH_CANDIDATES = [
  { email: 'composeradmin@depgate.local', password: 'composeradmin123' },
  { email: 'admin@depgate.local', password: 'admin' },
  { email: 'testadmin@depgate.local', password: 'testpass123' },
];

type PackageVersion = {
  version?: string;
  version_normalized?: string;
  dist?: { url?: string };
};

/** Version and package the artifact route evaluates, taken from the rewritten download URL. */
/** Package and version of a gateway dist link: `/composer/dist/<vendor>/<name>/<version>`. */
function artifactIdentity(filePath: string): { packageName: string; version: string } {
  const match = new URL(filePath, 'http://localhost').pathname.match(/\/dist\/([^/]+\/[^/]+)\/([^/]+)$/);
  return {
    packageName: match ? decodeURIComponent(match[1]) : COMPOSER_PACKAGE,
    version: match ? decodeURIComponent(match[2]) : '',
  };
}

async function getAuthToken(app: FastifyInstance): Promise<string> {
  for (const creds of AUTH_CANDIDATES) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token;
  }
  throw new Error('Could not obtain auth token');
}

// Shared lock because these integration suites mutate global policy/config state.
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

describe.skipIf(!process.env.RUN_INTEGRATION)('Composer proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let composerAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';
  let cachedVersion = '';
  let cachedFilePath = '';

  const fetchVersionAndUrl = async (): Promise<{ version: string; filePath: string }> => {
    const metadataRes = await composerAuth(supertest(app.server).get(`/composer/${COMPOSER_METADATA_PATH}`)).expect(200);
    const versions = (metadataRes.body?.packages?.[COMPOSER_PACKAGE] ?? []) as PackageVersion[];
    const first = versions.find((v) => typeof v.dist?.url === 'string');
    expect(first).toBeDefined();
    const version = first?.version_normalized ?? first?.version;
    expect(version).toBeDefined();
    const distUrl = first?.dist?.url as string;
    expect(distUrl).toContain('/composer/dist/');
    const parsed = new URL(distUrl);
    return { version: String(version), filePath: `${parsed.pathname}${parsed.search}` };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `composer-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    composerAuth = (req) => req.set('Authorization', `Bearer ${token}`);


    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'composer', name: COMPOSER_PACKAGE });
    await policyRepo
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: '%composer test)%' })
      .execute();

    // Pre-fetch version + artifact path once for all tests that need them
    try {
      const { version, filePath } = await fetchVersionAndUrl();
      cachedVersion = version;
      cachedFilePath = filePath;
    } catch {
      // tests that need these will fail with a clear message
    }
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

  it('GET /composer/* metadata proxies package details and rewrites dist urls', async () => {
    const res = await composerAuth(supertest(app.server).get(`/composer/${COMPOSER_METADATA_PATH}`)).expect(200);
    const versions = (res.body?.packages?.[COMPOSER_PACKAGE] ?? []) as PackageVersion[];
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.some((v) => String(v.dist?.url ?? '').includes(`/composer/dist/${COMPOSER_PACKAGE}/`))).toBe(true);
    expect(JSON.stringify(versions)).not.toContain('token=');
  }, 20000);

  it('GET /composer/dist/<package>/<version> proxies artifact download from rewritten metadata url', async () => {
    await composerAuth(supertest(app.server).get(`/composer/dist/${COMPOSER_PACKAGE}/0.0.0-not-a-version`)).expect(404);
    const { filePath } = await fetchVersionAndUrl();
    const res = await composerAuth(supertest(app.server).get(filePath)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/zip|application\/octet-stream|application\/gzip/);
    const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
    expect(contentLength).toBeGreaterThan(1000);
  }, 30000);

  it('policy BLOCK for composer hides blocked version from metadata and blocks artifact', async () => {
    const { version, filePath } = await fetchVersionAndUrl();
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block monolog composer version (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE], versionRange: version },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const metadataRes = await composerAuth(supertest(app.server).get(`/composer/${COMPOSER_METADATA_PATH}`)).expect(200);
      const versions = (metadataRes.body?.packages?.[COMPOSER_PACKAGE] ?? []) as PackageVersion[];
      const normalized = versions.map((v) => v.version_normalized ?? v.version);
      expect(normalized).toContain(version);
      const artifactRes = await composerAuth(supertest(app.server).get(filePath)).expect(403);
      expect(artifactRes.body.policyName).toBe('Block monolog composer version (composer test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem-scoped policy: npm-scoped policy does not block composer', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'npm-only block (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;
    try {
      await composerAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyId}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('ALLOW with higher priority overrides BLOCK for composer', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block composer low priority (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow composer high priority (composer test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await composerAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${blockRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('exception bypasses composer policy block', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block composer for exception test (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: COMPOSER_PACKAGE,
        ecosystem: 'composer',
        version: cachedVersion,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: 'composer exception test',
      })
      .expect(201);
    try {
      await composerAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/exceptions/${excRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('malicious package list blocks before ALLOW policy for composer', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow composer but malicious first (composer test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: COMPOSER_PACKAGE, ecosystem: 'composer' })
      .expect(201);
    try {
      const res = await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server).delete(`/api/admin/malicious-packages/${malRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('CVE severity threshold policy blocks composer artifact when OSV cache indicates HIGH', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const identity = artifactIdentity(cachedFilePath);
    const osvCacheKey = `osv:vuln:v3:composer:${identity.packageName}:${identity.version}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-COMPOSER-2026-0001', severity: HIGH_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs composer (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs composer (composer test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 30000);

  it('CVE ID block list policy blocks composer artifact when OSV cache has matching CVE', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const identity = artifactIdentity(cachedFilePath);
    const osvCacheKey = `osv:vuln:v3:composer:${identity.packageName}:${identity.version}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-COMPOSER-2026-4242', severity: MEDIUM_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs composer (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], cveBlockList: ['CVE-COMPOSER-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs composer (composer test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 30000);

  it('license policy blocks composer artifact download', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block composer licenses wildcard (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], licenseDenyList: ['*'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block composer licenses wildcard (composer test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('release-age policy blocks composer artifact download', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block composer release age max (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block composer release age max (composer test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('writes BLOCK decision audit log for composer policy enforcement', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block composer (composer test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['composer'], packageBlockList: [COMPOSER_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await composerAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'composer', package: COMPOSER_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) => a.packageName === COMPOSER_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);
});
