/**
 * Repository security (requirements_repository_security.md): R1 stop on errors, R2 order of `all`,
 * R5 policies follow the serving remote and `all` is never a scope, R6 namespaces bound to remotes.
 * Requires PostgreSQL + Redis (RUN_INTEGRATION=1) and the public registries, like the route suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';
import { AuditEvent } from '../db/entities/AuditEvent.js';
import { DecisionLedgerEntry } from '../db/entities/DecisionLedgerEntry.js';
import { flushLedger } from '../services/events/record.js';
import { removeAllRepositoryScopes } from '../services/repository-scope.js';
import { resetUnavailableLog } from '../services/upstream-provider.js';
import { getCircuitBreaker } from '../services/circuit-breaker.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
const PREFIX = 'qa-sec-it';
/** Refuses connections at once: the remote is down. */
const DEAD_URL = 'http://127.0.0.1:9';

type Auth = (req: supertest.Test) => supertest.Test;

type Fixture = {
  ecosystem: string;
  packageName: string;
  version: string;
  /** Artifact path through repository `key`. */
  artifact: (key: string, app: FastifyInstance, auth: Auth) => Promise<string>;
  /** A metadata path through repository `key`. */
  metadata: (key: string) => string;
};

const FIXTURES: Fixture[] = [
  {
    ecosystem: 'npm',
    packageName: 'lodash',
    version: '4.17.5',
    artifact: async (key) => `/npm/${key}/lodash/-/lodash-4.17.5.tgz`,
    metadata: (key) => `/npm/${key}/lodash`,
  },
  {
    ecosystem: 'pypi',
    packageName: 'requests',
    version: '0.2.0',
    artifact: async (key, app, auth) => {
      const index = await auth(supertest(app.server).get(`/pypi/${key}/simple/requests/`)).expect(200);
      const href = [...index.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((h) => h.includes('requests-0.2.0.tar.gz'));
      expect(href, 'requests 0.2.0 is listed').toBeDefined();
      const url = new URL(href!.replace(/&amp;/g, '&'), 'http://localhost');
      return `${url.pathname}${url.search}`;
    },
    metadata: (key) => `/pypi/${key}/simple/requests/`,
  },
  {
    ecosystem: 'go',
    packageName: 'rsc.io/quote',
    version: 'v1.5.2',
    artifact: async (key) => `/go/${key}/rsc.io/quote/@v/v1.5.2.zip`,
    metadata: (key) => `/go/${key}/rsc.io/quote/@v/list`,
  },
  {
    ecosystem: 'maven',
    packageName: 'junit:junit',
    version: '4.13.2',
    artifact: async (key) => `/maven/${key}/junit/junit/4.13.2/junit-4.13.2.pom`,
    metadata: (key) => `/maven/${key}/junit/junit/maven-metadata.xml`,
  },
  {
    ecosystem: 'nuget',
    packageName: 'newtonsoft.json',
    version: '13.0.3',
    artifact: async (key) => `/nuget/${key}/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg`,
    metadata: (key) => `/nuget/${key}/v3-flatcontainer/newtonsoft.json/index.json`,
  },
  {
    ecosystem: 'cargo',
    packageName: 'serde',
    version: '1.0.197',
    artifact: async (key) => `/cargo/${key}/api/v1/crates/serde/1.0.197/download`,
    metadata: (key) => `/cargo/${key}/api/v1/crates/serde`,
  },
  {
    ecosystem: 'composer',
    packageName: 'monolog/monolog',
    version: '2.0.0',
    artifact: async (key, app, auth) => {
      const meta = await auth(supertest(app.server).get(`/composer/${key}/p2/monolog/monolog.json`)).expect(200);
      const versions = (meta.body?.packages?.['monolog/monolog'] ?? []) as Array<{ version?: string; dist?: { url?: string } }>;
      const row = versions.find((v) => v.version === '2.0.0' && typeof v.dist?.url === 'string');
      expect(row, 'monolog/monolog 2.0.0 is listed').toBeDefined();
      const url = new URL(row!.dist!.url!);
      return `${url.pathname}${url.search}`;
    },
    metadata: (key) => `/composer/${key}/p2/monolog/monolog.json`,
  },
  {
    ecosystem: 'rubygems',
    packageName: 'rack',
    version: '2.2.3',
    artifact: async (key) => `/rubygems/${key}/gems/rack-2.2.3.gem`,
    metadata: (key) => `/rubygems/${key}/api/v1/versions/rack.json`,
  },
];

async function acquireSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    if ((await app.redis.set(SUITE_LOCK_KEY, owner, 'NX', 'PX', 900000)) === 'OK') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for integration suite lock');
}

async function releaseSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  if ((await app.redis.get(SUITE_LOCK_KEY)) === owner) await app.redis.del(SUITE_LOCK_KEY);
}

