/**
 * Maven proxy integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { flushLedger } from '../services/events/record.js';
import { FastifyInstance } from 'fastify';
import { Policy } from '../db/entities/Policy.js';
import { Exception as PolicyException } from '../db/entities/Exception.js';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { HIGH_CVSS, MEDIUM_CVSS } from '../test-support/cvss-vectors.js';
import { capturePublished } from '../test-support/event-rows.js';

const MAVEN_PACKAGE = 'junit:junit';
const MAVEN_PATH_BASE = 'junit/junit';
const MAVEN_VERSION = '4.13.2';
const MAVEN_METADATA_PATH = `${MAVEN_PATH_BASE}/maven-metadata.xml`;
const MAVEN_ARTIFACT_PATH = `${MAVEN_PATH_BASE}/${MAVEN_VERSION}/junit-${MAVEN_VERSION}.pom`;

const AUTH_CANDIDATES = [
  { email: 'mavenadmin@depgate.local', password: 'mavenadmin123' },
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

describe.skipIf(!process.env.RUN_INTEGRATION)('Maven proxy routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let token: string;
  let mavenAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `maven-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);
    mavenAuth = (req) => req.set('Authorization', `Bearer ${token}`);

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
    await app.db.getRepository(PolicyException).delete({ ecosystem: 'maven', packageName: MAVEN_PACKAGE });
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

  it('GET /maven/* metadata proxies maven-metadata.xml', async () => {
    const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_METADATA_PATH}`)).expect(200);
    expect(res.headers['content-type']).toMatch(/xml|text\/plain/);
    expect(res.text).toContain('<metadata>');
    expect(res.text).toContain('<version>');
  }, 15000);

  it('GET /maven/* artifact proxies POM', async () => {
    const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(200);
    expect(res.headers['content-type']).toMatch(/xml|text\/plain|application\/octet-stream/);
    expect(res.text).toContain('<project');
  });

  it('counts only the jar as a download, not the POM or checksums', async () => {
    const jar = `${MAVEN_PATH_BASE}/${MAVEN_VERSION}/junit-${MAVEN_VERSION}.jar`;
    const captured = capturePublished();
    try {
      for (const path of [MAVEN_ARTIFACT_PATH, `${MAVEN_ARTIFACT_PATH}.sha1`, jar, `${jar}.sha1`]) {
        await mavenAuth(supertest(app.server).get(`/maven/${path}`)).expect(200);
      }
    } finally {
      captured.stop();
    }
    const allows = captured.events.filter((e) => e.type === 'ALLOW' && e.target?.name === MAVEN_PACKAGE);
    expect(allows).toHaveLength(1);
    expect(allows[0].target?.version).toBe(MAVEN_VERSION);
  }, 30000);

  it('invalid maven path returns 400', async () => {
    await mavenAuth(supertest(app.server).get('/maven/junit')).expect(400);
  });

  it('policy BLOCK for maven hides blocked version from metadata and blocks artifact', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block junit maven version (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE], versionRange: MAVEN_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const metadataRes = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_METADATA_PATH}`)).expect(200);
      expect(metadataRes.text).not.toContain(`<version>${MAVEN_VERSION}</version>`);

      // The client stops at the refused POM, so that refusal is the one block a dashboard counts.
      const captured = capturePublished();
      let artifactRes;
      try {
        artifactRes = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      } finally {
        captured.stop();
      }
      expect(artifactRes.body.policyName).toBe('Block junit maven version (maven test)');
      const blocks = captured.events.filter((e) => e.type === 'BLOCK_ENFORCE' && e.target?.name === MAVEN_PACKAGE);
      expect(blocks).toHaveLength(1);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ecosystem npm policy does not affect maven requests', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block junit npm only (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [MAVEN_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('ALLOW priority overrides BLOCK for maven package', async () => {
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block maven junit low priority (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const blockId = blockRes.body.id;

    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow maven junit high priority (maven test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const allowId = allowRes.body.id;

    try {
      await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${blockId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('exception bypasses maven policy block', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block maven junit for exception (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE], versionRange: MAVEN_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${token}`)
      .send({
        packageName: MAVEN_PACKAGE,
        ecosystem: 'maven',
        version: MAVEN_VERSION,
        expiresAt,
        reason: 'Maven exception test',
      })
      .expect(201);
    const exceptionId = excRes.body.id;

    try {
      await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/exceptions/${exceptionId}`)
        .set('Authorization', `Bearer ${token}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('CVE severity policy blocks maven version when OSV cache indicates HIGH', async () => {
    const osvCacheKey = `osv:vuln:maven:${MAVEN_PACKAGE}:${MAVEN_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [{ id: 'CVE-MAVEN-2026-0001', severity: HIGH_CVSS }],
      })
    );

    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block HIGH CVEs maven (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block HIGH CVEs maven (maven test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('CVE ID block list policy blocks maven version when OSV cache has matching CVE', async () => {
    const osvCacheKey = `osv:vuln:maven:${MAVEN_PACKAGE}:${MAVEN_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [{ id: 'CVE-MAVEN-2026-4242', severity: MEDIUM_CVSS }],
      })
    );

    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block CVE IDs maven (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], cveBlockList: ['CVE-MAVEN-2026-4242'] },
        priority: -10000,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block CVE IDs maven (maven test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('license policy blocks maven artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block Maven licenses wildcard (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], licenseDenyList: ['*'] },
        priority: -10000,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block Maven licenses wildcard (maven test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('License');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('release-age policy blocks maven artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block Maven release age max (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: -10000,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      expect(res.body.policyName).toBe('Block Maven release age max (maven test)');
      expect((res.body.reasons ?? []).join(' ')).toContain('newer than');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('malicious package blocks before ALLOW policy for maven', async () => {
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Allow maven junit but malicious first (maven test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = allowRes.body.id;

    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: MAVEN_PACKAGE,
        ecosystem: 'maven',
      })
      .expect(201);
    const maliciousId = malRes.body.id;

    try {
      const res = await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
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

  it('writes BLOCK decision audit log for maven policy enforcement', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Audit block maven junit (maven test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], packageBlockList: [MAVEN_PACKAGE], versionRange: MAVEN_VERSION },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      await mavenAuth(supertest(app.server).get(`/maven/${MAVEN_ARTIFACT_PATH}`)).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'maven', package: MAVEN_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) =>
          a.packageName === MAVEN_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });
});
