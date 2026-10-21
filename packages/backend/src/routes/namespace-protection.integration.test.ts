/**
 * Internal namespace rule (dependency confusion), all eight ecosystems, against stub registries.
 * Requires PostgreSQL + Redis (RUN_INTEGRATION=1); no public registry is contacted.
 *
 * One local HTTP server plays a public registry (`/public/<eco>`) and an internal one
 * (`/internal/<eco>`). Each ecosystem gets remotes `qa-ns-public` (public) and `qa-ns-internal`
 * (internal), and a virtual `qa-ns-mixed` that asks the public remote first: the worst case.
 * The reserved name exists on both, with a higher version publicly (the attack).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';
import { auditRows, ledgerRows } from '../test-support/event-rows.js';
import { flushSummaries } from '../services/events/summary.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';
/** Letters only: RubyGems and npm tarball names end the package name at the first `-<digit>`. */
const RUN = randomUUID().replace(/[^a-f]/g, '').slice(0, 6).padEnd(6, 'q');
const PUBLIC_VERSION = '9.9.9';
const INTERNAL_VERSION = '1.0.0';

type Side = 'public' | 'internal';
type Seen = { side: Side; ecosystem: string; path: string; body: string };
type Auth = (req: supertest.Test) => supertest.Test;

/** What each side of the stub holds: name → versions. */
type Catalog = Record<Side, Map<string, string[]>>;

type Fixture = {
  ecosystem: string;
  pattern: string;
  /** In the reserved namespace, on both registries, higher version publicly. */
  reserved: string;
  /** In the reserved namespace, only on the public registry. */
  ghost: string;
  /** Not reserved, only on the public registry. */
  other: string;
  otherVersion: string;
  /** Text a request for the name carries, to tell whether the public stub was asked about it. */
  fragment: (name: string) => string;
  /** Metadata request through repository `repo`. */
  metadata: (repo: string, name: string) => string;
  /** Whether a metadata body lists the version. */
  lists: (body: string, version: string) => boolean;
  /** Artifact request path through `repo`; may read metadata first for signed URLs. */
  artifact: (ctx: Ctx, repo: string, name: string, version: string) => Promise<string>;
  /** Stub handler: the response for a path on one side, or null for 404. */
  serve: (side: Side, base: string, path: string, catalog: Catalog) => { type: string; body: string } | null;
};

type Ctx = { app: FastifyInstance; auth: Auth };

const bytes = (side: Side, name: string, version: string) => `${side}:${name}:${version}`;
const json = (value: unknown) => ({ type: 'application/json', body: JSON.stringify(value) });
const text = (value: string) => ({ type: 'text/plain', body: value });
const versionsOf = (catalog: Catalog, side: Side, name: string) => catalog[side].get(name.toLowerCase()) ?? null;

