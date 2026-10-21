/**
 * Cargo proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
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

const CARGO_PACKAGE = 'serde';
const CARGO_VERSION = '1.0.197';
const CARGO_METADATA_PATH = `api/v1/crates/${CARGO_PACKAGE}`;
const CARGO_ARTIFACT_PATH = `api/v1/crates/${CARGO_PACKAGE}/${CARGO_VERSION}/download`;

const AUTH_CANDIDATES = [
  { email: 'cargoadmin@depgate.local', password: 'cargoadmin123' },
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

describe.skipIf(!process.env.RUN_INTEGRATION)('Cargo proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let cargoAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `cargo-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    cargoAuth = (req) => req.set('Authorization', `Bearer ${token}`);


    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'cargo', name: CARGO_PACKAGE });
    await policyRepo
      .createQueryBuilder()
      .delete()
      .where('name LIKE :pattern', { pattern: '%cargo test)%' })
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

  it('sparse index: config.json points dl at the gateway and index files pass through', async () => {
    const cfg = await cargoAuth(supertest(app.server).get('/cargo/default/config.json')).expect(200);
    expect(cfg.body['auth-required']).toBe(true);
    expect(cfg.body.dl).toMatch(/\/cargo\/default\/api\/v1\/crates$/);
    const index = await cargoAuth(supertest(app.server).get('/cargo/default/se/rd/serde')).expect(200);
    const first = JSON.parse(index.text.split('\n')[0]) as { name: string; vers: string; cksum: string };
    expect(first.name).toBe('serde');
    expect(first.cksum).toMatch(/^[a-f0-9]{64}$/);
    await cargoAuth(supertest(app.server).get('/cargo/default/no/su/no-such-crate-qa-xyz')).expect(404);
  }, 30000);

  it('accepts the bare token cargo sends as registries.<name>.token', async () => {
    await supertest(app.server).get('/cargo/default/config.json').set('Authorization', token!).expect(200);
  });

  it('GET /cargo/* metadata proxies crate details', async () => {
    const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_METADATA_PATH}`)).expect(200);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(res.body.versions.length).toBeGreaterThan(0);
  }, 30000);

  it('GET /cargo/* artifact proxies crate download', async () => {
    const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream|application\/gzip|application\/x-tar/);
    const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
    expect(contentLength).toBeGreaterThan(1000);
  }, 20000);

  it('policy BLOCK for cargo hides blocked version from metadata and blocks artifact', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block serde cargo version (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE], versionRange: CARGO_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const metadataRes = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_METADATA_PATH}`)).expect(200);
      const versions = (metadataRes.body.versions as Array<{ num?: string }>).map((v) => v.num);
      expect(versions).toContain(CARGO_VERSION);
      const artifactRes = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(artifactRes.body.policyName).toBe('Block serde cargo version (cargo test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem-scoped policy: npm-scoped policy does not block cargo', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'npm-only block (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [CARGO_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;
    try {
      await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyId}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('ALLOW with higher priority overrides BLOCK for cargo', async () => {
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block cargo low priority (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow cargo high priority (cargo test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${blockRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('exception bypasses cargo policy block', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block cargo for exception test (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: CARGO_PACKAGE,
        ecosystem: 'cargo',
        version: CARGO_VERSION,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: 'cargo exception test',
      })
      .expect(201);
    try {
      await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server).delete(`/api/admin/exceptions/${excRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('malicious package list blocks before ALLOW policy for cargo', async () => {
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow cargo but malicious first (cargo test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: CARGO_PACKAGE, ecosystem: 'cargo' })
      .expect(201);
    try {
      const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server).delete(`/api/admin/malicious-packages/${malRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await supertest(app.server).delete(`/api/admin/policies/${allowRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('CVE severity threshold policy blocks cargo artifact when OSV cache indicates HIGH', async () => {
    const osvCacheKey = `osv:vuln:v3:cargo:${CARGO_PACKAGE}:${CARGO_VERSION}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-CARGO-2026-0001', severity: HIGH_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs cargo (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs cargo (cargo test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 20000);

  it('CVE ID block list policy blocks cargo artifact when OSV cache has matching CVE', async () => {
    const osvCacheKey = `osv:vuln:v3:cargo:${CARGO_PACKAGE}:${CARGO_VERSION}`;
    await app.redis.set(osvCacheKey, JSON.stringify({
      vulns: [{ id: 'CVE-CARGO-2026-4242', severity: MEDIUM_CVSS }],
    }));
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs cargo (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], cveBlockList: ['CVE-CARGO-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs cargo (cargo test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  }, 20000);

  it('license policy blocks cargo artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block cargo licenses wildcard (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], licenseDenyList: ['*'] },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block cargo licenses wildcard (cargo test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('release-age policy blocks cargo artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block cargo release age max (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    try {
      const res = await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block cargo release age max (cargo test)');
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);

  it('writes BLOCK decision audit log for cargo policy enforcement', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block cargo (cargo test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['cargo'], packageBlockList: [CARGO_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    try {
      await cargoAuth(supertest(app.server).get(`/cargo/${CARGO_ARTIFACT_PATH}`)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'cargo', package: CARGO_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) => a.packageName === CARGO_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server).delete(`/api/admin/policies/${policyRes.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  }, 20000);
});
