/**
 * Package check integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1) and
 * network access to the public registries and OSV, like the proxy integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import bcrypt from 'bcrypt';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { User } from '../db/entities/User.js';

const PRIORITY = -2_000_000;
// License tests run while the per-ecosystem package policies above are still enabled, so they go first.

type Case = {
  ecosystem: string;
  pkg: string;
  /** The name the gateway evaluates, when the client sends it differently. */
  evaluated?: string;
  blocked: string;
  excepted: string;
  download: (version: string) => string;
};

const CASES: Case[] = [
  { ecosystem: 'npm', pkg: 'lodash', blocked: '4.17.20', excepted: '4.17.21', download: (v) => `/npm/lodash/-/lodash-${v}.tgz` },
  {
    ecosystem: 'pypi',
    pkg: 'requests',
    blocked: '2.31.0',
    excepted: '2.32.3',
    download: (v) =>
      `/pypi/files/requests/requests-${v}.tar.gz`,
  },
  { ecosystem: 'go', pkg: 'golang.org/x/text', blocked: 'v0.14.0', excepted: 'v0.15.0', download: (v) => `/go/golang.org/x/text/@v/${v}.zip` },
  {
    ecosystem: 'maven',
    pkg: 'org.slf4j:slf4j-api',
    blocked: '2.0.12',
    excepted: '2.0.13',
    download: (v) => `/maven/org/slf4j/slf4j-api/${v}/slf4j-api-${v}.jar`,
  },
  {
    ecosystem: 'nuget',
    pkg: 'newtonsoft.json',
    blocked: '13.0.2',
    excepted: '13.0.3',
    download: (v) => `/nuget/v3-flatcontainer/newtonsoft.json/${v}/newtonsoft.json.${v}.nupkg`,
  },
  { ecosystem: 'cargo', pkg: 'serde', blocked: '1.0.197', excepted: '1.0.198', download: (v) => `/cargo/api/v1/crates/serde/${v}/download` },
  {
    ecosystem: 'composer',
    pkg: 'monolog/monolog',
    blocked: '3.5.0',
    excepted: '3.6.0',
    download: (v) =>
      `/composer/dist/monolog/monolog/${v}`,
  },
  {
    ecosystem: 'rubygems',
    pkg: 'rake',
    blocked: '13.1.0',
    excepted: '13.2.1',
    download: (v) => `/rubygems/gems/rake-${v}.gem`,
  },
];

async function securityToken(app: FastifyInstance): Promise<string> {
  for (const creds of [
    { email: 'admin@depgate.local', password: 'admin' },
    { email: 'npmpolicyadmin@depgate.local', password: 'npmpolicyadmin123' },
  ]) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token as string;
  }
  throw new Error('Could not obtain a Security token');
}

