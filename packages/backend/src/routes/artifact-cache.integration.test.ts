/**
 * Artifact cache (requirements_artifact_cache.md §12) through the real routes of all eight ecosystems, against
 * stub registries. Requires PostgreSQL + Redis (RUN_INTEGRATION=1); no public registry is contacted.
 *
 * One local HTTP server plays a public registry (`/public/<eco>`) and an internal one (`/internal/<eco>`), and
 * serves version 1.0.0 of any package name, so each test uses a name of its own. Each ecosystem gets remotes
 * `qa-ac-public` (public) and `qa-ac-internal` (internal). Pod A is the app under test; pod B (a second app on
 * its own directory) joins for the two-pod purge, and pod C runs with an unusable directory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import http, { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { In, Like } from 'typeorm';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import { auditRows, capturePublished, poll } from '../test-support/event-rows.js';
import { packageDir, type CacheEcosystem } from '../services/artifact-cache/layout.js';
import { CACHE_HEADER } from '../services/artifact-cache/reply.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
/** Letters only: npm and RubyGems file names end the package name at the first `-<digit>`. */
const RUN = randomUUID().replace(/[^a-f]/g, '').slice(0, 6).padEnd(6, 'q');
const VERSION = '1.0.0';
const HEADER = CACHE_HEADER.toLowerCase();

type Side = 'public' | 'internal';
type Auth = (req: supertest.Test) => supertest.Test;
type Ctx = { app: FastifyInstance; auth: Auth };
type Served = { type: string; body: Buffer | string; artifactOf?: string };

type Fixture = {
  ecosystem: CacheEcosystem;
  /** A package name of this test run for `label` (letters only). */
  name: (label: string) => string;
  /** The gateway path of the version's main file through repository `repo`; may read metadata for the URL. */
  artifact: (ctx: Ctx, repo: string, name: string, version?: string) => Promise<string>;
  /** The stub's answer for a path on one side, or null for 404. */
  serve: (side: Side, base: string, path: string) => Served | null;
};

/** The file bytes: big enough to arrive in several chunks, and different per side, package and version. */
function fileBytes(side: Side, ecosystem: string, name: string, version: string): Buffer {
  const head = Buffer.from(`${side}:${ecosystem}:${name}:${version}:`);
  return Buffer.concat([head, Buffer.alloc(96 * 1024, name.length % 251)]);
}

const art = (side: Side, eco: string, name: string, version: string): Served => ({
  type: 'application/octet-stream',
  body: fileBytes(side, eco, name, version),
  artifactOf: name,
});
const json = (value: unknown): Served => ({ type: 'application/json', body: JSON.stringify(value) });
const text = (value: string): Served => ({ type: 'text/plain', body: value });