/** The newest Decision Ledger row matching `where` and `match`; the ledger is written in the background. */
async function waitForLedger(app: FastifyInstance, where: Record<string, unknown>, match: (row: DecisionLedgerEntry) => boolean) {
  for (let i = 0; i < 50; i += 1) {
    await flushLedger(app.db);
    const rows = await app.db.getRepository(DecisionLedgerEntry).find({ where, order: { createdAt: 'DESC' }, take: 10 });
    const row = rows.find(match);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** The newest Audit Log row matching `where` and `match`; it is inserted without being awaited. */
async function waitForAuditEvent(app: FastifyInstance, where: Record<string, unknown>, match: (row: AuditEvent) => boolean) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await app.db.getRepository(AuditEvent).find({ where, order: { createdAt: 'DESC' }, take: 10 });
    const row = rows.find(match);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Repository security', () => {
  let app: FastifyInstance;
  let token = '';
  let auth: Auth;
  let lockOwner = '';
  let previouslyEnabled: string[] = [];
  const repoIds: Record<string, Record<string, string>> = {};
  const created: string[] = [];

  const admin = () => ({
    get: (url: string) => supertest(app.server).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => supertest(app.server).post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => supertest(app.server).put(url).set('Authorization', `Bearer ${token}`),
    del: (url: string) => supertest(app.server).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function repositories(ecosystem: string) {
    const res = await admin().get(`/api/admin/repositories?ecosystem=${ecosystem}`).expect(200);
    const rows = res.body as Array<{ id: string; key: string; type: string; upstreamUrl: string | null; memberKeys: string[] }>;
    repoIds[ecosystem] = Object.fromEntries(rows.map((row) => [row.key, row.id]));
    return rows;
  }

  async function createRemote(ecosystem: string, key: string, upstreamUrl?: string): Promise<string> {
    const rows = await repositories(ecosystem);
    const existing = rows.find((row) => row.key === key);
    if (existing) return existing.id;
    const res = await admin()
      .post('/api/admin/repositories')
      .send({
        ecosystem,
        key,
        type: 'remote',
        upstreamUrl: upstreamUrl ?? rows.find((row) => row.key === 'default')!.upstreamUrl,
        source: 'public',
        timeoutMs: 3000,
        retryCount: 0,
      })
      .expect(201);
    created.push(res.body.id);
    repoIds[ecosystem][key] = res.body.id;
    return res.body.id as string;
  }

  async function createPolicy(body: Record<string, unknown>): Promise<string> {
    const res = await admin()
      .post('/api/admin/policies')
      .send({ decision: 'BLOCK', priority: -100000, ...body, name: `${PREFIX} ${body.name}` })
      .expect(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `repository-security-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    for (const creds of [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ]) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200 && res.body.token) {
        token = res.body.token;
        break;
      }
    }
    expect(token).not.toBe('');
    auth = (req) => req.set('Authorization', `Bearer ${token}`);
    const policies = app.db.getRepository(Policy);
    await policies.createQueryBuilder().delete().where('name LIKE :p', { p: `${PREFIX}%` }).execute();
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ isEnabled: true }, { isEnabled: false });
    for (const fixture of FIXTURES) {
      await app.db.getRepository(MaliciousPackage).delete({ ecosystem: fixture.ecosystem, name: fixture.packageName });
      await app.db.getRepository(Exception).delete({ ecosystem: fixture.ecosystem, packageName: fixture.packageName });
      await repositories(fixture.ecosystem);
    }
  }, 120000);

  afterAll(async () => {
    if (!app) return;
    try {
      await app.db.getRepository(Policy).createQueryBuilder().delete().where('name LIKE :p', { p: `${PREFIX}%` }).execute();
      for (const id of created.reverse()) await admin().del(`/api/admin/repositories/${id}`);
      for (let i = 0; i < previouslyEnabled.length; i += 500) {
        await app.db.getRepository(Policy).update({ id: In(previouslyEnabled.slice(i, i + 500)) }, { isEnabled: true });
      }
    } finally {
      await releaseSuiteLock(app, lockOwner);
      await app.close();
    }
  }, 120000);

  describe('R5: a policy on a remote covers its packages through all', () => {
    it.each(FIXTURES)('$ecosystem', async (fixture) => {
      const policyId = await createPolicy({
        name: `${fixture.ecosystem} on default`,
        conditions: { ecosystem: [fixture.ecosystem], packageBlockList: [fixture.packageName], versionRange: `=${fixture.version}` },
        repositoryIds: [repoIds[fixture.ecosystem].default],
      });
      try {
        for (const key of ['default', 'all']) {
          const res = await auth(supertest(app.server).get(await fixture.artifact(key, app, auth)));
          expect(res.status, `${fixture.ecosystem} through ${key}`).toBe(403);
          expect(JSON.stringify(res.body)).toContain(`${PREFIX} ${fixture.ecosystem} on default`);
        }
      } finally {
        await admin().del(`/api/admin/policies/${policyId}`).expect(204);
      }
    }, 120000);

    it('an exception on default lets the package through all as well', async () => {
      const policyId = await createPolicy({
        name: 'npm everywhere',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '=4.17.5' },
      });
      const exception = await admin()
        .post('/api/admin/exceptions')
        .send({
          packageName: 'lodash',
          ecosystem: 'npm',
          version: '4.17.5',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          repositoryIds: [repoIds.npm.default],
        })
        .expect(201);
      try {
        const res = await auth(supertest(app.server).get('/npm/all/lodash/-/lodash-4.17.5.tgz'));
        expect(res.status).toBe(200);
      } finally {
        await admin().del(`/api/admin/exceptions/${exception.body.id}`).expect(204);
        await admin().del(`/api/admin/policies/${policyId}`).expect(204);
      }
    }, 60000);

    it('all cannot be chosen as a scope', async () => {
      const res = await admin()
        .post('/api/admin/policies')
        .send({
          name: `${PREFIX} on all`,
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
          repositoryIds: [repoIds.npm.all],
        })
        .expect(400);
      expect(res.body.error).toMatch(/npm\/all cannot be chosen/);
      const exception = await admin()
        .post('/api/admin/exceptions')
        .send({
          packageName: 'lodash',
          ecosystem: 'npm',
          version: '*',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          repositoryIds: [repoIds.npm.all],
        })
        .expect(400);
      expect(exception.body.error).toMatch(/npm\/all cannot be chosen/);
    });

    it('on upgrade, a policy limited only to all is deleted and one with other repositories loses all', async () => {
      const repo = app.db.getRepository(Policy);
      const onlyAll = await repo.save(
        repo.create({
          name: `${PREFIX} legacy only all`,
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], packageBlockList: ['qa-sec-nothing'] },
          repositoryIds: [repoIds.npm.all],
        })
      );
      const both = await repo.save(
        repo.create({
          name: `${PREFIX} legacy all and default`,
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], packageBlockList: ['qa-sec-nothing'] },
          repositoryIds: [repoIds.npm.all, repoIds.npm.default],
        })
      );
      const removed = await removeAllRepositoryScopes(app.db);
      expect(removed.some((entry) => entry.label === 'npm/all')).toBe(true);
      expect(await repo.findOneBy({ id: onlyAll.id })).toBeNull();
      expect((await repo.findOneByOrFail({ id: both.id })).repositoryIds).toEqual([repoIds.npm.default]);
      expect(await removeAllRepositoryScopes(app.db)).toEqual([]);
    });
  });

  describe('R2: the order of all', () => {
    it('saves the order, searches in it, audits it, and appends new remotes at the end', async () => {
      await createRemote('npm', 'qa-sec-second');
      const rows = await repositories('npm');
      const all = rows.find((row) => row.key === 'all')!;
      const original = all.memberKeys;
      expect(original).toContain('qa-sec-second');
      const reordered = ['qa-sec-second', ...original.filter((key) => key !== 'qa-sec-second')];
      try {
        const saved = await admin().put(`/api/admin/repositories/${all.id}`).send({ memberKeys: reordered }).expect(200);
        expect(saved.body.memberKeys).toEqual(reordered);
        const audit = await waitForAuditEvent(app, { type: 'REPOSITORY_UPDATED', targetKind: 'repository', targetName: 'all', targetEcosystem: 'npm' }, (row) =>
          (row.reasons ?? []).some((reason) => reason.startsWith(`Order changed from ${original.join(', ')} to ${reordered.join(', ')}`))
        );
        expect(audit).not.toBeNull();

        const check = await admin()
          .post('/api/package-check')
          .send({ ecosystem: 'npm', package: 'lodash', repository: 'all', versions: ['4.17.21'] })
          .expect(200);
        expect(check.body.searchOrder[0]).toBe('npm/qa-sec-second');
        expect(check.body.servedBy).toBe('npm/qa-sec-second');

        await createRemote('npm', 'qa-sec-appended');
        const after = (await repositories('npm')).find((row) => row.key === 'all')!;
        expect(after.memberKeys.at(-1)).toBe('qa-sec-appended');
      } finally {
        const current = (await repositories('npm')).find((row) => row.key === 'all')!;
        const restored = [...original, ...current.memberKeys.filter((key) => !original.includes(key))];
        await admin().put(`/api/admin/repositories/${all.id}`).send({ memberKeys: restored }).expect(200);
      }
    }, 60000);

    it('rejects an order that misses, repeats or invents a remote', async () => {
      const all = (await repositories('npm')).find((row) => row.key === 'all')!;
      const keys = all.memberKeys;
      const missing = await admin().put(`/api/admin/repositories/${all.id}`).send({ memberKeys: keys.slice(1) }).expect(400);
      expect(missing.body.error).toMatch(/List every enabled remote of npm. Missing:/);
      const twice = await admin().put(`/api/admin/repositories/${all.id}`).send({ memberKeys: [...keys, keys[0]] }).expect(400);
      expect(twice.body.error).toMatch(/listed twice/);
      const unknown = await admin().put(`/api/admin/repositories/${all.id}`).send({ memberKeys: [...keys, 'qa-sec-none'] }).expect(400);
      expect(unknown.body.error).toMatch(/is not a remote repository of npm/);
    });
  });

  describe('R6: a namespace bound to one remote', () => {
    it('serves the reserved names only from the allowed remote, and validates the list', async () => {
      const second = await createRemote('npm', 'qa-sec-second');
      const policyId = await createPolicy({
        name: 'types bound',
        conditions: { ecosystem: ['npm'], reservedNamespaces: ['@types'], allowedRemotes: [second] },
      });
      try {
        const viaDefault = await auth(supertest(app.server).get('/npm/default/@types%2fnode'));
        expect(viaDefault.status).toBe(403);
        expect(JSON.stringify(viaDefault.body)).toContain('has none of the remotes allowed to serve it');
        await auth(supertest(app.server).get('/npm/all/@types%2fnode')).expect(200);
        const check = await admin()
          .post('/api/package-check')
          .send({ ecosystem: 'npm', package: '@types/node', repository: 'all', versions: [] })
          .expect(200);
        expect(check.body.servedBy).toBe('npm/qa-sec-second');
        expect(check.body.searchOrder).toEqual(['npm/qa-sec-second']);
        // The form's "Test a name" names the allowed remote by the policy, not as an internal one.
        const tried = await admin()
          .get('/api/admin/namespaces/check')
          .query({ ecosystem: 'npm', name: '@types/node', repository: 'all' })
          .expect(200);
        expect(tried.body.outcome).toBe('internal');
        expect(tried.body.servingRemotes).toEqual(['npm/qa-sec-second']);
        expect(tried.body.reason).toMatch(/^Served only from the remotes the policy allows \(npm\/qa-sec-second\); .*npm\/default.* not consulted/);
      } finally {
        await admin().del(`/api/admin/policies/${policyId}`).expect(204);
      }
      const virtual = await admin()
        .post('/api/admin/policies')
        .send({
          name: `${PREFIX} bad remotes`,
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], reservedNamespaces: ['@types'], allowedRemotes: [repoIds.npm.all] },
        })
        .expect(400);
      expect(virtual.body.error).toMatch(/virtual repository/);
      const otherEco = await admin()
        .post('/api/admin/policies')
        .send({
          name: `${PREFIX} bad remotes`,
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], reservedNamespaces: ['@types'], allowedRemotes: [repoIds.pypi.default] },
        })
        .expect(400);
      expect(otherEco.body.error).toMatch(/is not a npm remote/);
    }, 60000);
  });

  describe('R1: a failing remote stops the search', () => {
    beforeAll(async () => {
      resetUnavailableLog();
      for (const fixture of FIXTURES) {
        const dead = await createRemote(fixture.ecosystem, 'qa-sec-dead', DEAD_URL);
        getCircuitBreaker(`upstream:${dead}`).recordSuccess();
        const res = await admin()
          .post('/api/admin/repositories')
          .send({ ecosystem: fixture.ecosystem, key: 'qa-sec-virt', type: 'virtual', memberKeys: ['qa-sec-dead', 'default'] });
        if (res.status === 201) created.push(res.body.id);
      }
    }, 60000);

    afterAll(async () => {
      // Virtual repositories first: a remote cannot be deleted while a virtual contains it.
      for (const fixture of FIXTURES) {
        const rows = await repositories(fixture.ecosystem);
        const virt = rows.find((row) => row.key === 'qa-sec-virt');
        if (virt) await admin().del(`/api/admin/repositories/${virt.id}`);
      }
    });

    it.each(FIXTURES)('$ecosystem: 502, and the public remote after it is not used', async (fixture) => {
      const res = await auth(supertest(app.server).get(fixture.metadata('qa-sec-virt')));
      expect(res.status, `${fixture.ecosystem} metadata through a virtual whose first remote is down`).toBe(502);
      const audit = await waitForLedger(app, { decision: 'UPSTREAM_UNAVAILABLE', ecosystem: fixture.ecosystem }, (row) =>
        row.packageName === 'qa-sec-dead'
      );
      expect(audit, `${fixture.ecosystem} ledger row`).not.toBeNull();
    }, 60000);

    it('the same package through default is still served (the outage is per remote)', async () => {
      await auth(supertest(app.server).get('/npm/default/lodash')).expect(200);
    });
  });
});
