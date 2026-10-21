/**
 * Project health (OpenSSF Scorecard) rule through the real routes, against stub registries and stub
 * Scorecard and deps.dev APIs. Requires PostgreSQL + Redis (RUN_INTEGRATION=1); nothing public is contacted.
 *
 * One local HTTP server plays npm and PyPI registries under `/public/<eco>` and `/internal/<eco>`.
 * Each ecosystem gets remotes `qa-sc-public` (source public) and `qa-sc-internal` (source internal).
 * fetch() to the Scorecard API and deps.dev is answered from SCORES and DEPS_PROJECTS below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { In, Like } from 'typeorm';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { Policy } from '../db/entities/Policy.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
/** Letters only: npm tarball names end the package name at the first `-<digit>`. */
const RUN = randomUUID().replace(/[^a-f]/g, '').slice(0, 6).padEnd(6, 'q');
const name = (label: string) => `qa-sc-${label}-${RUN}`;
const project = (label: string) => `github.com/qa-sc/${label}-${RUN}`;

/** npm packages and the repository each declares. null: no repository field. */
const NPM: Record<string, string | null> = {
  [name('low')]: `https://github.com/qa-sc/low-${RUN}.git`,
  [name('high')]: `git+https://github.com/qa-sc/high-${RUN}.git`,
  [name('none')]: null,
  [name('monoa')]: `github:qa-sc/mono-${RUN}`,
  [name('monob')]: `https://github.com/qa-sc/mono-${RUN}/tree/main/packages/b`,
  [name('flaky')]: `https://github.com/qa-sc/flaky-${RUN}`,
  [name('int')]: `https://github.com/qa-sc/int-${RUN}`,
  [name('unscanned')]: `git://github.com/qa-sc/unscanned-${RUN}.git`,
  [name('ssh')]: `git+ssh://git@github.com:qa-sc/ssh-${RUN}.git`,
};
const PYPI: Record<string, string> = {
  [name('pylow')]: `https://github.com/qa-sc/pylow-${RUN}`,
  [name('pyhigh')]: `https://github.com/qa-sc/pyhigh-${RUN}`,
};

/** Scorecard API answers by project; 'fail' is a 503. */
const SCORES: Record<string, number | 'fail'> = {
  [project('low')]: 2,
  [project('high')]: 9,
  [project('mono')]: 3,
  [project('flaky')]: 'fail',
  [project('int')]: 1,
  [project('pylow')]: 2.5,
  [project('pyhigh')]: 8,
  [project('ssh')]: 2,
};
/** deps.dev GetProject answers by project, for the Scorecard backup. `unscanned` is missing from SCORES (a 404). */
const DEPS_PROJECTS: Record<string, number> = { [project('flaky')]: 1.5, [project('unscanned')]: 1.2 };

type Auth = (req: supertest.Test) => supertest.Test;