const FIXTURES: Fixture[] = [
  {
    ecosystem: 'npm',
    name: (label) => `qa-ac-${label}-${RUN}`,
    artifact: async (_ctx, repo, name, version = VERSION) => `/npm/${repo}/${name}/-/${name}-${version}.tgz`,
    serve: (side, base, p) => {
      const tar = p.match(/^([^/]+)\/-\/[^/]+-(\d[^/]*)\.tgz$/);
      if (tar) return art(side, 'npm', tar[1], tar[2]);
      if (p.includes('/')) return null;
      return json({
        name: p,
        'dist-tags': { latest: VERSION },
        time: { [VERSION]: '2020-01-01T00:00:00.000Z' },
        versions: { [VERSION]: { name: p, version: VERSION, license: 'MIT', dist: { tarball: `${base}/${p}/-/${p}-${VERSION}.tgz` } } },
      });
    },
  },
  {
    ecosystem: 'pypi',
    name: (label) => `qa-ac-${label}-${RUN}`,
    artifact: async ({ app, auth }, repo, name, version = VERSION) => {
      const page = await auth(supertest(app.server).get(`/pypi/${repo}/simple/${name}/`)).expect(200);
      const href = [...page.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((h) => h.includes(`-${version}.tar.gz`));
      expect(href, `${name} ${version} is listed`).toBeDefined();
      const url = new URL(href!.replace(/&amp;/g, '&'));
      return `${url.pathname}${url.search}`;
    },
    serve: (side, base, p) => {
      const simple = p.match(/^simple\/([^/]+)\/?$/);
      if (simple) {
        const file = `${simple[1].replace(/-/g, '_')}-${VERSION}.tar.gz`;
        return { type: 'text/html', body: `<html><body><a href="${base}/packages/${file}">${file}</a></body></html>` };
      }
      const doc = p.match(/^pypi\/([^/]+)\/json$/);
      if (doc) return json({ info: { license: 'MIT' }, releases: { [VERSION]: [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }] } });
      const file = p.match(/^packages\/(.+)-(\d[^-]*)\.tar\.gz$/);
      return file ? art(side, 'pypi', file[1].replace(/_/g, '-'), file[2]) : null;
    },
  },
  {
    ecosystem: 'go',
    name: (label) => `example.test/qa${RUN}/${label}`,
    artifact: async (_ctx, repo, name, version = VERSION) => `/go/${repo}/${name}/@v/v${version}.zip`,
    serve: (side, _base, p) => {
      const m = p.match(/^(.+)\/@v\/(list|([^/]+)\.(info|mod|zip))$/);
      if (!m) return null;
      if (m[2] === 'list') return text(`v${VERSION}\n`);
      if (m[4] === 'info') return json({ Version: m[3], Time: '2020-01-01T00:00:00Z' });
      if (m[4] === 'mod') return text(`module ${m[1]}\n`);
      return art(side, 'go', m[1], m[3].replace(/^v/, ''));
    },
  },
  {
    ecosystem: 'maven',
    name: (label) => `test.qa${RUN}:${label}`,
    artifact: async (_ctx, repo, name, version = VERSION) => {
      const [group, artifact] = name.split(':');
      return `/maven/${repo}/${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
    },
    serve: (side, _base, p) => {
      const meta = p.match(/^(.+)\/([^/]+)\/maven-metadata\.xml$/);
      if (meta) {
        return {
          type: 'application/xml',
          body: `<metadata><versioning><latest>${VERSION}</latest><versions><version>${VERSION}</version></versions></versioning></metadata>`,
        };
      }
      const jar = p.match(/^(.+)\/([^/]+)\/([^/]+)\/[^/]+\.(jar|pom)$/);
      if (!jar) return null;
      return art(side, 'maven', `${jar[1].replace(/\//g, '.')}:${jar[2]}`, jar[3]);
    },
  },
  {
    ecosystem: 'nuget',
    name: (label) => `qa${RUN}.${label}`,
    artifact: async (_ctx, repo, name, version = VERSION) => `/nuget/${repo}/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`,
    serve: (side, _base, p) => {
      if (/^v3-flatcontainer\/[^/]+\/index\.json$/.test(p)) return json({ versions: [VERSION] });
      const pkg = p.match(/^v3-flatcontainer\/([^/]+)\/([^/]+)\/[^/]+\.(nupkg|nuspec)$/);
      return pkg ? art(side, 'nuget', pkg[1], pkg[2]) : null;
    },
  },
  {
    ecosystem: 'cargo',
    name: (label) => `qa-ac-${label}-${RUN}`,
    artifact: async (_ctx, repo, name, version = VERSION) => `/cargo/${repo}/api/v1/crates/${name}/${version}/download`,
    serve: (side, _base, p) => {
      const meta = p.match(/^api\/v1\/crates\/([^/]+)$/);
      if (meta) {
        return json({
          crate: { name: meta[1], max_version: VERSION },
          versions: [{ num: VERSION, created_at: '2020-01-01T00:00:00Z', license: 'MIT', yanked: false }],
        });
      }
      const dl = p.match(/^api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/);
      return dl ? art(side, 'cargo', dl[1], dl[2]) : null;
    },
  },
  {
    ecosystem: 'composer',
    name: (label) => `qa${RUN}/${label}`,
    artifact: async ({ app, auth }, repo, name, version = VERSION) => {
      const meta = await auth(supertest(app.server).get(`/composer/${repo}/p2/${name}.json`)).expect(200);
      const rows = (meta.body?.packages?.[name] ?? []) as Array<{ version?: string; dist?: { url?: string } }>;
      const row = rows.find((r) => r.version === version);
      expect(row?.dist?.url, `${name} ${version} is listed`).toBeDefined();
      const url = new URL(row!.dist!.url!);
      return `${url.pathname}${url.search}`;
    },
    serve: (side, base, p) => {
      const meta = p.match(/^p2\/([^/]+\/[^/]+)\.json$/);
      if (meta) {
        if (meta[1].endsWith('~dev')) return null;
        return json({
          packages: {
            [meta[1]]: [
              {
                name: meta[1],
                version: VERSION,
                version_normalized: `${VERSION}.0`,
                time: '2020-01-01T00:00:00+00:00',
                license: ['MIT'],
                dist: { type: 'zip', url: `${base}/dist/${meta[1]}/${VERSION}.zip`, reference: 'abc123' },
              },
            ],
          },
        });
      }
      const dist = p.match(/^dist\/([^/]+\/[^/]+)\/([^/]+)\.zip$/);
      return dist ? art(side, 'composer', dist[1], dist[2]) : null;
    },
  },
  {
    ecosystem: 'rubygems',
    name: (label) => `qa-ac-${label}-${RUN}`,
    artifact: async (_ctx, repo, name, version = VERSION) => `/rubygems/${repo}/gems/${name}-${version}.gem`,
    serve: (side, _base, p) => {
      const meta = p.match(/^api\/v1\/versions\/([^/]+)\.json$/);
      if (meta) return json([{ number: VERSION, created_at: '2020-01-01T00:00:00Z', licenses: ['MIT'], platform: 'ruby' }]);
      const gem = p.match(/^gems\/(.+?)-(\d[^-]*)\.gem$/);
      return gem ? art(side, 'rubygems', gem[1], gem[2]) : null;
    },
  },
];

/** Reads any response body as bytes, and survives a connection cut mid-body. */
function binary(res: IncomingMessage, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    callback(null, Buffer.concat(chunks));
  };
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', finish);
  res.on('aborted', finish);
  res.on('error', finish);
  res.on('close', finish);
}

/** A GET that reports a connection cut mid-body instead of throwing; supertest's client throws `aborted` then. */
async function rawDownload(target: FastifyInstance, p: string, token: string): Promise<{ status: number; header?: string; bytes: number }> {
  if (!target.server.listening) await target.listen({ port: 0, host: '127.0.0.1' });
  const { port } = target.server.address() as AddressInfo;
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => (bytes += chunk.length));
      res.on('error', () => undefined);
      res.on('close', () => resolve({ status: res.statusCode ?? 0, header: res.headers[HEADER] as string | undefined, bytes }));
    });
    req.on('error', () => resolve({ status: 0, bytes: 0 }));
  });
}

