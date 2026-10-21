/**
 * EPSS in the Vulnerability rule through the real routes, job and database (RUN_INTEGRATION=1).
 * fetch() to the EPSS feed, its GitHub backup and OSV is answered here; no public service is contacted.
 *
 * 1. The sync job: the feed is down, today's GitHub file is not published yet, yesterday's is used;
 *    a second run of the same file swaps nothing; a truncated file is rejected and the data kept; one claim at a time.
 * 2. Policies: npm and PyPI downloads, and Cargo through Package check (a RUSTSEC advisory without a CVE),
 *    against stub registries, stub OSV and scores seeded into epss_scores.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { FastifyInstance } from 'fastify';
import { In, Like } from 'typeorm';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { Policy } from '../db/entities/Policy.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import { claimEpssSync, EPSS_STATUS_ID, invalidateEpss } from '../services/epss.js';
import { HIGH_CVSS } from '../test-support/cvss-vectors.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
const RUN = randomUUID().replace(/[^a-f]/g, '').slice(0, 6).padEnd(6, 'q');
const name = (label: string) => `qa-ep-${label}-${RUN}`;
/** CVE ids unique to this run, in a year the real feed never has. */
const SEED = Math.floor(100000 + Math.random() * 800000);
const cve = (n: number) => `CVE-2099-${SEED + n}`;

const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const FIXTURE_ROWS = 120_000;

function feedFile(day: string, rows = FIXTURE_ROWS): Buffer {
  const lines = [`#model_version:v-test,score_date:${day}T12:00:00Z`, 'cve,epss,percentile'];
  for (let i = 0; i < rows; i += 1) lines.push(`CVE-2001-${String(i).padStart(6, '0')},0.0001,0.1`);
  return gzipSync(Buffer.from(lines.join('\n')));
}

type Vuln = { id: string; aliases: string[]; severity: Array<{ type: string; score: string }> };
const HIGH = HIGH_CVSS;
const vuln = (id: string, aliases: string[]): Vuln => ({ id, aliases, severity: HIGH });

/** OSV answers per package name: every version has these vulnerabilities. */
const OSV: Record<string, Vuln[]> = {
  [name('likely')]: [vuln(`GHSA-likely-${RUN}`, [cve(1)])],
  [name('unlikely')]: [vuln(`GHSA-unlikely-${RUN}`, [cve(2)])],
  [name('listed')]: [vuln(`GHSA-listed-${RUN}`, [cve(3)])],
  [name('pylikely')]: [vuln(`PYSEC-likely-${RUN}`, [cve(4)])],
  [name('pyunlikely')]: [vuln(`PYSEC-unlikely-${RUN}`, [cve(5)])],
  [name('rustnocve')]: [vuln(`RUSTSEC-2099-${SEED}`, [])],
  [name('moving')]: [vuln(`GHSA-moving-${RUN}`, [cve(6)])],
};
const SCORES: Array<[string, number, number]> = [
  [cve(1), 0.42, 0.97],
  [cve(2), 0.02, 0.6],
  [cve(3), 0.001, 0.1],
  [cve(4), 0.5, 0.98],
  [cve(5), 0.01, 0.4],
  [cve(6), 0.03, 0.7],
];

type Auth = (req: supertest.Test) => supertest.Test;