const FIXTURES: Fixture[] = [
  {
    ecosystem: 'npm',
    pattern: `@qa${RUN}`,
    reserved: `@qa${RUN}/billing`,
    ghost: `@qa${RUN}/ghost`,
    other: `qa-other-${RUN}`,
    otherVersion: '2.0.0',
    fragment: (name) => name.split('/').pop()!,
    metadata: (repo, name) => `/npm/${repo}/${name}`,
    lists: (body, version) => Object.keys((JSON.parse(body) as { versions?: object }).versions ?? {}).includes(version),
    artifact: async (_ctx, repo, name, version) => `/npm/${repo}/${name}/-/${name.split('/').pop()}-${version}.tgz`,
    serve: (side, base, path, catalog) => {
      const tar = path.match(/^(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/);
      if (tar) {
        const name = decodeURIComponent(tar[1]);
        return versionsOf(catalog, side, name)?.includes(tar[2]) ? text(bytes(side, name, tar[2])) : null;
      }
      const name = decodeURIComponent(path);
      const versions = versionsOf(catalog, side, name);
      if (!versions) return null;
      const short = name.split('/').pop();
      return json({
        name,
        'dist-tags': { latest: versions[versions.length - 1] },
        time: Object.fromEntries(versions.map((v) => [v, '2020-01-01T00:00:00.000Z'])),
        versions: Object.fromEntries(
          versions.map((v) => [v, { name, version: v, license: 'MIT', dist: { tarball: `${base}/${name}/-/${short}-${v}.tgz` } }])
        ),
      });
    },
  },
  {
    ecosystem: 'pypi',
    pattern: `qa-${RUN}-*`,
    reserved: `qa-${RUN}-auth`,
    ghost: `qa-${RUN}-ghost`,
    other: `qa-other-${RUN}`,
    otherVersion: '2.0.0',
    fragment: (name) => name.replace(/-/g, '_'),
    metadata: (repo, name) => `/pypi/${repo}/simple/${name}/`,
    lists: (body, version) => body.includes(`-${version}.tar.gz`),
    artifact: async ({ app, auth }, repo, name, version) => {
      const page = await auth(supertest(app.server).get(`/pypi/${repo}/simple/${name}/`)).expect(200);
      const href = [...page.text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((h) => h.includes(`-${version}.tar.gz`));
      expect(href, `${name} ${version} is listed`).toBeDefined();
      const url = new URL(href!.replace(/&amp;/g, '&'));
      return `${url.pathname}${url.search}`;
    },
    serve: (side, base, path, catalog) => {
      const simple = path.match(/^simple\/([^/]+)\/?$/);
      if (simple) {
        const versions = versionsOf(catalog, side, simple[1]);
        if (!versions) return null;
        const links = versions.map((v) => {
          const file = `${simple[1].replace(/-/g, '_')}-${v}.tar.gz`;
          return `<a href="${base}/packages/${file}">${file}</a>`;
        });
        return { type: 'text/html', body: `<html><body>${links.join('\n')}</body></html>` };
      }
      const jsonDoc = path.match(/^pypi\/([^/]+)\/json$/);
      if (jsonDoc) {
        const versions = versionsOf(catalog, side, jsonDoc[1]);
        if (!versions) return null;
        return json({ info: { license: 'MIT' }, releases: Object.fromEntries(versions.map((v) => [v, [{ upload_time_iso_8601: '2020-01-01T00:00:00Z' }]])) });
      }
      const file = path.match(/^packages\/(.+)-(\d[^-]*)\.tar\.gz$/);
      if (file) {
        const name = file[1].replace(/_/g, '-');
        return versionsOf(catalog, side, name)?.includes(file[2]) ? text(bytes(side, name, file[2])) : null;
      }
      return null;
    },
  },
  {
    ecosystem: 'go',
    pattern: `example.test/qa${RUN}`,
    reserved: `example.test/qa${RUN}/svc`,
    ghost: `example.test/qa${RUN}/ghost`,
    other: `example.test/other${RUN}/svc`,
    otherVersion: 'v2.0.0',
    fragment: (name) => name,
    metadata: (repo, name) => `/go/${repo}/${name}/@v/list`,
    lists: (body, version) => body.split('\n').map((line) => line.trim()).includes(goVersion(version)),
    artifact: async (_ctx, repo, name, version) => `/go/${repo}/${name}/@v/${goVersion(version)}.zip`,
    serve: (side, _base, path, catalog) => {
      const m = path.match(/^(.+)\/@v\/(list|([^/]+)\.(info|mod|zip))$/);
      if (!m) return null;
      const versions = versionsOf(catalog, side, m[1])?.map(goVersion);
      if (!versions) return null;
      if (m[2] === 'list') return text(`${versions.join('\n')}\n`);
      if (!versions.includes(m[3])) return null;
      if (m[4] === 'info') return json({ Version: m[3], Time: '2020-01-01T00:00:00Z' });
      if (m[4] === 'mod') return text(`module ${m[1]}\n`);
      return text(bytes(side, m[1], m[3]));
    },
  },
  {
    ecosystem: 'maven',
    pattern: `test.qa${RUN}`,
    reserved: `test.qa${RUN}:core`,
    ghost: `test.qa${RUN}:ghost`,
    other: `test.other${RUN}:core`,
    otherVersion: '2.0.0',
    fragment: (name) => name.replace(':', '/').replace(/\./g, '/'),
    metadata: (repo, name) => `/maven/${repo}/${mavenPath(name)}/maven-metadata.xml`,
    lists: (body, version) => body.includes(`<version>${version}</version>`),
    artifact: async (_ctx, repo, name, version) => `/maven/${repo}/${mavenPath(name)}/${version}/${name.split(':')[1]}-${version}.jar`,
    serve: (side, _base, path, catalog) => {
      const meta = path.match(/^(.+)\/([^/]+)\/maven-metadata\.xml$/);
      if (meta) {
        const name = `${meta[1].replace(/\//g, '.')}:${meta[2]}`;
        const versions = versionsOf(catalog, side, name);
        if (!versions) return null;
        return {
          type: 'application/xml',
          body: `<metadata><groupId>${meta[1].replace(/\//g, '.')}</groupId><artifactId>${meta[2]}</artifactId><versioning><latest>${versions[versions.length - 1]}</latest><versions>${versions.map((v) => `<version>${v}</version>`).join('')}</versions><lastUpdated>20200101000000</lastUpdated></versioning></metadata>`,
        };
      }
      const art = path.match(/^(.+)\/([^/]+)\/([^/]+)\/[^/]+\.(jar|pom)$/);
      if (art) {
        const name = `${art[1].replace(/\//g, '.')}:${art[2]}`;
        if (!versionsOf(catalog, side, name)?.includes(art[3])) return null;
        return art[4] === 'pom' ? { type: 'application/xml', body: '<project/>' } : text(bytes(side, name, art[3]));
      }
      return null;
    },
  },
  {
    ecosystem: 'nuget',
    pattern: `Qa${RUN}Acme.*`,
    reserved: `qa${RUN}acme.billing`,
    ghost: `qa${RUN}acme.ghost`,
    other: `qa${RUN}other.lib`,
    otherVersion: '2.0.0',
    fragment: (name) => name,
    metadata: (repo, name) => `/nuget/${repo}/v3-flatcontainer/${name}/index.json`,
    lists: (body, version) => ((JSON.parse(body) as { versions?: string[] }).versions ?? []).includes(version),
    artifact: async (_ctx, repo, name, version) => `/nuget/${repo}/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`,
    serve: (side, _base, path, catalog) => {
      const index = path.match(/^v3-flatcontainer\/([^/]+)\/index\.json$/);
      if (index) {
        const versions = versionsOf(catalog, side, index[1]);
        return versions ? json({ versions }) : null;
      }
      const pkg = path.match(/^v3-flatcontainer\/([^/]+)\/([^/]+)\/[^/]+\.nupkg$/);
      if (pkg) return versionsOf(catalog, side, pkg[1])?.includes(pkg[2]) ? text(bytes(side, pkg[1], pkg[2])) : null;
      return null;
    },
  },
  {
    ecosystem: 'cargo',
    pattern: `qa-${RUN}-*`,
    reserved: `qa-${RUN}-core`,
    ghost: `qa-${RUN}-ghost`,
    other: `qa-other-${RUN}`,
    otherVersion: '2.0.0',
    fragment: (name) => name,
    metadata: (repo, name) => `/cargo/${repo}/api/v1/crates/${name}`,
    lists: (body, version) => ((JSON.parse(body) as { versions?: Array<{ num: string }> }).versions ?? []).some((v) => v.num === version),
    artifact: async (_ctx, repo, name, version) => `/cargo/${repo}/api/v1/crates/${name}/${version}/download`,
    serve: (side, _base, path, catalog) => {
      const meta = path.match(/^api\/v1\/crates\/([^/]+)$/);
      if (meta) {
        const versions = versionsOf(catalog, side, meta[1]);
        if (!versions) return null;
        return json({
          crate: { name: meta[1], max_version: versions[versions.length - 1] },
          versions: versions.map((v) => ({ num: v, created_at: '2020-01-01T00:00:00Z', license: 'MIT', yanked: false })),
        });
      }
      const dl = path.match(/^api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/);
      if (dl) return versionsOf(catalog, side, dl[1])?.includes(dl[2]) ? text(bytes(side, dl[1], dl[2])) : null;
      const sparse = path.match(/^[a-z0-9_-]{2}\/[a-z0-9_-]{2}\/([a-z0-9_-]+)$/);
      if (sparse) {
        const versions = versionsOf(catalog, side, sparse[1]);
        return versions ? text(versions.map((v) => JSON.stringify({ name: sparse[1], vers: v, deps: [], features: {}, yanked: false })).join('\n')) : null;
      }
      return null;
    },
  },
  {
    ecosystem: 'composer',
    pattern: `qa${RUN}acme/*`,
    reserved: `qa${RUN}acme/billing`,
    ghost: `qa${RUN}acme/ghost`,
    other: `qa${RUN}other/lib`,
    otherVersion: '2.0.0',
    fragment: (name) => name,
    metadata: (repo, name) => `/composer/${repo}/p2/${name}.json`,
    lists: (body, version) => {
      const doc = JSON.parse(body) as { packages?: Record<string, Array<{ version?: string }>> };
      return Object.values(doc.packages ?? {}).some((rows) => rows.some((row) => row.version === version));
    },
    artifact: async ({ app, auth }, repo, name, version) => {
      const meta = await auth(supertest(app.server).get(`/composer/${repo}/p2/${name}.json`)).expect(200);
      const rows = (meta.body?.packages?.[name] ?? []) as Array<{ version?: string; dist?: { url?: string } }>;
      const row = rows.find((r) => r.version === version);
      expect(row?.dist?.url, `${name} ${version} is listed`).toBeDefined();
      const url = new URL(row!.dist!.url!);
      return `${url.pathname}${url.search}`;
    },
    serve: (side, base, path, catalog) => {
      const meta = path.match(/^p2\/([^/]+\/[^/]+)\.json$/);
      if (meta) {
        const versions = versionsOf(catalog, side, meta[1]);
        if (!versions) return null;
        return json({
          packages: {
            [meta[1]]: versions.map((v) => ({
              name: meta[1],
              version: v,
              version_normalized: `${v}.0`,
              time: '2020-01-01T00:00:00+00:00',
              license: ['MIT'],
              dist: { type: 'zip', url: `${base}/dist/${meta[1]}/${v}.zip`, reference: 'abc' },
            })),
          },
        });
      }
      const dist = path.match(/^dist\/([^/]+\/[^/]+)\/([^/]+)\.zip$/);
      if (dist) return versionsOf(catalog, side, dist[1])?.includes(dist[2]) ? text(bytes(side, dist[1], dist[2])) : null;
      return null;
    },
  },
  {
    ecosystem: 'rubygems',
    pattern: `qa-${RUN}-*`,
    reserved: `qa-${RUN}-billing`,
    ghost: `qa-${RUN}-ghost`,
    other: `qa-other-${RUN}`,
    otherVersion: '2.0.0',
    fragment: (name) => name,
    metadata: (repo, name) => `/rubygems/${repo}/api/v1/versions/${name}.json`,
    lists: (body, version) => (JSON.parse(body) as Array<{ number?: string }>).some((row) => row.number === version),
    artifact: async (_ctx, repo, name, version) => `/rubygems/${repo}/gems/${name}-${version}.gem`,
    serve: (side, _base, path, catalog) => {
      const meta = path.match(/^api\/v1\/versions\/([^/]+)\.json$/);
      if (meta) {
        const versions = versionsOf(catalog, side, meta[1]);
        return versions ? json(versions.map((v) => ({ number: v, created_at: '2020-01-01T00:00:00Z', licenses: ['MIT'], platform: 'ruby' }))) : null;
      }
      const info = path.match(/^info\/([^/]+)$/);
      if (info) {
        const versions = versionsOf(catalog, side, info[1]);
        return versions ? text(`---\n${versions.map((v) => `${v} |checksum:00`).join('\n')}\n`) : null;
      }
      const gem = path.match(/^gems\/(.+?)-(\d[^-]*)\.gem$/);
      if (gem) return versionsOf(catalog, side, gem[1])?.includes(gem[2]) ? text(bytes(side, gem[1], gem[2])) : null;
      return null;
    },
  },
];

function goVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

function mavenPath(name: string): string {
  const [group, artifact] = name.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}`;
}

async function poll<T>(read: () => Promise<T | null | undefined>, what: string, tries = 60): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Internal namespace rule (stub registries, all ecosystems)', () => {
  let app: FastifyInstance;
  let token = '';
  let auth: Auth;
  let admin: Auth;
  let stub: Server;
  let stubBase = '';
  const seen: Seen[] = [];
  const outbound: Array<{ url: string; body: string }> = [];
  const realFetch = globalThis.fetch;
  const lockOwner = `ns-${randomUUID()}`;
  let previouslyEnabled: string[] = [];
  const createdRepos: string[] = [];
  const createdPolicies: string[] = [];
  const previousAllows = process.env.AUDIT_LOG_ALLOWS;

  const catalogs = new Map<string, Catalog>();
  for (const fixture of FIXTURES) {
    const lower = (name: string) => name.toLowerCase();
    catalogs.set(fixture.ecosystem, {
      public: new Map([
        [lower(fixture.reserved), [INTERNAL_VERSION, PUBLIC_VERSION]],
        [lower(fixture.ghost), [INTERNAL_VERSION]],
        [lower(fixture.other), [fixture.otherVersion]],
      ]),
      internal: new Map([[lower(fixture.reserved), [INTERNAL_VERSION]]]),
    });
  }

  beforeAll(async () => {
    process.env.AUDIT_LOG_ALLOWS = 'true';
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const [, side, ecosystem, ...rest] = url.pathname.split('/');
      const path = rest.join('/');
      seen.push({ side: side as Side, ecosystem, path: decodeURIComponent(path), body: '' });
      const fixture = FIXTURES.find((f) => f.ecosystem === ecosystem);
      const catalog = catalogs.get(ecosystem);
      const answer =
        fixture && catalog && (side === 'public' || side === 'internal')
          ? fixture.serve(side, `${stubBase}/${side}/${ecosystem}`, path, catalog)
          : null;
      if (!answer) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': answer.type });
      res.end(answer.body);
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      outbound.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      return realFetch(input, init);
    }) as typeof fetch;

    app = await buildApp();
    await app.ready();
    for (let i = 0; i < 600; i += 1) {
      if ((await app.redis.set(SUITE_LOCK_KEY, lockOwner, 'NX', 'PX', 300000)) === 'OK') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const login = await supertest(app.server).post('/api/auth/login').send({ email: 'admin@depgate.local', password: 'admin' });
    token = login.body.token;
    expect(token, 'admin login').toBeTruthy();
    auth = (req) => req.set('Authorization', `Bearer ${token}`);
    admin = auth;

    const policies = app.db.getRepository(Policy);
    previouslyEnabled = (await policies.find({ select: { id: true }, where: { isEnabled: true } })).map((p) => p.id);
    if (previouslyEnabled.length) await policies.update({ id: In(previouslyEnabled) }, { isEnabled: false });

    for (const fixture of FIXTURES) {
      for (const side of ['public', 'internal'] as const) {
        const res = await admin(supertest(app.server).post('/api/admin/repositories')).send({
          ecosystem: fixture.ecosystem,
          key: `qa-ns-${side}`,
          type: 'remote',
          upstreamUrl: `${stubBase}/${side}/${fixture.ecosystem}`,
          source: side,
          retryCount: 0,
          timeoutMs: 5000,
          description: 'qa-namespace',
        });
        expect(res.status, `${fixture.ecosystem} qa-ns-${side}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(res.body.source).toBe(side);
        createdRepos.push(res.body.id);
      }
      const mixed = await admin(supertest(app.server).post('/api/admin/repositories')).send({
        ecosystem: fixture.ecosystem,
        key: 'qa-ns-mixed',
        type: 'virtual',
        memberKeys: ['qa-ns-public', 'qa-ns-internal'],
        description: 'qa-namespace',
      });
      expect(mixed.status, JSON.stringify(mixed.body)).toBe(201);
      createdRepos.unshift(mixed.body.id);
    }
  }, 180000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    process.env.AUDIT_LOG_ALLOWS = previousAllows;
    if (!app) return;
    try {
      for (const id of createdPolicies) await admin(supertest(app.server).delete(`/api/admin/policies/${id}`));
      for (const id of createdRepos) await admin(supertest(app.server).delete(`/api/admin/repositories/${id}`));
      if (previouslyEnabled.length) await app.db.getRepository(Policy).update({ id: In(previouslyEnabled) }, { isEnabled: true });
    } finally {
      if ((await app.redis.get(SUITE_LOCK_KEY)) === lockOwner) await app.redis.del(SUITE_LOCK_KEY);
      await app.close();
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }, 120000);

  it('rejects an internal source on the default remote and on a virtual repository', async () => {
    const repos = app.db.getRepository(PackageRepository);
    const def = await repos.findOneOrFail({ where: { ecosystem: 'npm', key: 'default' } });
    const res = await admin(supertest(app.server).put(`/api/admin/repositories/${def.id}`)).send({ source: 'internal' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/always public/);
    const mixed = await repos.findOneOrFail({ where: { ecosystem: 'npm', key: 'qa-ns-mixed' } });
    const virtual = await admin(supertest(app.server).put(`/api/admin/repositories/${mixed.id}`)).send({ source: 'internal' });
    expect(virtual.status).toBe(400);
  });

  it('requires a source when creating a remote', async () => {
    const res = await admin(supertest(app.server).post('/api/admin/repositories')).send({
      ecosystem: 'npm',
      key: 'qa-ns-nosource',
      type: 'remote',
      upstreamUrl: `${stubBase}/public/npm`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires a source/);
    expect(await app.db.getRepository(PackageRepository).findOne({ where: { ecosystem: 'npm', key: 'qa-ns-nosource' } })).toBeNull();
  });

  it('audits a source change', async () => {
    const repos = app.db.getRepository(PackageRepository);
    const remote = await repos.findOneOrFail({ where: { ecosystem: 'npm', key: 'qa-ns-public' } });
    await admin(supertest(app.server).put(`/api/admin/repositories/${remote.id}`)).send({ source: 'internal' }).expect(200);
    await admin(supertest(app.server).put(`/api/admin/repositories/${remote.id}`)).send({ source: 'public' }).expect(200);
    const row = await poll(
      () =>
        auditRows(app.db, { type: 'REPOSITORY_UPDATED', targetName: 'qa-ns-public', targetEcosystem: 'npm' }, 5).then((rows) =>
          rows.find((r) => (r.reasons ?? []).includes('Source changed from internal to public'))
        ),
      'source change audit row'
    );
    expect(row).toBeDefined();
  });

  for (const fixture of FIXTURES) {
    describe(fixture.ecosystem, () => {
      let policyId = '';
      const ctx = () => ({ app, auth });
      const get = (path: string) => auth(supertest(app.server).get(path));
      const askedPublicAbout = (name: string, since: number) =>
        seen
          .slice(since)
          .filter(
            (row) =>
              row.side === 'public' &&
              row.ecosystem === fixture.ecosystem &&
              (row.path.includes(fixture.fragment(name)) || row.path.includes(name))
          );

      it('7a. before any policy, the mixed virtual repository serves the public copy (and caches it)', async () => {
        const res = await get(fixture.metadata('qa-ns-mixed', fixture.reserved));
        expect(res.status, res.text.slice(0, 300)).toBe(200);
        expect(fixture.lists(res.text, PUBLIC_VERSION)).toBe(true);
      });

      it('creating the namespace policy validates and saves it', async () => {
        const res = await admin(supertest(app.server).post('/api/admin/policies')).send({
          name: `qa-namespace-${fixture.ecosystem}-${RUN}`,
          decision: 'BLOCK',
          priority: 5,
          conditions: { ecosystem: [fixture.ecosystem], reservedNamespaces: [fixture.pattern] },
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        policyId = res.body.id;
        createdPolicies.push(policyId);
      });

      it('7b. takes effect at once for a name already in the metadata cache (epoch)', async () => {
        const res = await get(fixture.metadata('qa-ns-mixed', fixture.reserved));
        expect(res.status, res.text.slice(0, 300)).toBe(200);
        expect(fixture.lists(res.text, INTERNAL_VERSION)).toBe(true);
        expect(fixture.lists(res.text, PUBLIC_VERSION), 'the public copy is no longer served').toBe(false);
      });

      it('1. through all, a reserved name is served only from the internal remote; the public stub gets no request', async () => {
        const since = seen.length;
        const meta = await get(fixture.metadata('all', fixture.reserved));
        expect(meta.status, meta.text.slice(0, 300)).toBe(200);
        expect(fixture.lists(meta.text, INTERNAL_VERSION)).toBe(true);
        expect(fixture.lists(meta.text, PUBLIC_VERSION)).toBe(false);
        const path = await fixture.artifact(ctx(), 'all', fixture.reserved, INTERNAL_VERSION);
        const art = await get(path);
        expect(art.status, art.text.slice(0, 300)).toBe(200);
        expect(Buffer.from(art.body instanceof Buffer ? art.body : art.text).toString()).toContain(`internal:`);
        expect(askedPublicAbout(fixture.reserved, since)).toEqual([]);
      });

      it('the usage of the download names the internal source repository', async () => {
        // Allowed downloads are not stored row by row (D1); package_usage keeps which remote served them.
        const row = await poll(async () => {
          await flushSummaries(app.db, app.redis);
          const rows: Array<{ repository: string | null; source_repository: string | null; source_type: string | null }> = await app.db.query(
            `SELECT repository, source_repository, source_type FROM package_usage
              WHERE ecosystem = $1 AND package_name = $2 AND decision = 'ALLOW' ORDER BY last_seen_at DESC LIMIT 1`,
            [fixture.ecosystem, fixture.reserved]
          );
          return rows[0];
        }, 'usage row');
        expect(row).toMatchObject({ source_repository: `${fixture.ecosystem}/qa-ns-internal`, source_type: 'internal', repository: 'all' });
      });

      it('2. a reserved name only on the public registry is 404 with a BLOCK ledger row; public is never asked', async () => {
        const since = seen.length;
        const res = await get(fixture.metadata('all', fixture.ghost));
        expect(res.status, res.text.slice(0, 300)).toBe(404);
        expect(askedPublicAbout(fixture.ghost, since)).toEqual([]);
        const row = await poll(
          () =>
            ledgerRows(app.db, { ecosystem: fixture.ecosystem, packageName: fixture.ghost, decision: 'BLOCK_ENFORCE' }, 1).then((rows) => rows[0]),
          'not-found ledger row'
        );
        expect(row.policyId).toBe(policyId);
        expect(row.conditionReasons?.[0]).toMatch(/was not found in internal remotes \(.*qa-ns-internal.*\)\. Public remotes were not consulted\./);
      });

      it('3. through default (public only), the reserved name is blocked with the notice', async () => {
        const meta = await get(fixture.metadata('default', fixture.reserved));
        expect(meta.status).toBe(403);
        expect(meta.body.policyName).toBe(`qa-namespace-${fixture.ecosystem}-${RUN}`);
        expect(meta.body.reasons[0]).toContain(`is in reserved namespace "${fixture.pattern}" and repository "${fixture.ecosystem}/default" has no internal remote`);
        expect(meta.body.checkUrl).toContain('/package-check?');
        // The artifact path is blocked the same way; signed-URL ecosystems have no direct artifact URL on default.
        if (!['pypi', 'composer'].includes(fixture.ecosystem)) {
          const art = await get(await fixture.artifact(ctx(), 'default', fixture.reserved, INTERNAL_VERSION));
          expect(art.status).toBe(403);
          expect(art.body.policyName).toBe(`qa-namespace-${fixture.ecosystem}-${RUN}`);
        }
      });

      it('Package check reports the namespace panel and the block outcome', async () => {
        // Package check allows 30 checks a minute per caller; this suite makes 16.
        const buckets = await app.redis.keys('pkgcheck:rate:*');
        if (buckets.length) await app.redis.del(...buckets);
        const check = await auth(supertest(app.server).post('/api/package-check')).send({
          ecosystem: fixture.ecosystem,
          package: fixture.reserved,
          repository: 'all',
        });
        expect(check.status, JSON.stringify(check.body).slice(0, 300)).toBe(200);
        expect(check.body.namespace).toMatchObject({
          reserved: true,
          mode: 'enforce',
          pattern: fixture.pattern,
          internalRemotes: [`${fixture.ecosystem}/qa-ns-internal`],
          outcome: 'internal',
        });
        expect(check.body.namespace.publicRemotesSkipped).toEqual(expect.arrayContaining([`${fixture.ecosystem}/qa-ns-public`]));
        const blocked = await auth(supertest(app.server).post('/api/package-check')).send({
          ecosystem: fixture.ecosystem,
          package: fixture.reserved,
          repository: 'default',
        });
        expect(blocked.status).toBe(200);
        expect(blocked.body.namespace.outcome).toBe('blocked');
        expect(blocked.body.packageNotice).toMatchObject({ kind: 'namespace' });
      });

      it('4. a name outside the reserved namespace is unchanged (served from the public remote first)', async () => {
        const since = seen.length;
        const res = await get(fixture.metadata('qa-ns-mixed', fixture.other));
        expect(res.status, res.text.slice(0, 300)).toBe(200);
        expect(fixture.lists(res.text, fixture.otherVersion)).toBe(true);
        expect(askedPublicAbout(fixture.other, since).length).toBeGreaterThan(0);
      });

      it('5. no OSV or deps.dev request carries the reserved name', async () => {
        const vuln = await admin(supertest(app.server).post('/api/admin/policies')).send({
          name: `qa-vuln-${fixture.ecosystem}-${RUN}`,
          decision: 'BLOCK',
          priority: 50,
          conditions: { ecosystem: [fixture.ecosystem], cvssMin: 9 },
        });
        expect(vuln.status).toBe(201);
        try {
          const since = outbound.length;
          const path = await fixture.artifact(ctx(), 'all', fixture.reserved, INTERNAL_VERSION);
          expect((await get(path)).status).toBe(200);
          const leaked = outbound
            .slice(since)
            .filter((call) => /osv|deps\.dev/.test(call.url) && `${call.url} ${call.body}`.includes(fixture.reserved));
          expect(leaked).toEqual([]);
        } finally {
          await admin(supertest(app.server).delete(`/api/admin/policies/${vuln.body.id}`));
        }
      });

      it('6. monitor mode changes nothing for clients and records a hit when a public remote serves the name', async () => {
        await admin(supertest(app.server).put(`/api/admin/policies/${policyId}`)).send({ mode: 'monitor' }).expect(200);
        const meta = await get(fixture.metadata('qa-ns-mixed', fixture.reserved));
        expect(meta.status).toBe(200);
        expect(fixture.lists(meta.text, PUBLIC_VERSION), 'public copy served again').toBe(true);
        const path = await fixture.artifact(ctx(), 'qa-ns-mixed', fixture.reserved, PUBLIC_VERSION);
        const art = await get(path);
        expect(art.status, art.text.slice(0, 300)).toBe(200);
        expect(art.text || String(art.body)).toContain('public:');
        const hit = await poll(
          async () => {
            const rows: Array<{ reason_key: string; version: string; reasons: string[] }> = await app.db.query(
              'SELECT reason_key, version, reasons FROM monitor_hits WHERE policy_id = $1',
              [policyId]
            );
            return rows[0];
          },
          'monitor hit'
        );
        expect(hit.reason_key).toBe(`namespace:${fixture.pattern}`);
        expect(hit.reasons[0]).toBe(`Served from public remote ${fixture.ecosystem}/qa-ns-public; enforcing would block it`);
        await admin(supertest(app.server).delete(`/api/admin/policies/${policyId}`)).expect(204);
        createdPolicies.splice(createdPolicies.indexOf(policyId), 1);
      });
    });
  }

  it('the namespace check endpoint explains a saved and a candidate policy', async () => {
    const candidate = await admin(supertest(app.server).post('/api/admin/namespaces/check')).send({
      ecosystem: 'npm',
      name: `@qa${RUN}/billing`,
      repository: 'qa-ns-mixed',
      reservedNamespaces: [`@qa${RUN}`],
      publicPackages: [`@qa${RUN}/eslint-config`],
    });
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);
    expect(candidate.body).toMatchObject({
      reserved: true,
      outcome: 'internal',
      internalRemotes: ['npm/qa-ns-internal'],
      publicRemotesSkipped: ['npm/qa-ns-public'],
    });
    const lifted = await admin(supertest(app.server).post('/api/admin/namespaces/check')).send({
      ecosystem: 'npm',
      name: `@qa${RUN}/eslint-config`,
      repository: 'qa-ns-mixed',
      reservedNamespaces: [`@qa${RUN}`],
      publicPackages: [`@qa${RUN}/eslint-config`],
    });
    expect(lifted.body.outcome).toBe('unrestricted');
    expect(lifted.body.reason).toMatch(/published publicly on purpose/);
    const invalid = await admin(supertest(app.server).post('/api/admin/namespaces/check')).send({
      ecosystem: 'go',
      name: 'github.com/x/y',
      reservedNamespaces: ['github.com'],
    });
    expect(invalid.status).toBe(400);
  });

  it('collision check: off sends nothing; on finds a reserved name that exists publicly', async () => {
    const before = await admin(supertest(app.server).get('/api/admin/config/gateway')).expect(200);
    const policy = await admin(supertest(app.server).post('/api/admin/policies')).send({
      name: `qa-namespace-collision-${RUN}`,
      decision: 'BLOCK',
      conditions: { ecosystem: ['npm'], reservedNamespaces: [`@qa${RUN}`] },
    });
    expect(policy.status).toBe(201);
    createdPolicies.push(policy.body.id);
    try {
      await admin(supertest(app.server).patch('/api/admin/config/gateway')).send({ namespaceCollisionCheck: false }).expect(200);
      const since = seen.length;
      const off = await admin(supertest(app.server).post('/api/admin/namespaces/collisions/run')).expect(202);
      expect(off.body).toMatchObject({ queued: true });
      const outcome = await poll(async () => {
        const res = await admin(supertest(app.server).get(`/api/admin/namespaces/collisions/run/${off.body.jobId}`)).expect(200);
        return res.body.status === 'succeeded' ? res.body : null;
      }, 'queued collision run');
      expect(outcome.skipped).toBe('off');
      expect(seen.length).toBe(since);

      const on = await admin(supertest(app.server).patch('/api/admin/config/gateway')).send({ namespaceCollisionCheck: true }).expect(200);
      expect(on.body.namespaceCollisionCheck).toBe(true);
      const { runCollisionCheck } = await import('../services/namespace-collisions.js');
      const result = await runCollisionCheck(app.db, { publicBase: (eco) => `${stubBase}/public/${eco}`, delayMs: 0 });
      expect(result.skipped).toBeNull();
      expect(result.created).toBeGreaterThanOrEqual(1);
      const list = await admin(supertest(app.server).get(`/api/admin/policies/${policy.body.id}/collisions`)).expect(200);
      expect(list.body).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: `@qa${RUN}/billing`, publicLatestVersion: PUBLIC_VERSION })])
      );
    } finally {
      await admin(supertest(app.server).patch('/api/admin/config/gateway'))
        .send({ namespaceCollisionCheck: before.body.namespaceCollisionCheck === true })
        .expect(200);
    }
  });

  it('the policy API rejects an invalid namespace policy (400)', async () => {
    const cases = [
      { conditions: { ecosystem: ['npm', 'pypi'], reservedNamespaces: ['acme-*'] }, decision: 'BLOCK' },
      { conditions: { ecosystem: ['npm'], reservedNamespaces: ['@acme-*'] }, decision: 'BLOCK' },
      { conditions: { ecosystem: ['maven'], reservedNamespaces: ['com'] }, decision: 'BLOCK' },
      { conditions: { ecosystem: ['npm'], reservedNamespaces: ['@acme'] }, decision: 'ALLOW' },
    ];
    for (const body of cases) {
      const res = await admin(supertest(app.server).post('/api/admin/policies')).send({ name: `qa-namespace-invalid-${RUN}`, ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