async function pathExists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false
  );
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Artifact cache (stub registries, all ecosystems)', () => {
  let app: FastifyInstance;
  let token = '';
  let auth: Auth;
  let stub: Server;
  let stubBase = '';
  let cacheDir = '';
  /** Every 503 while true: the registries are down. */
  let down = false;
  const artifactRequests = new Map<string, number>();
  const lockOwner = `ac-${randomUUID()}`;
  let previouslyEnabled: string[] = [];
  const createdRepos: string[] = [];
  const extraDirs: string[] = [];

  const requests = (side: Side, eco: string, name: string) => artifactRequests.get(`${side}:${eco}:${name.toLowerCase()}`) ?? 0;
  const ctx = (): Ctx => ({ app, auth });
  const download = (target: FastifyInstance, p: string) =>
    supertest(target.server).get(p).set('Authorization', `Bearer ${token}`).buffer(true).parse(binary);

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const [, side, ecosystem, ...rest] = url.pathname.split('/');
      const p = decodeURIComponent(rest.join('/'));
      if (down) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const fixture = FIXTURES.find((f) => f.ecosystem === ecosystem);
      const answer = fixture && (side === 'public' || side === 'internal') ? fixture.serve(side, `${stubBase}/${side}/${ecosystem}`, p) : null;
      if (!answer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const body = Buffer.isBuffer(answer.body) ? answer.body : Buffer.from(answer.body);
      if (answer.artifactOf) {
        const key = `${side}:${ecosystem}:${answer.artifactOf.toLowerCase()}`;
        artifactRequests.set(key, (artifactRequests.get(key) ?? 0) + 1);
        if (answer.artifactOf.includes('trunc')) {
          // Announce the whole file, send half, then drop the connection once the client is streaming it.
          res.writeHead(200, { 'Content-Type': answer.type, 'Content-Length': String(body.length) });
          res.write(body.subarray(0, body.length >> 1), () => setTimeout(() => res.socket?.destroy(), 100));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': answer.type, 'Content-Length': String(body.length) });
      res.end(body);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    cacheDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-a-'));
    app = await buildApp({
      artifactCache: { enabled: true, dir: cacheDir, maxSizeBytes: 1024 ** 3, podName: `qa-pod-a-${RUN}` },
    });
    await app.ready();
    for (let i = 0; i < 600; i += 1) {
      if ((await app.redis.set(SUITE_LOCK_KEY, lockOwner, 'NX', 'PX', 300000)) === 'OK') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const login = await supertest(app.server).post('/api/auth/login').send({ email: 'admin@depgate.local', password: 'admin' });
    token = login.body.token;
    expect(token, 'admin login').toBeTruthy();
    auth = (req) => req.set('Authorization', `Bearer ${token}`);
    // A killed run may have left settings behind.
    await auth(supertest(app.server).put('/api/artifact-cache/settings'))
      .send({ enabled: null, limits: { maxSizeGb: null, maxFiles: null, maxAgeDays: null, maxIdleDays: null, maxFileMb: null } })
      .expect(200);

    const policies = app.db.getRepository(Policy);
    const stale = await policies.find({ select: { id: true }, where: { name: Like('qa-ac-%') } });
    for (const row of stale) await auth(supertest(app.server).delete(`/api/admin/policies/${row.id}`));
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ id: In(previouslyEnabled) }, { isEnabled: false });

    const leftovers = await app.db.getRepository(PackageRepository).find({ where: { key: In(['qa-ac-public', 'qa-ac-internal']) } });
    for (const row of leftovers) await auth(supertest(app.server).delete(`/api/admin/repositories/${row.id}`));
    for (const fixture of FIXTURES) {
      for (const side of ['public', 'internal'] as const) {
        const res = await auth(supertest(app.server).post('/api/admin/repositories')).send({
          ecosystem: fixture.ecosystem,
          key: `qa-ac-${side}`,
          type: 'remote',
          upstreamUrl: `${stubBase}/${side}/${fixture.ecosystem}`,
          source: side,
          retryCount: 0,
          timeoutMs: 5000,
          description: 'qa-artifact-cache',
        });
        expect(res.status, `${fixture.ecosystem} qa-ac-${side}: ${JSON.stringify(res.body)}`).toBe(201);
        createdRepos.push(res.body.id);
      }
    }
  }, 180000);

  afterAll(async () => {
    down = false;
    if (!app) return;
    try {
      const policies = app.db.getRepository(Policy);
      const ours = await policies.find({ select: { id: true }, where: { name: Like(`qa-ac-%${RUN}%`) } });
      for (const row of ours) await auth(supertest(app.server).delete(`/api/admin/policies/${row.id}`));
      for (const id of createdRepos) await auth(supertest(app.server).delete(`/api/admin/repositories/${id}`));
      if (previouslyEnabled.length) await policies.update({ id: In(previouslyEnabled) }, { isEnabled: true });
    } finally {
      if ((await app.redis.get(SUITE_LOCK_KEY)) === lockOwner) await app.redis.del(SUITE_LOCK_KEY);
      await app.artifactCache.idle();
      await app.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
      for (const dir of [cacheDir, ...extraDirs]) await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 120000);

  it('the cache is on, with the limits from the configuration', async () => {
    expect(app.artifactCache.state).toBe('ok');
    const res = await auth(supertest(app.server).get('/api/artifact-cache/status')).expect(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.limits).toMatchObject({ maxSizeGb: 1, maxFiles: 200000, maxAgeDays: 30, maxIdleDays: 7, maxFileMb: 1024 });
    expect(res.body.environmentLimits).toEqual(res.body.limits);
    expect(res.body.savedLimits).toEqual({});
    expect(res.body.dir).toBe(cacheDir);
    expect(res.body.pods.map((p: { pod: string }) => p.pod)).toContain(`qa-pod-a-${RUN}`);
  });

  for (const fixture of FIXTURES) {
    const eco = fixture.ecosystem;
    describe(eco, () => {
      it('a miss then a hit, with the upstream asked once; both run the download side effects (F4)', async () => {
        const name = fixture.name('hit');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
        const captured = capturePublished();
        let first: supertest.Response;
        let second: supertest.Response;
        try {
          first = await download(app, filePath);
          expect(first.status, String(first.body).slice(0, 200)).toBe(200);
          expect(first.headers[HEADER]).toBe('MISS');
          await app.artifactCache.idle();
          second = await download(app, filePath);
        } finally {
          captured.stop();
        }
        expect(second.status).toBe(200);
        expect(second.headers[HEADER]).toBe('HIT');
        expect(Buffer.compare(second.body as Buffer, first.body as Buffer)).toBe(0);
        expect((second.body as Buffer).subarray(0, 7).toString()).toBe('public:');
        expect(second.headers['content-length']).toBe(String((first.body as Buffer).length));
        expect(second.headers['content-type']).toBe(first.headers['content-type']);
        expect(requests('public', eco, name)).toBe(1);

        const allows = captured.events.filter((e) => e.type === 'ALLOW' && e.target?.name?.toLowerCase() === name.toLowerCase());
        expect(allows).toHaveLength(2);
        for (const event of allows) {
          expect((event.details?.source as { repository?: string } | undefined)?.repository).toBe(`${eco}/qa-ac-public`);
        }
      });

      it('a policy added after caching blocks the hit (F1)', async () => {
        const name = fixture.name('block');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
        expect((await download(app, filePath)).headers[HEADER]).toBe('MISS');
        await app.artifactCache.idle();
        expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');

        const created = await auth(supertest(app.server).post('/api/admin/policies')).send({
          name: `qa-ac-block-${eco}-${RUN}`,
          decision: 'BLOCK',
          priority: 0,
          conditions: { ecosystem: [eco], packageBlockList: [name] },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        try {
          const blocked = await download(app, filePath);
          expect(blocked.status).toBe(403);
          expect(blocked.headers[HEADER]).toBeUndefined();
        } finally {
          await auth(supertest(app.server).delete(`/api/admin/policies/${created.body.id}`)).expect(204);
        }
        expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');
        expect(requests('public', eco, name)).toBe(1);
      });

      it('a file from an internal remote is never cached', async () => {
        const name = fixture.name('corp');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-internal', name);
        for (let i = 0; i < 2; i++) {
          const res = await download(app, filePath);
          expect(res.status).toBe(200);
          expect(res.headers[HEADER]).toBe('BYPASS');
          expect((res.body as Buffer).subarray(0, 9).toString()).toBe('internal:');
          await app.artifactCache.idle();
        }
        expect(requests('internal', eco, name)).toBe(2);
        expect(await pathExists(packageDir(app.artifactCache.root, eco, name))).toBe(false);
      });

      it('a truncated download is not stored', async () => {
        const name = fixture.name('trunc');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
        const first = await rawDownload(app, filePath, token);
        expect(first.status).toBe(200);
        expect(first.header).toBe('MISS');
        expect(first.bytes).toBeLessThan(fileBytes('public', eco, name, VERSION).length);
        await app.artifactCache.idle();
        expect(await pathExists(packageDir(app.artifactCache.root, eco, name))).toBe(false);
        const second = await rawDownload(app, filePath, token);
        expect(second.header).toBe('MISS');
        await app.artifactCache.idle();
        expect(requests('public', eco, name)).toBe(2);
      });

      it('purge removes the package; the next download goes upstream again (P1, P3)', async () => {
        const name = fixture.name('purge');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
        const first = await download(app, filePath);
        await app.artifactCache.idle();
        const why = () =>
          `first: ${first.status} ${first.headers[HEADER]} ${(first.body as Buffer).length} bytes; lastError: ${app.artifactCache.lastError}; upstream: ${requests('public', eco, name)}`;
        expect((await download(app, filePath)).headers[HEADER], why()).toBe('HIT');

        const purged = await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ ecosystem: eco, package: name });
        expect(purged.status, JSON.stringify(purged.body)).toBe(202);
        expect(purged.body.files).toBe(1);

        const again = await download(app, filePath);
        expect(again.headers[HEADER]).toBe('MISS');
        expect(requests('public', eco, name)).toBe(2);
        await app.artifactCache.idle();

        // By ecosystem too: several ecosystems purge a package of this name, and the row is written after the response.
        const rows = await poll(
          () => auditRows(app.db, { type: 'ARTIFACT_CACHE_PURGED', targetName: name, targetEcosystem: eco }),
          'purge audit row'
        );
        expect(rows[0]).toMatchObject({ targetKind: 'artifact_cache', targetEcosystem: eco });
      });

      it('with the registry down, a cached file is still served', async () => {
        const name = fixture.name('down');
        const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
        const first = await download(app, filePath);
        await app.artifactCache.idle();
        down = true;
        try {
          const res = await download(app, filePath);
          const why = `first: ${first.status} ${first.headers[HEADER]} ${(first.body as Buffer).length} bytes; lastError: ${app.artifactCache.lastError}`;
          expect(res.status, why).toBe(200);
          expect(res.headers[HEADER]).toBe('HIT');
        } finally {
          down = false;
        }
      });
    });
  }

  describe('files that are never cached', () => {
    it('Maven -SNAPSHOT versions', async () => {
      const filePath = `/maven/qa-ac-public/test/qa${RUN}/snap/1.0-SNAPSHOT/snap-1.0-SNAPSHOT.jar`;
      for (let i = 0; i < 2; i++) {
        const res = await download(app, filePath);
        expect(res.status).toBe(200);
        expect(res.headers[HEADER]).toBe('BYPASS');
        await app.artifactCache.idle();
      }
    });

    it('npm packuments and Go version lists are metadata, not cache entries', async () => {
      const npm = await auth(supertest(app.server).get(`/npm/qa-ac-public/qa-ac-meta-${RUN}`)).expect(200);
      expect(npm.headers[HEADER]).toBeUndefined();
      const list = await auth(supertest(app.server).get(`/go/qa-ac-public/example.test/qa${RUN}/meta/@v/list`)).expect(200);
      expect(list.headers[HEADER]).toBeUndefined();
    });

    it('Go .info and .mod are cached next to the zip', async () => {
      for (const ext of ['info', 'mod']) {
        const filePath = `/go/qa-ac-public/example.test/qa${RUN}/sidecar/@v/v${VERSION}.${ext}`;
        expect((await download(app, filePath)).headers[HEADER]).toBe('MISS');
        await app.artifactCache.idle();
        expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');
      }
    });
  });

  describe('status, purge API and metrics', () => {
    it('purge validates its body', async () => {
      await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({}).expect(400);
      await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ ecosystem: 'apt', package: 'x' }).expect(400);
      await supertest(app.server).post('/api/artifact-cache/purge').send({ all: true }).expect(401);
    });

    it('purges one version only', async () => {
      const fixture = FIXTURES.find((f) => f.ecosystem === 'npm')!;
      const name = fixture.name('version');
      const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
      await download(app, filePath);
      await app.artifactCache.idle();
      const other = await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ ecosystem: 'npm', package: name, version: '9.9.9' });
      expect(other.body.files).toBe(0);
      expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');
      const same = await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ ecosystem: 'npm', package: name, version: VERSION });
      expect(same.body.files).toBe(1);
      expect((await download(app, filePath)).headers[HEADER]).toBe('MISS');
      await app.artifactCache.idle();
    });

    it('exports the Prometheus metrics (S5)', async () => {
      const res = await supertest(app.server).get('/metrics');
      if (res.status === 404) return; // MANAGEMENT_PORT set: metrics are on the private port only.
      expect(res.text).toContain('depgate_artifact_cache_requests_total{ecosystem="npm",result="hit"}');
      expect(res.text).toContain('depgate_artifact_cache_size_bytes');
      expect(res.text).toContain('depgate_artifact_cache_files');
      expect(res.text).toContain('depgate_artifact_cache_evicted_total{reason="purge"}');
    });
  });

  describe('two pods', () => {
    let podB: FastifyInstance;

    beforeAll(async () => {
      const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-b-'));
      extraDirs.push(dirB);
      podB = await buildApp({ artifactCache: { enabled: true, dir: dirB, maxSizeBytes: 1024 ** 3, podName: `qa-pod-b-${RUN}` } });
      await podB.ready();
    }, 60000);

    afterAll(async () => {
      await podB?.artifactCache.idle();
      await podB?.close();
    }, 60000);

    it('each pod fetches a new file once; status lists both pods', async () => {
      const fixture = FIXTURES.find((f) => f.ecosystem === 'cargo')!;
      const name = fixture.name('twopods');
      const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
      for (const pod of [app, podB]) {
        expect((await download(pod, filePath)).headers[HEADER]).toBe('MISS');
        await pod.artifactCache.idle();
        expect((await download(pod, filePath)).headers[HEADER]).toBe('HIT');
      }
      expect(requests('public', 'cargo', name)).toBe(2);
      const status = await poll(async () => {
        const res = await auth(supertest(app.server).get('/api/artifact-cache/status')).expect(200);
        const pods = (res.body.pods as Array<{ pod: string }>).map((p) => p.pod);
        return pods.includes(`qa-pod-b-${RUN}`) ? res.body : null;
      }, 'pod B in the status table');
      expect(status.pods.find((p: { pod: string }) => p.pod === `qa-pod-a-${RUN}`)).toMatchObject({ state: 'ok' });
    });

    it('a purge sent to one pod reaches the other within seconds (P2)', async () => {
      const fixture = FIXTURES.find((f) => f.ecosystem === 'cargo')!;
      const name = fixture.name('twopods');
      const dirOnB = packageDir(podB.artifactCache.root, 'cargo', name);
      expect(await pathExists(dirOnB)).toBe(true);
      const res = await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ ecosystem: 'cargo', package: name });
      expect(res.status).toBe(202);
      expect(res.body.pods).toBeGreaterThanOrEqual(2);
      await poll(async () => !(await pathExists(dirOnB)) || null, 'purge applied on pod B', 5_000);
      const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
      expect((await download(podB, filePath)).headers[HEADER]).toBe('MISS');
      await podB.artifactCache.idle();
    });

    it('switched off in Settings on one pod, both pods stop caching; null follows the environment again', async () => {
      const fixture = FIXTURES.find((f) => f.ecosystem === 'npm')!;
      const name = fixture.name('switch');
      const filePath = await fixture.artifact(ctx(), 'qa-ac-public', name);
      await download(app, filePath);
      await app.artifactCache.idle();
      expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');
      try {
        const off = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ enabled: false });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body).toMatchObject({ enabled: false, setting: false, environmentEnabled: true, available: true });
        expect((await download(app, filePath)).headers[HEADER]).toBe('BYPASS');
        await poll(async () => (podB.artifactCache.enabled === false && podB.artifactCache.state === 'off') || null, 'pod B switched off', 5_000);
        expect((await download(podB, filePath)).headers[HEADER]).toBe('BYPASS');
        // The row is written after the response; the beforeAll reset wrote an earlier one of the same type.
        const rows = await poll(
          () => auditRows(app.db, { type: 'ARTIFACT_CACHE_SETTINGS_UPDATED' }).then((r) => r.filter((row) => row.summary === 'Artifact cache switched off')),
          'switch audit row'
        );
        expect(rows[0].summary).toBe('Artifact cache switched off');

        const status = await auth(supertest(app.server).get('/api/artifact-cache/status')).expect(200);
        expect(status.body).toMatchObject({ enabled: false, setting: false });
      } finally {
        const reset = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ enabled: null });
        expect(reset.status).toBe(200);
        expect(reset.body).toMatchObject({ enabled: true, setting: null });
      }
      await poll(async () => (podB.artifactCache.state === 'ok') || null, 'pod B back on', 5_000);
      // The file stored before the switch is served again.
      expect((await download(app, filePath)).headers[HEADER]).toBe('HIT');
    });

    it('the settings need a valid body', async () => {
      await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({}).expect(400);
      await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ limits: { maxSizeGb: 0 } }).expect(400);
      await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ limits: { maxAgeDays: -1 } }).expect(400);
      // Unknown fields are dropped, as on every route: the directory cannot be changed here.
      const dir = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ limits: { dir: '/tmp' } });
      expect(dir.body.dir).toBe(cacheDir);
      await supertest(app.server).put('/api/artifact-cache/settings').send({ enabled: true }).expect(401);
    });

    it('limits changed in Settings apply on both pods; null goes back to the environment', async () => {
      try {
        const res = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({
          limits: { maxSizeGb: 2.5, maxFiles: 5000, maxAgeDays: 10, maxIdleDays: 0, maxFileMb: 64 },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const want = { maxSizeGb: 2.5, maxFiles: 5000, maxAgeDays: 10, maxIdleDays: 0, maxFileMb: 64 };
        expect(res.body.limits).toMatchObject(want);
        expect(res.body.savedLimits).toEqual(want);
        expect(res.body.environmentLimits).toMatchObject({ maxSizeGb: 1, maxFiles: 200000 });
        expect(app.artifactCache.currentLimits).toMatchObject({ maxFiles: 5000, maxFileBytes: 64 * 1024 ** 2, maxIdleMs: 0 });
        await poll(async () => (podB.artifactCache.currentLimits.maxFiles === 5000) || null, 'pod B has the new limits', 5_000);
        const rows = await poll(
          () => auditRows(app.db, { type: 'ARTIFACT_CACHE_SETTINGS_UPDATED' }).then((r) => r.filter((row) => row.summary?.includes('files per pod 5000'))),
          'limits audit row'
        );
        expect(rows[0].summary).toContain('size per pod 2.5 GB');

        const one = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({ limits: { maxFiles: null } });
        expect(one.body.savedLimits).toEqual({ maxSizeGb: 2.5, maxAgeDays: 10, maxIdleDays: 0, maxFileMb: 64 });
        expect(one.body.limits.maxFiles).toBe(200000);
      } finally {
        const reset = await auth(supertest(app.server).put('/api/artifact-cache/settings')).send({
          limits: { maxSizeGb: null, maxFiles: null, maxAgeDays: null, maxIdleDays: null, maxFileMb: null },
        });
        expect(reset.body.savedLimits).toEqual({});
      }
      await poll(async () => (podB.artifactCache.currentLimits.maxFiles === 200000) || null, 'pod B back to the environment', 5_000);
    });

    it('clearing everything reaches both pods', async () => {
      const res = await auth(supertest(app.server).post('/api/artifact-cache/purge')).send({ all: true });
      expect(res.status).toBe(202);
      await poll(async () => (podB.artifactCache.stats().files === 0 && app.artifactCache.stats().files === 0) || null, 'both pods empty', 5_000);
      const rows = await poll(() => auditRows(app.db, { type: 'ARTIFACT_CACHE_PURGED', targetName: '*' }), 'clear-all audit row');
      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('a pod without a size per pod', () => {
    let podD: FastifyInstance;

    beforeAll(async () => {
      podD = await buildApp({ artifactCache: { enabled: false, maxSizeBytes: 0, podName: `qa-pod-d-${RUN}` } });
      await podD.ready();
    }, 60000);

    afterAll(async () => {
      await podD?.close();
    }, 60000);

    it('cannot be switched on from Settings, and says what is missing', async () => {
      const status = await auth(supertest(podD.server).get('/api/artifact-cache/status')).expect(200);
      expect(status.body).toMatchObject({ enabled: false, available: false });
      const res = await auth(supertest(podD.server).put('/api/artifact-cache/settings')).send({ enabled: true });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/size per pod/);
      expect((await auth(supertest(podD.server).get('/api/artifact-cache/status')).expect(200)).body.setting).toBeNull();
    });
  });

  describe('an unusable cache directory', () => {
    let podC: FastifyInstance;

    beforeAll(async () => {
      podC = await buildApp({
        artifactCache: { enabled: true, dir: path.join(os.tmpdir(), `depgate-missing-${RUN}`), maxSizeBytes: 1024 ** 3, podName: `qa-pod-c-${RUN}` },
      });
      await podC.ready();
    }, 60000);

    afterAll(async () => {
      await podC?.close();
    }, 60000);

    it('starts with the cache off and an error in the status', () => {
      expect(podC.artifactCache.state).toBe('error');
      expect(podC.artifactCache.lastError).toMatch(/does not exist/);
    });

    for (const fixture of FIXTURES) {
      it(`${fixture.ecosystem}: still serves the download`, async () => {
        const name = fixture.name('nodisk');
        const filePath = await fixture.artifact({ app: podC, auth }, 'qa-ac-public', name);
        for (let i = 0; i < 2; i++) {
          const res = await download(podC, filePath);
          expect(res.status).toBe(200);
          expect(res.headers[HEADER]).toBe('BYPASS');
        }
        expect(requests('public', fixture.ecosystem, name)).toBe(2);
      });
    }
  });
});