describe.skipIf(!process.env.RUN_INTEGRATION)('POST /api/package-check', () => {
  const timeout = 60_000;
  let app: FastifyInstance;
  let security: string;
  let user: string;
  const userName = `pkgcheck-user-${Date.now()}@depgate.local`;
  const policyIds: string[] = [];
  const exceptionIds: string[] = [];

  const check = (token: string | null, body: Record<string, unknown>) => {
    const req = supertest(app.server).post('/api/package-check').send(body);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  const limits = config.packageCheck as { rateLimitPerMinute: number };
  const configuredLimit = limits.rateLimitPerMinute;

  beforeAll(async () => {
    // The suite makes more checks than one user may per minute; the limit has its own test.
    limits.rateLimitPerMinute = 0;
    app = await buildApp();
    await app.ready();
    security = await securityToken(app);
    const users = app.db.getRepository(User);
    await users.save(users.create({ email: userName, passwordHash: await bcrypt.hash('pkgcheck-pass', 10), role: 'User' }));
    const login = await supertest(app.server).post('/api/auth/login').send({ email: userName, password: 'pkgcheck-pass' });
    user = login.body.token;
  }, timeout);

  afterAll(async () => {
    limits.rateLimitPerMinute = configuredLimit;
    if (!app) return;
    if (policyIds.length) await app.db.getRepository(Policy).delete(policyIds);
    if (exceptionIds.length) await app.db.getRepository(Exception).delete(exceptionIds);
    await app.db.getRepository(User).delete({ email: userName });
    await app.close();
  });

  it('rejects unauthenticated callers and accepts User and Security', async () => {
    await check(null, { ecosystem: 'npm', package: 'lodash' }).expect(401);
    const asUser = await check(user, { ecosystem: 'npm', package: 'lodash', limit: 1 });
    expect(asUser.status).toBe(200);
    const asSecurity = await check(security, { ecosystem: 'npm', package: 'lodash', limit: 1 });
    expect(asSecurity.status).toBe(200);
  }, timeout);

  it('limits checks per user with 429 and Retry-After', async () => {
    limits.rateLimitPerMinute = 2;
    try {
      const keys = await app.redis.keys('pkgcheck:rate:*');
      if (keys.length) await app.redis.del(...keys);
      await check(user, { ecosystem: 'npm', package: 'lodash', limit: 1 }).expect(200);
      await check(user, { ecosystem: 'npm', package: 'lodash', limit: 1 }).expect(200);
      const limited = await check(user, { ecosystem: 'npm', package: 'lodash', limit: 1 });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      limits.rateLimitPerMinute = 0;
    }
  }, timeout);

  it('validates input with 400', async () => {
    await check(security, { ecosystem: 'leftpad', package: 'x' }).expect(400);
    await check(security, { ecosystem: 'npm', package: '' }).expect(400);
    await check(security, { ecosystem: 'npm', package: 'a'.repeat(513) }).expect(400);
    await check(security, { ecosystem: 'npm', package: '../etc/passwd' }).expect(400);
    await check(security, { ecosystem: 'maven', package: 'no-colon' }).expect(400);
    await check(security, { ecosystem: 'npm', package: 'lodash', versions: ['^4.0.0'] }).expect(400);
    await check(security, { ecosystem: 'npm', package: 'lodash', repository: 'does-not-exist' }).expect(400);
    const named = await check(security, { ecosystem: 'pypi', package: 'requests', versions: ['2.0.0rc1'], limit: 1 });
    expect(named.status).toBe(200);
  }, timeout);

  it('returns 404 for a package the repository does not list', async () => {
    const res = await check(security, { ecosystem: 'npm', package: `depgate-no-such-package-${Date.now()}` });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('default');
  }, timeout);

  describe.each(CASES)('$ecosystem: the check agrees with a download', (c) => {
    let policyName: string;

    beforeAll(async () => {
      policyName = `Package check ${c.ecosystem} ${Date.now()}`;
      const created = await supertest(app.server)
        .post('/api/admin/policies')
        .set('Authorization', `Bearer ${security}`)
        .send({
          name: policyName,
          decision: 'BLOCK',
          priority: PRIORITY,
          conditions: { ecosystem: [c.ecosystem], packageBlockList: [c.evaluated ?? c.pkg] },
        })
        .expect(201);
      policyIds.push(created.body.id);
      const exceptions = app.db.getRepository(Exception);
      const exception = await exceptions.save(
        exceptions.create({
          ecosystem: c.ecosystem,
          packageName: c.evaluated ?? c.pkg,
          version: c.excepted,
          expiresAt: new Date(Date.now() + 3_600_000),
          approvedBy: 'package-check-test',
        })
      );
      exceptionIds.push(exception.id);
    }, timeout);

    it('blocked, excepted and download 403 all name the same policy', async () => {
      const res = await check(security, {
        ecosystem: c.ecosystem,
        package: c.pkg,
        versions: [c.blocked, c.excepted],
        limit: 1,
      });
      expect(res.status).toBe(200);
      const rows = Object.fromEntries((res.body.versions as Array<{ version: string }>).map((row) => [row.version, row]));
      expect(rows[c.blocked]).toMatchObject({ status: 'blocked', policyName, requested: true });
      expect(rows[c.excepted]).toMatchObject({ status: 'allowed', policyName: 'Exception' });
      expect(res.body.recommended?.version).toBe(c.excepted);
      expect(JSON.stringify(res.body)).not.toContain(policyIds[policyIds.length - 1]);

      const download = await supertest(app.server)
        .get(c.download(c.blocked))
        .set('Authorization', `Bearer ${security}`);
      expect(download.status).toBe(403);
      expect(download.body.policyName).toBe(policyName);
      expect(download.body.checkUrl).toContain('/package-check?');
      expect(download.body.checkUrl).toContain(`ecosystem=${c.ecosystem}`);
    }, timeout);
  });

  it('applies a policy saved on another replica at once, even if its cache message was lost', async () => {
    const pkg = 'is-odd';
    const name = `Package check replica ${Date.now()}`;
    const before = await check(security, { ecosystem: 'npm', package: pkg, limit: 1 });
    expect(before.status).toBe(200);
    expect(before.body.versions[0].policyName).not.toBe(name);

    // Another replica's save: the row and the Redis generation change, but no pub/sub reaches this process.
    const inserted = await app.db
      .createQueryBuilder()
      .insert()
      .into(Policy)
      .callListeners(false)
      .values({
        name,
        decision: 'BLOCK',
        priority: PRIORITY,
        isEnabled: true,
        conditions: { ecosystem: ['npm'], packageBlockList: [pkg] },
      })
      .returning('id')
      .execute();
    policyIds.push(inserted.identifiers[0].id as string);
    await app.redis.incr('depgate:gen:policies');

    const after = await check(security, { ecosystem: 'npm', package: pkg, limit: 1 });
    expect(after.body.versions[0]).toMatchObject({ status: 'blocked', policyName: name });
  }, timeout);

  it('allows only approved licenses: listed ones pass, others are blocked with the reason', async () => {
    const name = `Package check approved licenses ${Date.now()}`;
    const created = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${security}`)
      .send({ name, decision: 'BLOCK', priority: PRIORITY - 1, conditions: { ecosystem: ['npm'], licenseAllowList: ['MIT'] } })
      .expect(201);
    policyIds.push(created.body.id);

    try {
      const mit = await check(security, { ecosystem: 'npm', package: 'lodash', versions: ['4.17.21'], limit: 1 });
      expect(mit.body.versions.find((row: { version: string }) => row.version === '4.17.21')).toMatchObject({ status: 'allowed' });

      const apache = await check(security, { ecosystem: 'npm', package: 'typescript', versions: ['5.4.5'], limit: 1 });
      expect(apache.body.versions.find((row: { version: string }) => row.version === '5.4.5')).toMatchObject({
        status: 'blocked',
        policyName: name,
        reasons: ['License "Apache-2.0" is not in the approved list'],
      });
    } finally {
      // Other tests check npm and PyPI packages under other licenses.
      await app.db.getRepository(Policy).delete(created.body.id);
    }
  }, timeout);

  it('reads the PyPI license expression (PEP 639) for an allow-only policy', async () => {
    const name = `Package check PyPI licenses ${Date.now()}`;
    const created = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${security}`)
      .send({ name, decision: 'BLOCK', priority: PRIORITY - 1, conditions: { ecosystem: ['pypi'], licenseAllowList: ['BSD-3-Clause'] } })
      .expect(201);
    policyIds.push(created.body.id);

    try {
      const django = await check(security, { ecosystem: 'pypi', package: 'django', limit: 1 });
      expect(django.body.versions[0]).toMatchObject({ status: 'allowed' });
      const requests = await check(security, { ecosystem: 'pypi', package: 'requests', limit: 1 });
      expect(requests.body.versions[0]).toMatchObject({ status: 'blocked', reasons: ['License "Apache-2.0" is not in the approved list'] });
    } finally {
      // Other tests check npm and PyPI packages under other licenses.
      await app.db.getRepository(Policy).delete(created.body.id);
    }
  }, timeout);

  it('rejects a license policy with both lists', async () => {
    await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${security}`)
      .send({
        name: `Both lists ${Date.now()}`,
        decision: 'BLOCK',
        conditions: { licenseAllowList: ['MIT'], licenseDenyList: ['GPL-3.0'] },
      })
      .expect(400);
  }, timeout);

  it('marks rows incomplete and recommends nothing when OSV is unreachable', async () => {
    const osv = config.osv as { apiUrl: string };
    const original = osv.apiUrl;
    const pkg = 'left-pad';
    const keys = await app.redis.keys(`osv:vuln:v2:npm:${pkg}:*`);
    if (keys.length) await app.redis.del(...keys);
    const created = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${security}`)
      .send({
        name: `Package check CVE ${Date.now()}`,
        decision: 'BLOCK',
        priority: PRIORITY,
        conditions: { ecosystem: ['npm'], cvssMin: 9 },
      })
      .expect(201);
    policyIds.push(created.body.id);
    osv.apiUrl = 'http://127.0.0.1:9';
    try {
      const res = await check(security, { ecosystem: 'npm', package: pkg, limit: 3 });
      expect(res.status).toBe(200);
      for (const row of res.body.versions as Array<{ status: string; incomplete?: string[] }>) {
        expect(row.status).toBe('allowed');
        expect(row.incomplete).toContain('cve');
      }
      expect(res.body.recommended).toBeNull();
    } finally {
      osv.apiUrl = original;
    }
  }, timeout);
});
