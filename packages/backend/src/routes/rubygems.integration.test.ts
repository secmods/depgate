/**
 * RubyGems proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
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

const RUBYGEMS_PACKAGE = 'rake';
const RUBYGEMS_METADATA_PATH = `api/v1/versions/${RUBYGEMS_PACKAGE}.json`;

const AUTH_CANDIDATES = [
  { email: 'rubygemsadmin@depgate.local', password: 'rubygemsadmin123' },
  { email: 'admin@depgate.local', password: 'admin' },
  { email: 'testadmin@depgate.local', password: 'testpass123' },
];

type RubygemsVersion = {
  number?: string;
  gem_uri?: string;
};

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

describe.skipIf(!process.env.RUN_INTEGRATION)('RubyGems proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let rubygemsAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';
  let cachedVersion = '';
  let cachedFilePath = '';

  const fetchVersionAndUrl = async (): Promise<{ version: string; filePath: string }> => {
    const metadataRes = await rubygemsAuth(supertest(app.server).get(`/rubygems/${RUBYGEMS_METADATA_PATH}`)).expect(200);
    const versions = (metadataRes.body ?? []) as RubygemsVersion[];
    const first = versions.find((v) => typeof v.number === 'string' && typeof v.gem_uri === 'string');
    expect(first).toBeDefined();
    const version = first?.number as string;
    const gemUrl = first?.gem_uri as string;
    expect(gemUrl).toMatch(/\/rubygems\/gems\/[^/?]+\.gem$/);
    const parsed = new URL(gemUrl);
    return { version, filePath: `${parsed.pathname}${parsed.search}` };
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `rubygems-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    rubygemsAuth = (req) => req.set('Authorization', `Bearer ${token}`);


    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'rubygems', name: RUBYGEMS_PACKAGE });
    await policyRepo
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: '%rubygems test)%' })
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

  it('GET /rubygems/* metadata proxies package details and rewrites gem urls', async () => {
    const res = await rubygemsAuth(supertest(app.server).get(`/rubygems/${RUBYGEMS_METADATA_PATH}`)).expect(200);
    const versions = (res.body ?? []) as RubygemsVersion[];
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.some((v) => /\/rubygems\/gems\/[^/?]+\.gem$/.test(String(v.gem_uri ?? '')))).toBe(true);
    expect(JSON.stringify(versions)).not.toContain('token=');
  }, 20000);

  it('GET /rubygems/gems/<file> proxies artifact download from rewritten metadata url', async () => {
    const { filePath } = await fetchVersionAndUrl();
    const res = await rubygemsAuth(supertest(app.server).get(filePath)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream|application\/x-gzip|application\/gzip/);
    const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
    expect(contentLength).toBeGreaterThan(1000);
  }, 30000);

  it('policy BLOCK for rubygems hides blocked version from metadata and blocks artifact', async () => {
    const { version, filePath } = await fetchVersionAndUrl();
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rake rubygems version (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE], versionRange: version },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const metadataRes = await rubygemsAuth(supertest(app.server).get(`/rubygems/${RUBYGEMS_METADATA_PATH}`)).expect(200);
      const versions = (metadataRes.body ?? []) as Array<{ number?: string }>;
      const nums = versions.map((v) => v.number);
      expect(nums).toContain(version);
      const artifactRes = await rubygemsAuth(supertest(app.server).get(filePath)).expect(403);
      expect(artifactRes.body.policyName).toBe('Block rake rubygems version (rubygems test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('gem client paths: compact index passes through, gems/<file>.gem is policy-checked', async () => {
    const head = await rubygemsAuth(supertest(app.server).head('/rubygems/versions'));
    expect(head.status).toBe(200);
    const info = await rubygemsAuth(supertest(app.server).get('/rubygems/default/info/rack')).expect(200);
    expect(info.text).toMatch(/^2\.2\.3 .*checksum:[a-f0-9]{64}/m);
    await rubygemsAuth(
      supertest(app.server).get('/rubygems/quick/Marshal.4.8/rack-2.2.3.gemspec.rz').buffer(true)
    ).expect(200);

    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rack 2.2.3 gem path (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: ['rack'], versionRange: '2.2.3' },
        priority: 0,
      })
      .expect(201);
    try {
      const listed = await rubygemsAuth(supertest(app.server).get('/rubygems/info/rack')).expect(200);
      expect(listed.text).toMatch(/^2\.2\.3 /m);
      const blocked = await rubygemsAuth(supertest(app.server).get('/rubygems/gems/rack-2.2.3.gem')).expect(403);
      expect(blocked.body.policyName).toBe('Block rack 2.2.3 gem path (rubygems test)');
      const allowed = await rubygemsAuth(
        supertest(app.server).get('/rubygems/gems/rack-2.2.4.gem').buffer(true).parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        })
      ).expect(200);
      expect((allowed.body as Buffer).length).toBeGreaterThan(1000);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${createRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem-scoped policy: npm-scoped policy does not block rubygems', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'npm-only block (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;
    try {
      await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyId}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('ALLOW with higher priority overrides BLOCK for rubygems', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rubygems low priority (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow rubygems high priority (rubygems test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${blockRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('exception bypasses rubygems policy block', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rubygems for exception test (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: RUBYGEMS_PACKAGE,
        ecosystem: 'rubygems',
        version: cachedVersion,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: 'rubygems exception test',
      })
      .expect(201);
    try {
      await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/exceptions/${excRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('malicious package list blocks before ALLOW policy for rubygems', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow rubygems but malicious first (rubygems test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: RUBYGEMS_PACKAGE, ecosystem: 'rubygems' })
      .expect(201);
    try {
      const res = await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server).delete(`/api/admin/malicious-packages/${malRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('CVE severity threshold policy blocks rubygems artifact when OSV cache indicates HIGH', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const osvCacheKey = `osv:vuln:v3:rubygems:${RUBYGEMS_PACKAGE}:${cachedVersion}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-RUBYGEMS-2026-0001', severity: HIGH_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs rubygems (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs rubygems (rubygems test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 30000);

  it('CVE ID block list policy blocks rubygems artifact when OSV cache has matching CVE', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const osvCacheKey = `osv:vuln:v3:rubygems:${RUBYGEMS_PACKAGE}:${cachedVersion}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-RUBYGEMS-2026-4242', severity: MEDIUM_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs rubygems (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], cveBlockList: ['CVE-RUBYGEMS-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs rubygems (rubygems test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 30000);

  it('license policy blocks rubygems artifact download', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rubygems licenses wildcard (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], licenseDenyList: ['*'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block rubygems licenses wildcard (rubygems test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('release-age policy blocks rubygems artifact download', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block rubygems release age max (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      expect(res.body.policyName).toBe('Block rubygems release age max (rubygems test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);

  it('writes BLOCK decision audit log for rubygems policy enforcement', async () => {
    expect(cachedFilePath, 'cachedFilePath must be set').toBeTruthy();
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block rubygems (rubygems test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: [RUBYGEMS_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await rubygemsAuth(supertest(app.server).get(cachedFilePath)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'rubygems', package: RUBYGEMS_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) => a.packageName === RUBYGEMS_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 30000);
});