describe.skipIf(!process.env.RUN_INTEGRATION)('Project health (Scorecard) rule, stub registries and APIs', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let stub: Server;
  let stubBase = '';
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  const lockOwner = `sc-${randomUUID()}`;
  let previouslyEnabled: string[] = [];
  const createdRepos: string[] = [];
  const createdPolicies: string[] = [];
  const get = (path: string) => auth(supertest(app.server).get(path));
  const scorecardCalls = (label: string) => outbound.filter((url) => url.startsWith(config.scorecard.apiUrl) && url.includes(`${label}-${RUN}`));

  const createPolicy = async (body: Record<string, unknown>) => {
    const res = await auth(supertest(app.server).post('/api/admin/policies')).send({ decision: 'BLOCK', priority: 1, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    createdPolicies.push(res.body.id);
    return res.body as { id: string; conditions: Record<string, unknown> };
  };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const [, side, ecosystem, ...rest] = url.pathname.split('/');
      const path = decodeURIComponent(rest.join('/'));
      const base = `${stubBase}/${side}/${ecosystem}`;
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      };
      if (ecosystem === 'npm') {
        const tar = path.match(/^(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/);
        if (tar && tar[1] in NPM) return send(200, 'application/octet-stream', `${side}:${tar[1]}:${tar[2]}`);
        if (path in NPM) {
          const repo = NPM[path];
          const version = (v: string) => ({
            name: path,
            version: v,
            license: 'MIT',
            ...(repo ? { repository: { type: 'git', url: repo } } : {}),
            dist: { tarball: `${base}/${path}/-/${path}-${v}.tgz` },
          });
          return send(
            200,
            'application/json',
            JSON.stringify({
              name: path,
              'dist-tags': { latest: '1.0.0' },
              time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
              versions: { '1.0.0': version('1.0.0') },
            })
          );
        }
      }
      if (ecosystem === 'pypi') {
        const simple = path.match(/^simple\/([^/]+)\/?$/);
        if (simple && simple[1] in PYPI) {
          const file = `${simple[1].replace(/-/g, '_')}-1.0.tar.gz`;
          return send(200, 'text/html', `<html><body><a href="${base}/packages/${file}">${file}</a></body></html>`);
        }
        const doc = path.match(/^pypi\/([^/]+)\/json$/);
        if (doc && doc[1] in PYPI) {
          return send(
            200,
            'application/json',
            JSON.stringify({
              info: { license: 'MIT', project_urls: { Homepage: 'https://example.org', Source: PYPI[doc[1]] } },
              releases: { '1.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] },
            })
          );
        }
        if (path.startsWith('packages/')) return send(200, 'application/octet-stream', `${side}:${path}`);
      }
      send(404, 'application/json', '{}');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      outbound.push(url);
      const reply = (status: number, body: unknown) =>
        new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith(config.scorecard.apiUrl)) {
        const key = decodeURIComponent(url.slice(`${config.scorecard.apiUrl}/projects/`.length));
        const score = SCORES[key];
        if (score === undefined) return reply(404, null);
        if (score === 'fail') return reply(503, null);
        return reply(200, { date: '2026-10-12T00:00:00Z', repo: { name: key }, score, checks: [{ name: 'Maintained', score: 10 }] });
      }
      if (url.startsWith(config.depsDev.apiUrl)) {
        const projectMatch = url.match(/\/v3\/projects\/([^/?]+)$/);
        if (projectMatch) {
          const key = decodeURIComponent(projectMatch[1]);
          const score = DEPS_PROJECTS[key];
          return score === undefined
            ? reply(404, null)
            : reply(200, { projectKey: { id: key }, scorecard: { date: '2026-08-24T00:00:00Z', overallScore: score, checks: [] } });
        }
        return reply(404, null);
      }
      return realFetch(input, init);
    }) as typeof fetch;

    app = await buildApp();
    await app.ready();
    for (let i = 0; i < 600; i += 1) {
      if ((await app.redis.set(SUITE_LOCK_KEY, lockOwner, 'NX', 'PX', 300000)) === 'OK') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const login = await supertest(app.server).post('/api/auth/login').send({ email: 'admin@depgate.local', password: 'admin' });
    expect(login.body.token, 'admin login').toBeTruthy();
    auth = (req) => req.set('Authorization', `Bearer ${login.body.token}`);

    const policies = app.db.getRepository(Policy);
    // A run that was killed leaves its policies behind; they must not be restored as someone else's.
    const stale = await policies.find({ select: { id: true }, where: { name: Like('qa-sc-%') } });
    for (const row of stale) await auth(supertest(app.server).delete(`/api/admin/policies/${row.id}`)).expect(204);
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ id: In(previouslyEnabled) }, { isEnabled: false });

    // A run that was killed leaves its remotes behind.
    const leftovers = await app.db.getRepository(PackageRepository).find({ where: { key: In(['qa-sc-public', 'qa-sc-internal']) } });
    for (const row of leftovers) await auth(supertest(app.server).delete(`/api/admin/repositories/${row.id}`)).expect(204);

    for (const ecosystem of ['npm', 'pypi']) {
      for (const side of ['public', 'internal'] as const) {
        const res = await auth(supertest(app.server).post('/api/admin/repositories')).send({
          ecosystem,
          key: `qa-sc-${side}`,
          type: 'remote',
          upstreamUrl: `${stubBase}/${side}/${ecosystem}`,
          source: side,
          retryCount: 0,
          timeoutMs: 5000,
          description: 'qa-scorecard',
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        createdRepos.push(res.body.id);
      }
    }
  }, 180000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!app) return;
    try {
      for (const id of createdPolicies) {
        const res = await auth(supertest(app.server).delete(`/api/admin/policies/${id}`));
        if (res.status !== 204) console.error(`cleanup: policy ${id} delete returned ${res.status} ${res.text}`);
      }
      for (const id of createdRepos) await auth(supertest(app.server).delete(`/api/admin/repositories/${id}`));
      if (previouslyEnabled.length) await app.db.getRepository(Policy).update({ id: In(previouslyEnabled) }, { isEnabled: true });
    } finally {
      if ((await app.redis.get(SUITE_LOCK_KEY)) === lockOwner) await app.redis.del(SUITE_LOCK_KEY);
      await app.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }, 120000);

  describe('policy API', () => {
    it('lists the selectable checks without Webhooks', async () => {
      const res = await get('/api/admin/policies/scorecard-checks').expect(200);
      const names = (res.body.checks as Array<{ name: string }>).map((check) => check.name);
      expect(names).toHaveLength(18);
      expect(names).toContain('Dangerous-Workflow');
      expect(names).not.toContain('Webhooks');
    });

    it.each([
      [{ decision: 'ALLOW', conditions: { scorecardMinScore: 5 } }, /can block, not allow/],
      [{ conditions: { scorecardMinScore: 12 } }, /from 0 to 10/],
      [{ conditions: { scorecardChecks: [{ name: 'Webhooks', minScore: 5 }] } }, /never in public results/],
      [{ conditions: { scorecardChecks: [{ name: 'Maintained', minScore: 1 }, { name: 'maintained', minScore: 2 }] } }, /listed twice/],
      [{ conditions: { scorecardMinScore: 5, scorecardUnavailable: 'sometimes' } }, /allow or block/],
    ])('rejects %j', async (body, message) => {
      const res = await auth(supertest(app.server).post('/api/admin/policies')).send({ name: `qa-sc-bad-${RUN}`, decision: 'BLOCK', ...body });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });

    it('stores check names in their canonical spelling', async () => {
      const policy = await createPolicy({
        name: `qa-sc-canonical-${RUN}`,
        isEnabled: false,
        conditions: { ecosystem: ['npm'], scorecardChecks: [{ name: 'dangerous-WORKFLOW', minScore: 10 }] },
      });
      expect(policy.conditions.scorecardChecks).toEqual([{ name: 'Dangerous-Workflow', minScore: 10 }]);
    });
  });

  describe('npm and PyPI downloads', () => {
    let policyId = '';

    it('creates an enforced policy: overall at least 5', async () => {
      policyId = (await createPolicy({ name: `qa-sc-health-${RUN}`, conditions: { ecosystem: ['npm', 'pypi'], scorecardMinScore: 5 } })).id;
    });

    it('blocks a low-scoring npm package on download, with the reason', async () => {
      const low = name('low');
      // npm keeps blocked versions in the packument so the install requests the tarball and the 403 is recorded.
      await get(`/npm/qa-sc-public/${low}`).expect(200);
      const tar = await get(`/npm/qa-sc-public/${low}/-/${low}-1.0.0.tgz`);
      expect(tar.status).toBe(403);
      expect(tar.body.reasons[0]).toBe(`Scorecard 2 is below 5 (${project('low')}, declared by the package, 2026-10-12)`);
    });

    it('serves a high-scoring npm package', async () => {
      const high = name('high');
      await get(`/npm/qa-sc-public/${high}/-/${high}-1.0.0.tgz`).expect(200);
    });

    it('lets a package with no repository through by default', async () => {
      const none = name('none');
      await get(`/npm/qa-sc-public/${none}/-/${none}-1.0.0.tgz`).expect(200);
    });

    it('fetches one project once for two packages from the same repository', async () => {
      for (const pkg of [name('monoa'), name('monob')]) {
        const res = await get(`/npm/qa-sc-public/${pkg}/-/${pkg}-1.0.0.tgz`);
        expect(res.status).toBe(403);
      }
      expect(scorecardCalls('mono')).toHaveLength(1);
    });

    it('uses the deps.dev score while the Scorecard API fails, and says so', async () => {
      const flaky = name('flaky');
      const res = await get(`/npm/qa-sc-public/${flaky}/-/${flaky}-1.0.0.tgz`);
      expect(res.status).toBe(403);
      expect(res.body.reasons[0]).toContain('score from deps.dev');
      expect(res.body.reasons[0]).toContain('Scorecard 1.5 is below 5');
    });

    it('uses the deps.dev score when the Scorecard API has no result for the repository', async () => {
      const pkg = name('unscanned');
      const res = await get(`/npm/qa-sc-public/${pkg}/-/${pkg}-1.0.0.tgz`);
      expect(res.status).toBe(403);
      expect(res.body.reasons[0]).toBe(`Scorecard 1.2 is below 5 (${project('unscanned')}, declared by the package, 2026-08-24, score from deps.dev)`);
      expect(scorecardCalls('unscanned')).toHaveLength(1);
    });

    it('reads a repository declared as git+ssh://git@github.com:owner/repo.git', async () => {
      const pkg = name('ssh');
      const res = await get(`/npm/qa-sc-public/${pkg}/-/${pkg}-1.0.0.tgz`);
      expect(res.status).toBe(403);
      expect(res.body.reasons[0]).toContain(`Scorecard 2 is below 5 (${project('ssh')}, declared by the package`);
    });

    it('PyPI: the simple index marks a low-scoring project yanked with the reason and serves a high-scoring one', async () => {
      const low = await get(`/pypi/qa-sc-public/simple/${name('pylow')}/`).expect(200);
      expect(low.text).toMatch(/data-yanked="[^"]*Scorecard 2\.5 is below 5/);
      const high = await get(`/pypi/qa-sc-public/simple/${name('pyhigh')}/`).expect(200);
      expect(high.text).toContain('-1.0.tar.gz');
      expect(high.text).not.toContain('data-yanked');
    });

    it('Package check shows the project health panel', async () => {
      const buckets = await app.redis.keys('pkgcheck:rate:*');
      if (buckets.length) await app.redis.del(...buckets);
      const res = await auth(supertest(app.server).post('/api/package-check'))
        .send({ ecosystem: 'npm', package: name('low'), repository: 'qa-sc-public', versions: ['1.0.0'] })
        .expect(200);
      expect(res.body.projectHealth).toMatchObject({ version: '1.0.0', status: 'found', project: project('low'), overall: 2, via: 'registry' });
      expect(res.body.versions[0]).toMatchObject({ status: 'blocked', policyName: `qa-sc-health-${RUN}` });
    });

    it('the lookup endpoint answers from the cache', async () => {
      const res = await get(`/api/admin/scorecard?ecosystem=npm&package=${name('high')}&version=1.0.0&repository=qa-sc-public`).expect(200);
      expect(res.body).toMatchObject({ status: 'found', overall: 9, scoreVia: 'scorecard' });
    });

    it('with "block" for no score, a package without a repository is blocked', async () => {
      await auth(supertest(app.server).put(`/api/admin/policies/${policyId}`))
        .send({ conditions: { ecosystem: ['npm', 'pypi'], scorecardMinScore: 5, scorecardUnknown: 'block', scorecardUnavailable: 'block' } })
        .expect(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const none = name('none');
      const res = await get(`/npm/qa-sc-public/${none}/-/${none}-1.0.0.tgz`);
      expect(res.status).toBe(403);
      expect(res.body.reasons).toEqual([`No OpenSSF Scorecard result for ${none}`]);
    });

    it('an internal remote is not checked at all: no outbound call, served even with both options on block', async () => {
      const pkg = name('int');
      const since = outbound.length;
      const res = await get(`/npm/qa-sc-internal/${pkg}/-/${pkg}-1.0.0.tgz`);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      const publicServices = [config.scorecard.apiUrl, config.depsDev.apiUrl];
      const leaked = outbound
        .slice(since)
        .filter((url) => publicServices.some((base) => url.startsWith(base)) && (url.includes(pkg) || url.includes(`int-${RUN}`)));
      expect(leaked).toEqual([]);
      expect(outbound.slice(since).some((url) => url.startsWith(`${stubBase}/internal/npm`)), 'served from the internal stub').toBe(true);

      const buckets = await app.redis.keys('pkgcheck:rate:*');
      if (buckets.length) await app.redis.del(...buckets);
      const check = await auth(supertest(app.server).post('/api/package-check'))
        .send({ ecosystem: 'npm', package: pkg, repository: 'qa-sc-internal', versions: ['1.0.0'] })
        .expect(200);
      expect(check.body.projectHealth).toMatchObject({ status: 'not-applicable', reason: 'internal-remote' });
    });
  });
});