describe.skipIf(!process.env.RUN_INTEGRATION)('EPSS: sync job and Vulnerability rule (stubs)', () => {
  let app: FastifyInstance;
  let auth: Auth;
  let stub: Server;
  let stubBase = '';
  const outbound: string[] = [];
  const realFetch = globalThis.fetch;
  const lockOwner = `ep-${randomUUID()}`;
  let previouslyEnabled: string[] = [];
  const createdRepos: string[] = [];
  const createdPolicies: string[] = [];
  /** What the EPSS sources answer: URL → [status, body]. Unlisted URLs are 404. */
  let epssSources = new Map<string, [number, Buffer | string]>();
  const get = (path: string) => auth(supertest(app.server).get(path));
  const githubUrl = (day: string) => config.epss.backupUrlTemplate.replace('{year}', day.slice(0, 4)).replace('{date}', day);

  const createPolicy = async (body: Record<string, unknown>) => {
    const res = await auth(supertest(app.server).post('/api/admin/policies')).send({ decision: 'BLOCK', priority: 1, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    createdPolicies.push(res.body.id);
    return res.body.id as string;
  };

  /** "Sync now", then the status once this run finished (its finishedAt differs from the previous run's). */
  async function syncAndWait(): Promise<Record<string, unknown>> {
    const previous = ((await get('/api/admin/epss/status')).body as Record<string, unknown>).finishedAt ?? null;
    let started = await auth(supertest(app.server).post('/api/admin/epss/sync'));
    // The previous run's queue job can still read as active for a moment after it finished.
    for (let i = 0; i < 50 && started.status === 409; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      started = await auth(supertest(app.server).post('/api/admin/epss/sync'));
    }
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    for (let i = 0; i < 600; i += 1) {
      const status = (await get('/api/admin/epss/status')).body as Record<string, unknown>;
      if (status.state !== 'running' && status.finishedAt && status.finishedAt !== previous) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('EPSS sync did not finish');
  }

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const [, ecosystem, ...rest] = url.pathname.split('/');
      const path = decodeURIComponent(rest.join('/'));
      const base = `${stubBase}/${ecosystem}`;
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      };
      if (ecosystem === 'npm') {
        const tar = path.match(/^(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/);
        if (tar && tar[1] in OSV) return send(200, 'application/octet-stream', `${tar[1]}:${tar[2]}`);
        if (path in OSV) {
          return send(
            200,
            'application/json',
            JSON.stringify({
              name: path,
              'dist-tags': { latest: '1.0.0' },
              time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
              versions: { '1.0.0': { name: path, version: '1.0.0', license: 'MIT', dist: { tarball: `${base}/${path}/-/${path}-1.0.0.tgz` } } },
            })
          );
        }
      }
      if (ecosystem === 'pypi') {
        const simple = path.match(/^simple\/([^/]+)\/?$/);
        if (simple && simple[1] in OSV) {
          const file = `${simple[1].replace(/-/g, '_')}-1.0.tar.gz`;
          return send(200, 'text/html', `<html><body><a href="${base}/packages/${file}">${file}</a></body></html>`);
        }
        const doc = path.match(/^pypi\/([^/]+)\/json$/);
        if (doc && doc[1] in OSV) {
          return send(200, 'application/json', JSON.stringify({ info: { license: 'MIT' }, releases: { '1.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] } }));
        }
      }
      if (ecosystem === 'cargo') {
        const crate = path.match(/^api\/v1\/crates\/([^/]+)$/);
        if (crate && crate[1] in OSV) {
          return send(200, 'application/json', JSON.stringify({ crate: { name: crate[1] }, versions: [{ num: '1.0.0', created_at: '2020-01-01T00:00:00Z', license: 'MIT' }] }));
        }
      }
      send(404, 'application/json', '{}');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      outbound.push(url);
      if (url === config.epss.feedUrl || url.startsWith('https://raw.githubusercontent.com/')) {
        const [status, body] = epssSources.get(url) ?? [404, 'Not Found'];
        return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status });
      }
      if (url.startsWith(config.osv.apiUrl)) {
        if (url.endsWith('/v1/querybatch')) {
          const queries = (JSON.parse(String(init?.body ?? '{}')) as { queries: Array<{ package: { name: string } }> }).queries;
          return Response.json({ results: queries.map((q) => ({ vulns: OSV[q.package.name] ?? [] })) });
        }
        return new Response('{}', { status: 404 });
      }
      if (url.startsWith(config.epss.apiUrl)) throw new Error('FIRST must not be called on the request path');
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
    const stale = await policies.find({ select: { id: true }, where: { name: Like('qa-ep-%') } });
    for (const row of stale) await auth(supertest(app.server).delete(`/api/admin/policies/${row.id}`)).expect(204);
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ id: In(previouslyEnabled) }, { isEnabled: false });

    const leftovers = await app.db.getRepository(PackageRepository).find({ where: { key: 'qa-ep-public' } });
    for (const row of leftovers) await auth(supertest(app.server).delete(`/api/admin/repositories/${row.id}`)).expect(204);
    for (const ecosystem of ['npm', 'pypi', 'cargo']) {
      const res = await auth(supertest(app.server).post('/api/admin/repositories')).send({
        ecosystem,
        key: 'qa-ep-public',
        type: 'remote',
        upstreamUrl: `${stubBase}/${ecosystem}`,
        source: 'public',
        retryCount: 0,
        timeoutMs: 5000,
        description: 'qa-epss',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      createdRepos.push(res.body.id);
    }
    // A fresh status row, so the older-file guard does not compare against data from another run.
    await app.db.query(`DELETE FROM epss_sync_status WHERE id = $1`, [EPSS_STATUS_ID]);
  }, 180000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (!app) return;
    try {
      for (const id of createdPolicies) await auth(supertest(app.server).delete(`/api/admin/policies/${id}`));
      for (const id of createdRepos) await auth(supertest(app.server).delete(`/api/admin/repositories/${id}`));
      if (previouslyEnabled.length) await app.db.getRepository(Policy).update({ id: In(previouslyEnabled) }, { isEnabled: true });
      // The fixture replaced the table: leave neither its rows nor a status row that claims them.
      await app.db.query(`DELETE FROM epss_scores WHERE cve_id LIKE 'CVE-2099-%' OR cve_id LIKE 'CVE-2001-%'`);
      await app.db.query(`DELETE FROM epss_sync_status WHERE id = $1`, [EPSS_STATUS_ID]);
      await invalidateEpss();
    } finally {
      if ((await app.redis.get(SUITE_LOCK_KEY)) === lockOwner) await app.redis.del(SUITE_LOCK_KEY);
      await app.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }, 120000);

  describe('sync job', () => {
    it('uses the GitHub backup when the feed is down: today is not published, yesterday is', async () => {
      epssSources = new Map([
        [config.epss.feedUrl, [503, 'Service Unavailable']],
        [githubUrl(YESTERDAY), [200, feedFile(YESTERDAY)]],
      ]);
      const status = await syncAndWait();
      expect(status).toMatchObject({ state: 'completed', rowCount: FIXTURE_ROWS, modelVersion: 'v-test', feedSource: githubUrl(YESTERDAY), lastError: null });
      expect(status.scoreDate).toBe(`${YESTERDAY}T12:00:00Z`);
      expect(outbound).toContain(githubUrl(TODAY));
      const [{ n }] = await app.db.query(`SELECT count(*)::int AS n FROM epss_scores`);
      expect(n).toBe(FIXTURE_ROWS);
    });

    it('the same file again swaps nothing', async () => {
      const before = await app.db.query(`SELECT count(*)::int AS n FROM epss_scores`);
      const status = await syncAndWait();
      expect(status).toMatchObject({ state: 'completed', rowCount: FIXTURE_ROWS });
      expect(await app.db.query(`SELECT count(*)::int AS n FROM epss_scores`)).toEqual(before);
    });

    it('a truncated file is rejected and the last good data kept', async () => {
      epssSources = new Map([[config.epss.feedUrl, [200, feedFile(TODAY, 50)]]]);
      const status = await syncAndWait();
      expect(status.state).toBe('failed');
      expect(String(status.lastError)).toMatch(/50 rows, fewer than 100000/);
      expect(status.rowCount).toBe(FIXTURE_ROWS);
      expect(status.scoreDate).toBe(`${YESTERDAY}T12:00:00Z`);
    });

    it('the feed answering with today’s file replaces the data and records the feed as source', async () => {
      epssSources = new Map([[config.epss.feedUrl, [200, feedFile(TODAY, FIXTURE_ROWS + 5)]]]);
      const status = await syncAndWait();
      expect(status).toMatchObject({ state: 'completed', rowCount: FIXTURE_ROWS + 5, feedSource: config.epss.feedUrl });
    });

    it('an older file is rejected', async () => {
      epssSources = new Map([[config.epss.feedUrl, [200, feedFile('2020-01-01')]]]);
      const status = await syncAndWait();
      expect(status.state).toBe('failed');
      expect(String(status.lastError)).toMatch(/older than the stored/);
    });

    it('only one sync can be claimed at a time', async () => {
      expect(await claimEpssSync(app.db, 'manual')).toBe(true);
      expect(await claimEpssSync(app.db, 'manual')).toBe(false);
      const busy = await auth(supertest(app.server).post('/api/admin/epss/sync'));
      expect([202, 409]).toContain(busy.status);
      await app.db.query(`UPDATE epss_sync_status SET state = 'completed' WHERE id = $1`, [EPSS_STATUS_ID]);
    });
  });

  describe('Vulnerability rule with EPSS', () => {
    let policyId = '';
    /** Day of the stored scores, as reasons show it. */
    let DAY = '';

    beforeAll(async () => {
      DAY = String(((await get('/api/admin/epss/status')).body as { scoreDate: string }).scoreDate).slice(0, 10);
      await app.db.query(
        `INSERT INTO epss_scores (cve_id, score, percentile) SELECT * FROM unnest($1::varchar[], $2::real[], $3::real[])
         ON CONFLICT (cve_id) DO UPDATE SET score = EXCLUDED.score, percentile = EXCLUDED.percentile`,
        [SCORES.map((row) => row[0]), SCORES.map((row) => row[1]), SCORES.map((row) => row[2])]
      );
      await invalidateEpss();
      policyId = await createPolicy({
        name: `qa-ep-exploitable-${RUN}`,
        conditions: { ecosystem: ['npm', 'pypi', 'cargo'], cvssMin: 7, epssMin: 0.1, cveBlockList: [cve(3)] },
      });
    });

    const tarball = (pkg: string) => get(`/npm/qa-ep-public/${pkg}/-/${pkg}-1.0.0.tgz`);

    it('npm: blocks a CVSS 8.8 vulnerability at EPSS 42 % with the score and date, serves one at 2 %', async () => {
      const blocked = await tarball(name('likely'));
      expect(blocked.status).toBe(403);
      expect(blocked.body.reasons).toEqual([
        `GHSA-likely-${RUN} (${cve(1)}): CVSS 3.1 8.8, EPSS 42 % (97th percentile, ${DAY})`,
      ]);
      await tarball(name('unlikely')).expect(200);
    });

    it('a listed CVE blocks whatever its EPSS', async () => {
      const res = await tarball(name('listed'));
      expect(res.status).toBe(403);
      expect(res.body.reasons[0]).toBe(`CVE(s) in block list: ${cve(3)}`);
    });

    it('PyPI: the simple index yanks the likely one and serves the unlikely one', async () => {
      const likely = await get(`/pypi/qa-ep-public/simple/${name('pylikely')}/`).expect(200);
      expect(likely.text).toMatch(/data-yanked="[^"]*EPSS 50 %/);
      const unlikely = await get(`/pypi/qa-ep-public/simple/${name('pyunlikely')}/`).expect(200);
      expect(unlikely.text).not.toContain('data-yanked');
    });

    it('Cargo: a RUSTSEC advisory without a CVE matches with epssUnknown match, not with ignore', async () => {
      const check = async () => {
        const buckets = await app.redis.keys('pkgcheck:rate:*');
        if (buckets.length) await app.redis.del(...buckets);
        return auth(supertest(app.server).post('/api/package-check'))
          .send({ ecosystem: 'cargo', package: name('rustnocve'), repository: 'qa-ep-public', versions: ['1.0.0'] })
          .expect(200);
      };
      const matched = await check();
      expect(matched.body.versions[0]).toMatchObject({ status: 'blocked' });
      expect(matched.body.versions[0].reasons[0]).toBe(`RUSTSEC-2099-${SEED}: CVSS 3.1 8.8, EPSS unknown (no CVE id)`);
      expect(matched.body.versions[0].vulnerabilities[0]).toMatchObject({ cves: [], cvss: { score: 8.8, version: '3.1' }, epss: null });

      await auth(supertest(app.server).put(`/api/admin/policies/${policyId}`))
        .send({ conditions: { ecosystem: ['npm', 'pypi', 'cargo'], cvssMin: 7, epssMin: 0.1, epssUnknown: 'ignore', cveBlockList: [cve(3)] } })
        .expect(200);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await check()).body.versions[0].status).toBe('allowed');
    });

    it('Package check shows EPSS per vulnerability', async () => {
      const buckets = await app.redis.keys('pkgcheck:rate:*');
      if (buckets.length) await app.redis.del(...buckets);
      const res = await auth(supertest(app.server).post('/api/package-check'))
        .send({ ecosystem: 'npm', package: name('likely'), repository: 'qa-ep-public', versions: ['1.0.0'] })
        .expect(200);
      expect(res.body.epssDate).toBe(DAY);
      expect(res.body.versions[0].vulnerabilities[0]).toMatchObject({ id: cve(1), cves: [cve(1)], epss: { score: expect.closeTo(0.42, 5), percentile: expect.closeTo(0.97, 5) } });
    });

    it('a score change applies on the next request, with no restart', async () => {
      await tarball(name('moving')).expect(200);
      await app.db.query(`UPDATE epss_scores SET score = 0.8 WHERE cve_id = $1`, [cve(6)]);
      await invalidateEpss();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const res = await tarball(name('moving'));
      expect(res.status).toBe(403);
      expect(res.body.reasons[0]).toContain('EPSS 80 %');
    });

    it('the CVE lookup endpoint answers from the store; no request reached FIRST', async () => {
      const res = await get(`/api/admin/epss/${cve(1)}`).expect(200);
      expect(res.body).toMatchObject({ cve: cve(1), scoreDate: DAY });
      await get('/api/admin/epss/CVE-2099-1').expect(400);
      expect(outbound.some((url) => url.startsWith(config.epss.apiUrl))).toBe(false);
    });
  });
});
