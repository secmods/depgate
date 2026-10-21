/**
 * Go proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { flushLedger } from '../services/events/record.js';
import { FastifyInstance } from 'fastify';
import { Policy } from '../db/entities/Policy.js';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { HIGH_CVSS, MEDIUM_CVSS } from '../test-support/cvss-vectors.js';
import { capturePublished } from '../test-support/event-rows.js';

const GO_MODULE = 'rsc.io/quote';
const GO_VERSION = 'v1.5.2';

const AUTH_CANDIDATES = [
  { email: 'goadmin@depgate.local', password: 'goadmin123' },
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

const SUITE_LOCK_KEY = 'integration:suite-lock:go-maven-policy';

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
  if (current === owner) {
    await app.redis.del(SUITE_LOCK_KEY);
  }
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Go proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let goAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `go-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    goAuth = (req) => req.set('Authorization', `Bearer ${token}`);

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

  it('GET /go/module/@v/list returns version list', async () => {
    const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/list`)).expect(200);
    expect(typeof res.text).toBe('string');
    expect(res.text).toContain('v');
  });

  it('GET /go/module/@v/version.info returns json metadata', async () => {
    const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.info`)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json|text\/plain/);
    expect(res.text).toContain('"Version"');
  });

  it('GET /go/module/@v/version.mod returns go.mod text', async () => {
    const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.mod`)).expect(200);
    expect(res.text).toContain('module');
  });

  it('GET /go/module/@v/version.zip proxies module zip', async () => {
    const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/zip|application\/octet-stream/);
    const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
    expect(contentLength).toBeGreaterThan(100);
  });

  it('counts one module download once: .info and .mod are not downloads, the zip is', async () => {
    const captured = capturePublished();
    try {
      for (const file of ['info', 'mod', 'zip']) {
        await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.${file}`)).expect(200);
      }
    } finally {
      captured.stop();
    }
    const allows = captured.events.filter((e) => e.type === 'ALLOW' && e.target?.name === GO_MODULE);
    expect(allows).toHaveLength(1);
    expect(allows[0].target?.version).toBe(GO_VERSION);
  });

  it('invalid path returns 400', async () => {
    await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/latest`)).expect(400);
  });

  it('sumdb paths return 404 so the go command contacts the checksum database directly', async () => {
    await goAuth(supertest(app.server).get('/go/sumdb/sum.golang.org/supported')).expect(404);
    await goAuth(supertest(app.server).get('/go/default/sumdb/sum.golang.org/supported')).expect(404);
  });

  it('policy BLOCK for go hides blocked version from list and blocks zip', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block go quote version (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE], versionRange: GO_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const listRes = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/list`)).expect(200);
      expect(listRes.text).not.toContain(GO_VERSION);

      const zipRes = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      expect(zipRes.body.policyName).toBe('Block go quote version (go test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem npm policy does not affect go requests', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block go module npm only (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [GO_MODULE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.mod`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ALLOW priority overrides BLOCK for go module', async () => {
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block go module low priority (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE] },
        priority: 10,
      })
      .expect(201);
    const blockId = blockRes.body.id;

    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow go module high priority (go test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE] },
        priority: 0,
      })
      .expect(201);
    const allowId = allowRes.body.id;

    try {
      await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.info`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${blockId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('exception bypasses go policy block', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block go quote for exception (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE], versionRange: GO_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: GO_MODULE,
        ecosystem: 'go',
        version: GO_VERSION,
        expiresAt,
        reason: 'Go exception test',
      })
      .expect(201);
    const exceptionId = excRes.body.id;

    try {
      await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.mod`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/exceptions/${exceptionId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('CVE severity policy blocks go version when OSV cache indicates HIGH', async () => {
    const osvCacheKey = `osv:vuln:v3:go:${GO_MODULE}:${GO_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [{ id: 'CVE-GO-2026-0001', severity: HIGH_CVSS }],
      })
    );

    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs go (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs go (go test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('CVE ID block list policy blocks go version when OSV cache has matching CVE', async () => {
    const osvCacheKey = `osv:vuln:v3:go:${GO_MODULE}:${GO_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [{ id: 'CVE-GO-2026-4242', severity: MEDIUM_CVSS }],
      })
    );

    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs go (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], cveBlockList: ['CVE-GO-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs go (go test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('license policy blocks go versioned download path', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block BSD-3-Clause go licenses (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], licenseDenyList: ['BSD-3-Clause'] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.mod`)).expect(403);
      expect(res.body.policyName).toBe('Block BSD-3-Clause go licenses (go test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('License');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('release-age policy blocks go versioned download path', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block go recent-age threshold (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      expect(res.body.policyName).toBe('Block go recent-age threshold (go test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('newer than');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('malicious package blocks before ALLOW policy for go', async () => {
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow go quote but malicious first (go test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE] },
        priority: 0,
      })
      .expect(201);
    const policyId = allowRes.body.id;

    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: GO_MODULE,
        ecosystem: 'go',
      })
      .expect(201);
    const maliciousId = malRes.body.id;

    try {
      const res = await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      expect(res.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/malicious-packages/${maliciousId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('writes BLOCK decision audit log for go policy enforcement', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block go quote (go test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['go'], packageBlockList: [GO_MODULE], versionRange: GO_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      await goAuth(supertest(app.server).get(`/go/${GO_MODULE}/@v/${GO_VERSION}.zip`)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'go', package: GO_MODULE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) =>
          a.packageName === GO_MODULE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });
});
