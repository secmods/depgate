/**
 * Policy scoping per repository, across all eight ecosystems. Requires PostgreSQL + Redis
 * (RUN_INTEGRATION=1) and network access to the public registries, like the other route suites.
 *
 * Each ecosystem gets a remote `qa-scope` with the same upstream as `default`. A Block policy
 * scoped to `qa-scope` must block there and nowhere else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { WaiverRequest } from '../db/entities/WaiverRequest.js';
import { User } from '../db/entities/User.js';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';
import type { AuditEvent } from '../db/entities/AuditEvent.js';
import { auditRows } from '../test-support/event-rows.js';
import { hashPassword } from '../services/auth.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
const SCOPED_KEY = 'qa-scope';
const NAME_PREFIX = 'qa-scope-it';

type Fixture = {
  ecosystem: string;
  packageName: string;
  version: string;
  /** Artifact request path through repository `key`. */
  artifact: (key: string, app: FastifyInstance, auth: Auth) => Promise<string>;
  /** Metadata request whose body lists the version only when it is not blocked (ecosystems that filter metadata). */
  metadata?: { path: (key: string) => string; listed: (body: string) => boolean };
};

type Auth = (req: supertest.Test) => supertest.Test;

const FIXTURES: Fixture[] = [
  {
    ecosystem: 'npm',
    packageName: 'lodash',
    version: '4.17.5',
    artifact: async (key) => `/npm/${key}/lodash/-/lodash-4.17.5.tgz`,
  },
  {
    ecosystem: 'pypi',
    packageName: 'requests',
    version: '0.2.0',
    // The file link from the repository's own simple index, as pip uses it: its token names the remote that listed it.
    artifact: async (key, app, auth) => {
      const index = await auth(supertest(app.server).get(`/pypi/${key}/simple/requests/`)).expect(200);
      const href = [...index.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((h) => h.includes('requests-0.2.0.tar.gz'));
      expect(href, 'requests 0.2.0 is listed').toBeDefined();
      const url = new URL(href!.replace(/&amp;/g, '&'), 'http://localhost');
      return `${url.pathname}${url.search}`;
    },
    metadata: {
      path: (key) => `/pypi/${key}/simple/requests/`,
      // A blocked file stays listed but is marked yanked with the policy sentence.
      listed: (body) => !/requests-0\.2\.0\.tar\.gz[^>]*data-yanked|data-yanked[^>]*requests-0\.2\.0\.tar\.gz/.test(body),
    },
  },
  {
    ecosystem: 'go',
    packageName: 'rsc.io/quote',
    version: 'v1.5.2',
    artifact: async (key) => `/go/${key}/rsc.io/quote/@v/v1.5.2.zip`,
    metadata: {
      path: (key) => `/go/${key}/rsc.io/quote/@v/list`,
      listed: (body) => body.split('\n').map((line) => line.trim()).includes('v1.5.2'),
    },
  },
  {
    ecosystem: 'maven',
    packageName: 'junit:junit',
    version: '4.13.2',
    artifact: async (key) => `/maven/${key}/junit/junit/4.13.2/junit-4.13.2.pom`,
    metadata: {
      path: (key) => `/maven/${key}/junit/junit/maven-metadata.xml`,
      listed: (body) => body.includes('<version>4.13.2</version>'),
    },
  },
  {
    ecosystem: 'nuget',
    packageName: 'newtonsoft.json',
    version: '13.0.3',
    artifact: async (key) => `/nuget/${key}/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg`,
  },
  {
    ecosystem: 'cargo',
    packageName: 'serde',
    version: '1.0.197',
    artifact: async (key) => `/cargo/${key}/api/v1/crates/serde/1.0.197/download`,
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
  },
  {
    ecosystem: 'rubygems',
    packageName: 'rack',
    version: '2.2.3',
    artifact: async (key) => `/rubygems/${key}/gems/rack-2.2.3.gem`,
  },
];

/** The newest Audit Log row of a policy matching `match`; events are written in the background. */
async function latestAudit(app: FastifyInstance, where: { policyId: string; decision: string }, match: (row: AuditEvent) => boolean) {
  for (let i = 0; i < 50; i += 1) {
    const rows = await auditRows(app.db, { type: where.decision, targetKind: 'policy', targetId: where.policyId }, 5);
    const row = rows.find(match);
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function acquireSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 120000) {
    const ok = await app.redis.set(SUITE_LOCK_KEY, owner, 'NX', 'PX', 600000);
    if (ok === 'OK') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for integration suite lock');
}

async function releaseSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  if ((await app.redis.get(SUITE_LOCK_KEY)) === owner) await app.redis.del(SUITE_LOCK_KEY);
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Policy scoping per repository', () => {
  let app: FastifyInstance;
  let token = '';
  let auth: Auth;
  let lockOwner = '';
  let previouslyEnabled: string[] = [];
  let userId = '';
  let userToken = '';
  /** Repository IDs by ecosystem: the created `qa-scope` remote and the reserved ones. */
  const scoped: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  const alls: Record<string, string> = {};

  const admin = () => ({
    get: (url: string) => supertest(app.server).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => supertest(app.server).post(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => supertest(app.server).put(url).set('Authorization', `Bearer ${token}`),
    del: (url: string) => supertest(app.server).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function createPolicy(body: Record<string, unknown>): Promise<string> {
    const res = await admin()
      .post('/api/admin/policies')
      // Lowest priority number so the suite's policies come first in a paged list of a busy database.
      .send({ decision: 'BLOCK', priority: -100000, ...body, name: `${NAME_PREFIX} ${body.name}` })
      .expect(201);
    return res.body.id as string;
  }

  async function createRemote(ecosystem: string, key: string): Promise<string> {
    const list = await admin().get(`/api/admin/repositories?ecosystem=${ecosystem}`).expect(200);
    const rows = list.body as Array<{ id: string; key: string; type: string; upstreamUrl: string | null }>;
    defaults[ecosystem] = rows.find((row) => row.key === 'default')!.id;
    alls[ecosystem] = rows.find((row) => row.key === 'all')!.id;
    const existing = rows.find((row) => row.key === key);
    if (existing) return existing.id;
    const upstreamUrl = rows.find((row) => row.key === 'default')!.upstreamUrl!;
    const res = await admin()
      .post('/api/admin/repositories')
      .send({ ecosystem, key, type: 'remote', upstreamUrl, source: 'public', description: 'qa policy scoping test' })
      .expect(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `policy-scoping-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);

    for (const creds of [
      { email: 'scopeadmin@depgate.local', password: 'scopeadmin123' },
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
    await policies.createQueryBuilder().delete().where('name LIKE :p', { p: `${NAME_PREFIX}%` }).execute();
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ isEnabled: true }, { isEnabled: false });
    for (const fixture of FIXTURES) {
      await app.db.getRepository(MaliciousPackage).delete({ ecosystem: fixture.ecosystem, name: fixture.packageName });
      await app.db.getRepository(Exception).delete({ ecosystem: fixture.ecosystem, packageName: fixture.packageName });
      scoped[fixture.ecosystem] = await createRemote(fixture.ecosystem, SCOPED_KEY);
    }

    const email = `qa-scope-user-${randomUUID().slice(0, 8)}@example.com`;
    const user = await app.db
      .getRepository(User)
      .save(app.db.getRepository(User).create({ email, passwordHash: await hashPassword('qa-scope-pass'), role: 'User' }));
    userId = user.id;
    const login = await supertest(app.server).post('/api/auth/login').send({ email, password: 'qa-scope-pass' }).expect(200);
    userToken = login.body.token;
  }, 120000);

  afterAll(async () => {
    if (!app) return;
    try {
      await app.db.getRepository(Policy).createQueryBuilder().delete().where('name LIKE :p', { p: `${NAME_PREFIX}%` }).execute();
      await app.db.getRepository(WaiverRequest).delete({ requestedById: userId });
      for (const fixture of FIXTURES) {
        await app.db.getRepository(Exception).delete({ ecosystem: fixture.ecosystem, packageName: fixture.packageName });
        if (scoped[fixture.ecosystem]) await admin().del(`/api/admin/repositories/${scoped[fixture.ecosystem]}`);
      }
      if (userId) await app.db.getRepository(User).delete({ id: userId });
      for (let i = 0; i < previouslyEnabled.length; i += 500) {
        await app.db.getRepository(Policy).update({ id: In(previouslyEnabled.slice(i, i + 500)) }, { isEnabled: true });
      }
    } finally {
      await releaseSuiteLock(app, lockOwner);
      await app.close();
    }
  }, 120000);

  describe.each(FIXTURES)('$ecosystem', (fixture) => {
    it('a policy scoped to qa-scope blocks there and not through default or all', async () => {
      const policyId = await createPolicy({
        name: `${fixture.ecosystem} block`,
        conditions: {
          ecosystem: [fixture.ecosystem],
          packageBlockList: [fixture.packageName],
          versionRange: `=${fixture.version}`,
        },
        repositoryIds: [scoped[fixture.ecosystem]],
      });
      try {
        const blocked = await auth(supertest(app.server).get(await fixture.artifact(SCOPED_KEY, app, auth)));
        expect(blocked.status, `${fixture.ecosystem} through ${SCOPED_KEY}`).toBe(403);
        expect(JSON.stringify(blocked.body)).toContain(`${NAME_PREFIX} ${fixture.ecosystem} block`);

        for (const key of ['default', 'all']) {
          const served = await auth(supertest(app.server).get(await fixture.artifact(key, app, auth)));
          expect(served.status, `${fixture.ecosystem} through ${key}`).not.toBe(403);
          expect(served.status, `${fixture.ecosystem} through ${key}`).toBeLessThan(400);
        }

        if (fixture.metadata) {
          const scopedMeta = await auth(supertest(app.server).get(fixture.metadata.path(SCOPED_KEY))).expect(200);
          const defaultMeta = await auth(supertest(app.server).get(fixture.metadata.path('default'))).expect(200);
          expect(fixture.metadata.listed(scopedMeta.text), `${fixture.ecosystem} metadata through ${SCOPED_KEY}`).toBe(false);
          expect(fixture.metadata.listed(defaultMeta.text), `${fixture.ecosystem} metadata through default`).toBe(true);
        }

        // Ledger rows are written in batches within a second (L5).
        let found = false;
        for (let i = 0; i < 30 && !found; i += 1) {
          const ledger = await admin()
            .get(`/api/admin/decision-ledger?ecosystem=${fixture.ecosystem}&decision=BLOCK_ENFORCE&repository=${SCOPED_KEY}&limit=20`)
            .expect(200);
          found = (ledger.body.items as Array<{ policyId: string | null; repository: string | null }>).some(
            (row) => row.policyId === policyId && row.repository === SCOPED_KEY
          );
          if (!found) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(found).toBe(true);
      } finally {
        await admin().del(`/api/admin/policies/${policyId}`).expect(204);
      }
    }, 120000);

    it('an exception scoped to qa-scope lets the package through only there', async () => {
      const policyId = await createPolicy({
        name: `${fixture.ecosystem} block everywhere`,
        conditions: { ecosystem: [fixture.ecosystem], packageBlockList: [fixture.packageName], versionRange: `=${fixture.version}` },
      });
      const exception = await admin()
        .post('/api/admin/exceptions')
        .send({
          packageName: fixture.packageName,
          ecosystem: fixture.ecosystem,
          version: fixture.version,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'qa scoped exception',
          repositoryIds: [scoped[fixture.ecosystem]],
        })
        .expect(201);
      expect(exception.body.repositories).toEqual([
        expect.objectContaining({ id: scoped[fixture.ecosystem], key: SCOPED_KEY, ecosystem: fixture.ecosystem }),
      ]);
      try {
        const served = await auth(supertest(app.server).get(await fixture.artifact(SCOPED_KEY, app, auth)));
        expect(served.status, `${fixture.ecosystem} through ${SCOPED_KEY}`).toBeLessThan(400);
        const blocked = await auth(supertest(app.server).get(await fixture.artifact('default', app, auth)));
        expect(blocked.status, `${fixture.ecosystem} through default`).toBe(403);
      } finally {
        await admin().del(`/api/admin/exceptions/${exception.body.id}`).expect(204);
        await admin().del(`/api/admin/policies/${policyId}`).expect(204);
      }
    }, 120000);
  });

  describe('API', () => {
    it('returns scope on create, get and list, and filters the list by repository', async () => {
      const id = await createPolicy({
        name: 'api scope',
        conditions: { ecosystem: ['npm'], packageBlockList: ['qa-scope-nothing'] },
        repositoryIds: [scoped.npm],
      });
      const globalId = await createPolicy({ name: 'api global', conditions: { packageBlockList: ['qa-scope-nothing'] } });
      const pypiOnly = await createPolicy({
        name: 'api pypi',
        conditions: { ecosystem: ['pypi'], packageBlockList: ['qa-scope-nothing'] },
      });
      try {
        const one = await admin().get(`/api/admin/policies/${id}`).expect(200);
        expect(one.body.repositoryIds).toEqual([scoped.npm]);
        expect(one.body.repositories).toEqual([{ id: scoped.npm, ecosystem: 'npm', key: SCOPED_KEY, type: 'remote' }]);

        const forScoped = await admin().get(`/api/admin/policies?repositoryId=${scoped.npm}&limit=500`).expect(200);
        const ids = (forScoped.body.items as Array<{ id: string }>).map((p) => p.id);
        expect(ids).toEqual(expect.arrayContaining([id, globalId]));
        expect(ids).not.toContain(pypiOnly);

        const forDefault = await admin().get(`/api/admin/policies?repositoryId=${defaults.npm}&limit=500`).expect(200);
        expect((forDefault.body.items as Array<{ id: string }>).map((p) => p.id)).not.toContain(id);

        const onlyScoped = await admin().get('/api/admin/policies?scope=scoped&limit=500').expect(200);
        expect((onlyScoped.body.items as Array<{ id: string }>).map((p) => p.id)).toContain(id);
        expect((onlyScoped.body.items as Array<{ id: string }>).map((p) => p.id)).not.toContain(globalId);

        const effective = await admin().get(`/api/admin/repositories/${scoped.npm}/policies`).expect(200);
        const rows = effective.body as Array<{ id: string; scope: string }>;
        expect(rows.find((row) => row.id === id)?.scope).toBe('scoped');
        expect(rows.find((row) => row.id === globalId)?.scope).toBe('global');
        expect(rows.find((row) => row.id === pypiOnly)).toBeUndefined();
      } finally {
        for (const policy of [id, globalId, pypiOnly]) await admin().del(`/api/admin/policies/${policy}`).expect(204);
      }
    });

    it('rejects invalid scopes with 400 and saves nothing', async () => {
      const base = { name: `${NAME_PREFIX} invalid`, decision: 'BLOCK', priority: 0 };
      const cases = [
        { conditions: { ecosystem: ['npm'], packageBlockList: ['x'] }, repositoryIds: [randomUUID()], error: /does not exist/ },
        { conditions: { ecosystem: ['npm'], packageBlockList: ['x'] }, repositoryIds: [scoped.pypi], error: /not in this policy's ecosystem/ },
        { conditions: { ecosystem: ['npm'], packageBlockList: ['x'] }, repositoryIds: ['prod'], error: /list of repository IDs/ },
      ];
      for (const { error, ...body } of cases) {
        const res = await admin().post('/api/admin/policies').send({ ...base, ...body }).expect(400);
        expect(res.body.error).toMatch(error);
      }
      expect(await app.db.getRepository(Policy).count({ where: { name: `${NAME_PREFIX} invalid` } })).toBe(0);
    });

    it('rejects an ecosystem change that strands a scoped repository and records scope changes', async () => {
      const id = await createPolicy({
        name: 'strand',
        conditions: { ecosystem: ['npm'], packageBlockList: ['qa-scope-nothing'] },
        repositoryIds: [scoped.npm],
      });
      try {
        const res = await admin()
          .put(`/api/admin/policies/${id}`)
          .send({ conditions: { ecosystem: ['pypi'], packageBlockList: ['qa-scope-nothing'] } })
          .expect(400);
        expect(res.body.error).toContain(`npm/${SCOPED_KEY}`);

        const widened = await admin().put(`/api/admin/policies/${id}`).send({ repositoryIds: [] }).expect(200);
        expect(widened.body.repositoryIds).toEqual([]);
        const audit = await latestAudit(app, { policyId: id, decision: 'POLICY_UPDATED' }, (row) =>
          (row.reasons ?? []).includes(`Scope changed from npm/${SCOPED_KEY} to all repositories`)
        );
        expect(audit).not.toBeNull();
      } finally {
        await admin().del(`/api/admin/policies/${id}`).expect(204);
      }
    });

    it('package check names the scope of the deciding policy and honours it', async () => {
      const id = await createPolicy({
        name: 'check scope',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '=4.17.5' },
        repositoryIds: [scoped.npm],
      });
      try {
        const check = (repository: string) =>
          supertest(app.server)
            .post('/api/package-check')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ ecosystem: 'npm', package: 'lodash', repository, versions: ['4.17.5'] })
            .expect(200);
        const inScope = await check(SCOPED_KEY);
        const row = (inScope.body.versions as Array<{ version: string; status: string; policyScope?: string[] }>).find(
          (v) => v.version === '4.17.5'
        );
        expect(row?.status).toBe('blocked');
        expect(row?.policyScope).toEqual([`npm/${SCOPED_KEY}`]);
        const outside = await check('default');
        expect(
          (outside.body.versions as Array<{ version: string; status: string }>).find((v) => v.version === '4.17.5')?.status
        ).toBe('allowed');
      } finally {
        await admin().del(`/api/admin/policies/${id}`).expect(204);
      }
    }, 60000);

    it('simulation counts packages outside the candidate scope', async () => {
      const res = await admin()
        .post('/api/admin/policies/simulate')
        .send({
          policy: {
            name: 'sim',
            decision: 'BLOCK',
            priority: 0,
            conditions: { packageBlockList: ['lodash'] },
            repositoryIds: [scoped.npm],
          },
          packages: [
            { ecosystem: 'npm', name: 'lodash', version: '4.17.5', repository: SCOPED_KEY },
            { ecosystem: 'npm', name: 'lodash', version: '4.17.5', repository: 'default' },
          ],
        })
        .expect(200);
      expect(res.body.summary.outOfScope).toBe(1);
      expect(res.body.summary.newlyBlocked).toBe(1);
    });

    it('a waiver keeps the requested repository and approval copies it to the exception', async () => {
      const created = await supertest(app.server)
        .post('/api/waiver-requests')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          packageName: 'lodash',
          ecosystem: 'npm',
          version: '4.17.5',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'qa scope waiver',
          repositoryIds: [scoped.npm],
        })
        .expect(201);
      expect(created.body.repositories).toEqual([expect.objectContaining({ key: SCOPED_KEY })]);

      const rejectedScope = await supertest(app.server)
        .post('/api/waiver-requests')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          packageName: 'lodash',
          ecosystem: 'npm',
          version: '4.17.4',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'qa wrong ecosystem',
          repositoryIds: [scoped.pypi],
        })
        .expect(400);
      expect(rejectedScope.body.error).toMatch(/not in this waiver's ecosystem/);

      const approved = await admin()
        .post(`/api/waiver-requests/${created.body.id}/approve`)
        .send({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
        .expect(200);
      expect(approved.body.repositoryIds).toEqual([scoped.npm]);
      const exception = await app.db.getRepository(Exception).findOneByOrFail({ id: approved.body.exceptionId });
      expect(exception.repositoryIds).toEqual([scoped.npm]);
      await app.db.getRepository(Exception).delete({ id: exception.id });
    });

    it('the reviewer can widen a waiver to every repository on approval', async () => {
      const created = await supertest(app.server)
        .post('/api/waiver-requests')
        .set('Authorization', `Bearer ${userToken}`)
        .send({
          packageName: 'lodash',
          ecosystem: 'npm',
          version: '4.17.3',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: 'qa scope widen',
          repositoryIds: [scoped.npm],
        })
        .expect(201);
      const approved = await admin()
        .post(`/api/waiver-requests/${created.body.id}/approve`)
        .send({ expiresAt: new Date(Date.now() + 86_400_000).toISOString(), repositoryIds: [] })
        .expect(200);
      const exception = await app.db.getRepository(Exception).findOneByOrFail({ id: approved.body.exceptionId });
      expect(exception.repositoryIds).toEqual([]);
      await app.db.getRepository(Exception).delete({ id: exception.id });
    });

    it('deleting the last scoped repository disables the policy and deletes the exception', async () => {
      const temp = await createRemote('npm', 'qa-scope-temp');
      const policyId = await createPolicy({
        name: 'temp only',
        conditions: { ecosystem: ['npm'], packageBlockList: ['qa-scope-nothing'] },
        repositoryIds: [temp],
      });
      const twoRepos = await createPolicy({
        name: 'temp and scoped',
        conditions: { ecosystem: ['npm'], packageBlockList: ['qa-scope-nothing'] },
        repositoryIds: [temp, scoped.npm],
      });
      const exception = await admin()
        .post('/api/admin/exceptions')
        .send({
          packageName: 'qa-scope-nothing',
          ecosystem: 'npm',
          version: '*',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          repositoryIds: [temp],
        })
        .expect(201);
      try {
        const usage = await admin().get(`/api/admin/repositories/${temp}/usage`).expect(200);
        expect(usage.body.policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: policyId, onlyRepository: true }),
            expect.objectContaining({ id: twoRepos, onlyRepository: false }),
          ])
        );
        expect(usage.body.exceptions).toEqual([expect.objectContaining({ id: exception.body.id, onlyRepository: true })]);

        await admin().del(`/api/admin/repositories/${temp}`).expect(204);

        const disabled = await admin().get(`/api/admin/policies/${policyId}`).expect(200);
        expect(disabled.body.isEnabled).toBe(false);
        expect(disabled.body.repositories).toEqual([]);
        const narrowed = await admin().get(`/api/admin/policies/${twoRepos}`).expect(200);
        expect(narrowed.body.isEnabled).toBe(true);
        expect(narrowed.body.repositoryIds).toEqual([scoped.npm]);
        expect(await app.db.getRepository(Exception).findOneBy({ id: exception.body.id })).toBeNull();

        const audit = await latestAudit(app, { policyId, decision: 'POLICY_UPDATED' }, (row) =>
          /Disabled: its only scoped repository "npm\/qa-scope-temp" was deleted/.test(row.reasons?.[0] ?? '')
        );
        expect(audit).not.toBeNull();

        // Re-enabling it does not widen it to every repository.
        await admin().put(`/api/admin/policies/${policyId}`).send({ isEnabled: true }).expect(200);
        const check = await supertest(app.server)
          .post('/api/package-check')
          .set('Authorization', `Bearer ${userToken}`)
          .send({ ecosystem: 'npm', package: 'lodash', repository: 'default', versions: ['4.17.5'] })
          .expect(200);
        expect(JSON.stringify(check.body)).not.toContain('temp only');
      } finally {
        await admin().del(`/api/admin/policies/${policyId}`);
        await admin().del(`/api/admin/policies/${twoRepos}`);
      }
    }, 60000);
  });
});
