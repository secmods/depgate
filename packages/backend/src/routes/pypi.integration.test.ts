/**
 * PyPI integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
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

const AUTH_CANDIDATES = [
  { email: 'pypiadmin@depgate.local', password: 'pypiadmin123' },
  { email: 'admin@depgate.local', password: 'admin' },
  { email: 'testadmin@depgate.local', password: 'testpass123' },
];
const KNOWN_PYPI_PACKAGE = 'requests';
const KNOWN_PYPI_VERSION = '0.2.0';
/** The gateway link for requests-0.2.0.tar.gz: package and file name, found again in the simple index. */
const KNOWN_FILE_PATH = '/pypi/files/requests/requests-0.2.0.tar.gz';
// Shared lock because integration suites mutate global policy/config state.
const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';

async function getAuthToken(app: FastifyInstance): Promise<string> {
  for (const creds of AUTH_CANDIDATES) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token;
  }
  throw new Error('Could not obtain auth token');
}

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

describe.skipIf(!process.env.RUN_INTEGRATION)('PyPI routes', () => {
  let app: FastifyInstance;
  let previouslyEnabledPolicyIds: string[] = [];
  let adminToken: string;
  let pypiAuth: (req: supertest.Test) => supertest.Test;
  let lockOwner = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `pypi-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    adminToken = await getAuthToken(app);
    pypiAuth = (req) => req.set('Authorization', `Bearer ${adminToken}`);

    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }

    await app.db.getRepository(MaliciousPackage).delete({ ecosystem: 'pypi', name: KNOWN_PYPI_PACKAGE });
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

  it('GET /pypi/simple/requests/ returns rewritten simple index HTML', async () => {
    const response = await pypiAuth(supertest(app.server).get('/pypi/simple/requests/')).expect(200);

    expect(typeof response.text).toBe('string');
    expect(response.text).toMatch(/\/pypi\/files\/[A-Za-z0-9_.%-]+\/requests-[^"'?\s/]+\.(whl|tar\.gz)#sha256=/);
    expect(response.text).not.toContain('files.pythonhosted.org/packages/');
    expect(response.text).toContain('/pypi/files/requests/requests-2.32.3-py3-none-any.whl#sha256=');
    expect(response.text).not.toContain('token=');
  }, 30000);

  it('a file name the index does not list, or an old token link, is 404 and fetches nothing', async () => {
    await pypiAuth(supertest(app.server).get('/pypi/files/requests/requests-0.0.0-evil.tar.gz')).expect(404);
    await pypiAuth(supertest(app.server).get('/pypi/files/eyJ1cmwiOiJodHRwOi8vMTY5LjI1NC4xNjkuMjU0LyJ9.x/x.tar.gz')).expect(404);
    await pypiAuth(supertest(app.server).get('/pypi/files?token=abc&package=requests')).expect(404);
  }, 30000);

  it('keeps PEP 658 metadata and serves <file URL>.metadata through the gateway', async () => {
    const response = await pypiAuth(supertest(app.server).get('/pypi/simple/requests/')).expect(200);
    expect(response.text).toMatch(/data-(dist-info|core)-metadata/);
    const href = response.text.match(/href="http:\/\/[^/]+(\/pypi\/[^"#]*requests-2\.32\.3-py3-none-any\.whl)/)![1];
    const metadata = await pypiAuth(supertest(app.server).get(`${href}.metadata`)).expect(200);
    expect(metadata.text).toMatch(/^Metadata-Version:/m);
    expect(metadata.text).toMatch(/^Name: requests$/m);
  }, 30000);

  it('file route accepts wheel names longer than 100 characters', async () => {
    const longName =
      'charset_normalizer-0.0.1-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl';
    const res = await pypiAuth(supertest(app.server).get(`/pypi/files/charset-normalizer/${longName}`));
    expect(res.status).not.toBe(414);
    // Not a file the index lists: refused, never fetched.
    expect(res.status).toBe(404);
  }, 30000);

  it('GET /pypi/simple/nonexistent package returns 404', async () => {
    await pypiAuth(supertest(app.server).get('/pypi/simple/nonexistent-pkg-xyz-1234567/')).expect(404);
  }, 30000);

  it('GET /pypi/files/<package>/<file> proxies a file the index lists', async () => {

    const fileRes = await pypiAuth(
      supertest(app.server).get(
        KNOWN_FILE_PATH
      )
    ).expect(200);
    expect(fileRes.headers['content-type']).toBeDefined();
    const bodyLength = Buffer.isBuffer(fileRes.body) ? fileRes.body.length : 0;
    expect(bodyLength).toBeGreaterThan(100);
  });

  it('policy blocks PyPI package in simple index and file proxy', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block requests (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const simpleRes = await pypiAuth(supertest(app.server).get('/pypi/simple/requests/')).expect(200);
      expect(simpleRes.text).toContain('data-yanked=');
      expect(simpleRes.text).toContain('Package blocked by policy');

      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Block requests (pypi test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('policy with ecosystem npm does not block PyPI', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block requests npm only (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['npm'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = createRes.body.id;

    try {
      const simpleRes = await pypiAuth(supertest(app.server).get('/pypi/simple/requests/')).expect(200);
      expect(simpleRes.text).toMatch(/\/pypi\/files\/[A-Za-z0-9_.%-]+\/[^"'?\s/]+\.(whl|tar\.gz)/);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  }, 30000);

  it('ALLOW with higher priority overrides BLOCK for PyPI', async () => {
    const blockRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block requests low priority (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 10,
      })
      .expect(201);
    const blockId = blockRes.body.id;

    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Allow requests high priority (pypi test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const allowId = allowRes.body.id;

    try {
      await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${allowId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${blockId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('exception bypasses PyPI policy block for version', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block requests exception test (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const excRes = await supertest(app.server)
      .post('/api/admin/exceptions')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        packageName: KNOWN_PYPI_PACKAGE,
        ecosystem: 'pypi',
        version: KNOWN_PYPI_VERSION,
        expiresAt,
        reason: 'PyPI policy exception test',
      })
      .expect(201);
    const exceptionId = excRes.body.id;

    try {
      await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(200);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/exceptions/${exceptionId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('malicious package list blocks before ALLOW policy for PyPI', async () => {
    const allowRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Allow requests but malicious first (pypi test)',
        decision: 'ALLOW',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = allowRes.body.id;

    const malRes = await supertest(app.server)
      .post('/api/admin/malicious-packages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: KNOWN_PYPI_PACKAGE,
        ecosystem: 'pypi',
      })
      .expect(201);
    const maliciousId = malRes.body.id;

    try {
      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Malicious packages list');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/malicious-packages/${maliciousId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('CVE severity threshold policy blocks PyPI artifact when OSV cache indicates HIGH', async () => {
    const osvCacheKey = `osv:vuln:pypi:${KNOWN_PYPI_PACKAGE}:${KNOWN_PYPI_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [
          {
            id: 'CVE-PYPI-2026-0001',
            severity: HIGH_CVSS,
          },
        ],
      })
    );
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block HIGH CVEs PyPI (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], cvssMin: 7 },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Block HIGH CVEs PyPI (pypi test)');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('CVE ID block list policy blocks PyPI artifact when OSV cache has matching CVE', async () => {
    const osvCacheKey = `osv:vuln:pypi:${KNOWN_PYPI_PACKAGE}:${KNOWN_PYPI_VERSION}`;
    await app.redis.set(
      osvCacheKey,
      JSON.stringify({
        vulns: [
          {
            id: 'CVE-PYPI-2026-4242',
            severity: MEDIUM_CVSS,
          },
        ],
      })
    );
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block CVE IDs PyPI (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], cveBlockList: ['CVE-PYPI-2026-4242'] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Block CVE IDs PyPI (pypi test)');
      expect((fileRes.body.reasons ?? []).join(' ')).toContain('CVE');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      await app.redis.del(osvCacheKey);
    }
  });

  it('license policy blocks PyPI artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block PyPI licenses wildcard (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], licenseDenyList: ['*'] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Block PyPI licenses wildcard (pypi test)');
      expect((fileRes.body.reasons ?? []).join(' ')).toContain('License');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('release-age policy blocks PyPI artifact download', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Block PyPI release age max (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], releaseAgeMaxHours: 24 * 365 * 100 },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      const fileRes = await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      expect(fileRes.body.policyName).toBe('Block PyPI release age max (pypi test)');
      expect((fileRes.body.reasons ?? []).join(' ')).toContain('newer than');
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });

  it('writes BLOCK decision audit log for PyPI policy enforcement', async () => {
    const policyRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'Audit block pypi requests (pypi test)',
        decision: 'BLOCK',
        conditions: { ecosystem: ['pypi'], packageBlockList: [KNOWN_PYPI_PACKAGE] },
        priority: 0,
      })
      .expect(201);
    const policyId = policyRes.body.id;

    try {
      await pypiAuth(
        supertest(app.server).get(
          KNOWN_FILE_PATH
        )
      ).expect(403);
      // The ledger is written in the background; write what is buffered before reading it.
      await flushLedger(app.db);
      const auditRes = await supertest(app.server)
        .get('/api/admin/audit-logs')
        .query({ ecosystem: 'pypi', package: KNOWN_PYPI_PACKAGE, decision: 'BLOCK', limit: 20 })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const found = (auditRes.body.items ?? []).some(
        (a: { packageName: string; decision: string }) =>
          a.packageName === KNOWN_PYPI_PACKAGE && a.decision === 'BLOCK'
      );
      expect(found).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }
  });
});
