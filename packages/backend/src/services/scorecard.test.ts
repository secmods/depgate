import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import type { PackageRoute } from './namespace-protection.js';
import type { RemoteTarget } from './repository-resolve.js';

const fetchFromUpstream = vi.hoisted(() => vi.fn());
const fetchStreamFromUpstream = vi.hoisted(() => vi.fn());
const getPackument = vi.hoisted(() => vi.fn());

vi.mock('./upstream-provider.js', () => ({
  fetchFromUpstream: (...args: unknown[]) => fetchFromUpstream(...args),
  fetchStreamFromUpstream: (...args: unknown[]) => fetchStreamFromUpstream(...args),
}));

vi.mock('./npm-packument.js', async (orig) => ({
  ...(await orig<object>()),
  getPackument: (...args: unknown[]) => getPackument(...args),
}));

import { config } from '../config.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import {
  clearScorecardMemory,
  composerSourceUrls,
  goRepositoryCandidate,
  lookupScorecards,
  pomRepositoryCandidates,
  pypiRepositoryCandidates,
  scorecardView,
} from './scorecard.js';

const db = {} as DataSource;
const SCORECARD = 'https://api.securityscorecards.dev';
const DEPS = 'https://api.deps.dev';
const isScorecard = (url: string) => url.startsWith(`${SCORECARD}/`);
const isDeps = (url: string) => url.startsWith(`${DEPS}/`);

function target(url: string, source: 'public' | 'internal' = 'public', key = 'remote'): RemoteTarget {
  return { id: `${key}-id`, key, url, timeoutMs: 1000, retryCount: 0, authType: null, authEncrypted: null, source };
}

function route(ecosystem: string, targets: RemoteTarget[], extra: Partial<PackageRoute> = {}): PackageRoute {
  return {
    ecosystem,
    repoKey: 'default',
    packageName: 'x',
    targets,
    cacheScope: 'default',
    reserved: null,
    monitored: [],
    skipped: [],
    block: null,
    ...extra,
  };
}

const PUBLIC: Record<string, RemoteTarget> = {
  npm: target('https://registry.npmjs.org'),
  pypi: target('https://pypi.org'),
  cargo: target('https://crates.io'),
  composer: target('https://repo.packagist.org'),
  rubygems: target('https://rubygems.org'),
  nuget: target('https://api.nuget.org'),
  maven: target('https://repo1.maven.org/maven2'),
  go: target('https://proxy.golang.org'),
};

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function upstream(status: number, body: unknown) {
  return { status, fromUrl: 'https://upstream.test/x', body };
}

function text(status: number, body: string) {
  return { status, fromUrl: 'https://upstream.test/x', headers: new Headers(), body: Readable.from([Buffer.from(body)]) };
}

function scorecardBody(overall: number, checks: Record<string, number> = { Maintained: 10 }) {
  return {
    date: '2026-10-12T21:25:40Z',
    score: overall,
    checks: Object.entries(checks).map(([name, score]) => ({ name, score, reason: '' })),
  };
}

describe('Scorecard lookup', () => {
  const fetchMock = vi.fn();
  let redis: Redis;
  const calls = () => fetchMock.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    fetchFromUpstream.mockReset();
    fetchStreamFromUpstream.mockReset();
    getPackument.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    redis = createMemoryRedis() as unknown as Redis;
    clearScorecardMemory();
    getCircuitBreaker('scorecard').recordSuccess();
    getCircuitBreaker('depsdev').recordSuccess();
    fetchFromUpstream.mockResolvedValue(upstream(404, null));
    fetchStreamFromUpstream.mockResolvedValue(text(404, ''));
    fetchMock.mockResolvedValue(json(404, null));
  });

  describe('which repositories it applies to (§5.1)', () => {
    const seeded = new Map([['1.0.0', 'https://github.com/x/y']]);

    it.each([
      ['an internal remote on a private host', [target('https://nexus.corp/npm', 'internal')], 'internal-remote'],
      ['a virtual repository with one internal remote', [PUBLIC.npm, target('https://npm.corp/local', 'internal', 'npm-local')], 'internal-remote'],
      ['a repository with no remotes', [], 'internal-remote'],
    ])('does not apply to %s and makes no call', async (_label, targets, reason) => {
      const out = await lookupScorecards(db, redis, route('npm', targets), 'left-pad', ['1.0.0'], seeded);
      expect(out.get('1.0.0')).toEqual({ status: 'not-applicable', reason });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getPackument).not.toHaveBeenCalled();
    });

    it('does not apply to a name in a reserved or monitored namespace, through a public repository', async () => {
      const reserved = route('npm', [PUBLIC.npm], { reserved: { policyId: 'p' } as never });
      const monitored = route('npm', [PUBLIC.npm], { monitored: [{ policyId: 'p' } as never] });
      for (const r of [reserved, monitored]) {
        expect((await lookupScorecards(db, redis, r, '@acme/billing', ['1.0.0'], seeded)).get('1.0.0')).toEqual({
          status: 'not-applicable',
          reason: 'private-name',
        });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('applies to a known public host even when it is marked internal, and to a mirror marked public', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(7)));
      for (const t of [target('https://registry.npmjs.org', 'internal'), target('https://acme.jfrog.io/artifactory/api/npm/npm-remote', 'public')]) {
        const out = await lookupScorecards(db, createMemoryRedis() as unknown as Redis, route('npm', [t]), 'left-pad', ['1.0.0'], seeded);
        expect(out.get('1.0.0')?.status).toBe('found');
      }
    });

    it('applies to a Composer remote only when it is marked public (no known Composer host)', async () => {
      fetchFromUpstream.mockResolvedValue(
        upstream(200, { packages: { 'acme/lib': [{ version: '1.0.0', source: { url: 'https://github.com/acme/lib.git' } }] } })
      );
      fetchMock.mockResolvedValue(json(200, scorecardBody(6)));
      const internal = await lookupScorecards(db, redis, route('composer', [target('https://repo.packagist.org', 'internal')]), 'acme/lib', ['1.0.0']);
      expect(internal.get('1.0.0')).toEqual({ status: 'not-applicable', reason: 'internal-remote' });
      const pub = await lookupScorecards(db, redis, route('composer', [PUBLIC.composer]), 'acme/lib', ['1.0.0']);
      expect(pub.get('1.0.0')).toMatchObject({ status: 'found', result: { project: 'github.com/acme/lib', via: 'registry' } });
    });

    it('makes no call when SCORECARD_ENABLED is off', async () => {
      const settings = config.scorecard as { enabled: boolean };
      settings.enabled = false;
      try {
        const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'left-pad', ['1.0.0'], seeded);
        expect(out.get('1.0.0')).toEqual({ status: 'disabled' });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        settings.enabled = true;
      }
    });
  });

  describe('step 1: the source repository', () => {
    it('uses an npm seed without reading the packument', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(8.9)));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['4.21.2'], new Map([['4.21.2', 'git+https://github.com/expressjs/express.git']]));
      expect(out.get('4.21.2')).toMatchObject({ status: 'found', result: { project: 'github.com/expressjs/express', overall: 8.9, scoreVia: 'scorecard' } });
      expect(getPackument).not.toHaveBeenCalled();
      expect(calls()).toEqual([`${SCORECARD}/projects/github.com/expressjs/express`]);
    });

    it('reads the full npm packument when the version document had no repository', async () => {
      getPackument.mockResolvedValue({ status: 200, body: { versions: { '1.0.0': { repository: { type: 'git', url: 'expressjs/express' } } } } });
      fetchMock.mockResolvedValue(json(200, scorecardBody(8.9)));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0']);
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { project: 'github.com/expressjs/express' } });
    });

    it('PyPI: prefers a Source URL over the homepage', async () => {
      fetchFromUpstream.mockResolvedValue(
        upstream(200, {
          info: { project_urls: { Homepage: 'https://github.com/wrong/one', Source: 'https://github.com/psf/requests' }, home_page: 'https://requests.readthedocs.io' },
        })
      );
      fetchMock.mockResolvedValue(json(200, scorecardBody(7.1)));
      const out = await lookupScorecards(db, redis, route('pypi', [PUBLIC.pypi]), 'requests', ['2.32.0']);
      expect(out.get('2.32.0')).toMatchObject({ status: 'found', result: { project: 'github.com/psf/requests' } });
    });

    it.each([
      ['cargo', 'serde', { crate: { repository: 'https://github.com/serde-rs/serde' } }, 'github.com/serde-rs/serde'],
      ['rubygems', 'rails', [{ number: '7.1.0', metadata: { source_code_uri: 'https://github.com/rails/rails/tree/v7.1.0' } }], 'github.com/rails/rails'],
      [
        'nuget',
        'Newtonsoft.Json',
        { items: [{ items: [{ catalogEntry: { version: '13.0.3', projectUrl: 'https://github.com/JamesNK/Newtonsoft.Json' } }] }] },
        'github.com/JamesNK/Newtonsoft.Json',
      ],
    ])('%s: reads the repository from the registry document', async (ecosystem, pkg, doc, project) => {
      fetchFromUpstream.mockResolvedValue(upstream(200, doc));
      fetchMock.mockResolvedValue(json(200, scorecardBody(6)));
      const version = ecosystem === 'cargo' ? '1.0.0' : ecosystem === 'rubygems' ? '7.1.0' : '13.0.3';
      const out = await lookupScorecards(db, redis, route(ecosystem, [PUBLIC[ecosystem]]), pkg, [version]);
      expect(out.get(version)).toMatchObject({ status: 'found', result: { project, via: 'registry' } });
    });

    const FORMS = [
      'ssh://git@github.com/acme/tool.git',
      'git+ssh://git@github.com:acme/tool.git',
      'git@github.com:acme/tool.git',
      'git://github.com/acme/tool.git',
      'git+https://github.com/acme/tool.git',
      'https://github.com/acme/tool',
      'http://www.github.com/acme/tool/',
      'https://github.com/acme/tool/tree/main/packages/tool',
    ];
    /** The registry document each ecosystem publishes, carrying `url` where that ecosystem puts the repository. */
    const DOCS: Record<string, { pkg: string; version: string; json?: (url: string) => unknown; pom?: (url: string) => string }> = {
      pypi: { pkg: 'acme-tool', version: '1.0', json: (url) => ({ info: { project_urls: { Source: url } } }) },
      cargo: { pkg: 'acme-tool', version: '1.0.0', json: (url) => ({ crate: { repository: url } }) },
      composer: { pkg: 'acme/tool', version: '1.0.0', json: (url) => ({ packages: { 'acme/tool': [{ version: '1.0.0', source: { url } }] } }) },
      rubygems: { pkg: 'acme-tool', version: '1.0.0', json: (url) => [{ number: '1.0.0', metadata: { source_code_uri: url } }] },
      nuget: { pkg: 'Acme.Tool', version: '1.0.0', json: (url) => ({ items: [{ items: [{ catalogEntry: { version: '1.0.0', projectUrl: url } }] }] }) },
      maven: { pkg: 'com.acme:tool', version: '1.0.0', pom: (url) => `<project><scm><connection>scm:git:${url}</connection></scm></project>` },
      npm: { pkg: 'acme-tool', version: '1.0.0' },
    };

    describe.each(Object.keys(DOCS))('%s registry metadata', (ecosystem) => {
      it.each(FORMS)('maps %s to github.com/acme/tool', async (url) => {
        const doc = DOCS[ecosystem];
        if (doc.json) fetchFromUpstream.mockResolvedValue(upstream(200, doc.json(url)));
        if (doc.pom) fetchStreamFromUpstream.mockResolvedValue(text(200, doc.pom(url)));
        getPackument.mockResolvedValue({ status: 200, body: { versions: { [doc.version]: { repository: { type: 'git', url } } } } });
        fetchMock.mockResolvedValue(json(200, scorecardBody(7)));
        const out = await lookupScorecards(db, redis, route(ecosystem, [PUBLIC[ecosystem]]), doc.pkg, [doc.version]);
        expect(out.get(doc.version)).toMatchObject({ status: 'found', result: { project: 'github.com/acme/tool', via: 'registry' } });
        expect(calls().filter((call) => isDeps(call)), 'no deps.dev call for a usable registry URL').toEqual([]);
        expect(calls()).toContain(`${SCORECARD}/projects/github.com/acme/tool`);
      });
    });

    it('npm: the version document repository works as a seed in every form', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(7)));
      const seeds = new Map(FORMS.map((url, i) => [`1.0.${i}`, url]));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'acme-tool', [...seeds.keys()], seeds);
      for (const version of seeds.keys()) {
        expect(out.get(version), version).toMatchObject({ status: 'found', result: { project: 'github.com/acme/tool' } });
      }
      expect(getPackument).not.toHaveBeenCalled();
    });

    it('a deps.dev mapping in any URL form is normalised too', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(200, { crate: { repository: null } }));
      fetchMock.mockImplementation(async (url: string) =>
        isDeps(url)
          ? json(200, { relatedProjects: [{ projectKey: { id: 'git@github.com:acme/tool.git' }, relationType: 'SOURCE_REPO' }] })
          : json(200, scorecardBody(7))
      );
      const out = await lookupScorecards(db, redis, route('cargo', [PUBLIC.cargo]), 'acme-tool', ['1.0.0']);
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { project: 'github.com/acme/tool', via: 'deps.dev' } });
    });

    it('Maven: reads <scm> from the version POM', async () => {
      fetchStreamFromUpstream.mockResolvedValue(text(200, '<project><url>https://junit.org</url><scm><url>https://github.com/junit-team/junit4</url></scm></project>'));
      fetchMock.mockResolvedValue(json(200, scorecardBody(5.5)));
      const out = await lookupScorecards(db, redis, route('maven', [PUBLIC.maven]), 'junit:junit', ['4.13.2']);
      expect(out.get('4.13.2')).toMatchObject({ status: 'found', result: { project: 'github.com/junit-team/junit4' } });
      expect(fetchStreamFromUpstream.mock.calls[0][2]).toBe('junit/junit/4.13.2/junit-4.13.2.pom');
    });

    it('Go: a GitHub module path is its repository, with no registry read', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(7)));
      const out = await lookupScorecards(db, redis, route('go', [PUBLIC.go]), 'github.com/spf13/cobra/doc', ['v1.8.0']);
      expect(out.get('v1.8.0')).toMatchObject({ status: 'found', result: { project: 'github.com/spf13/cobra' } });
      expect(fetchFromUpstream).not.toHaveBeenCalled();
    });

    it('falls back to deps.dev when the registry has no usable URL, and keeps its provenance', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(200, { info: { project_urls: {}, home_page: 'https://example.org' } }));
      fetchMock.mockImplementation(async (url: string) => {
        if (isDeps(url)) {
          return json(200, {
            relatedProjects: [
              { projectKey: { id: 'github.com/acme/tool' }, relationType: 'ISSUE_TRACKER', relationProvenance: 'UNVERIFIED_METADATA' },
              { projectKey: { id: 'github.com/acme/tool' }, relationType: 'SOURCE_REPO', relationProvenance: 'PYPI_PUBLISH_ATTESTATION' },
            ],
          });
        }
        return json(200, scorecardBody(4));
      });
      const out = await lookupScorecards(db, redis, route('pypi', [PUBLIC.pypi]), 'acme-tool', ['1.0']);
      expect(out.get('1.0')).toMatchObject({
        status: 'found',
        result: { project: 'github.com/acme/tool', via: 'deps.dev', provenance: 'PYPI_PUBLISH_ATTESTATION' },
      });
      expect(calls()[0]).toBe(`${DEPS}/v3/systems/pypi/packages/acme-tool/versions/1.0`);
    });

    it('falls back to deps.dev when the registry call fails', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(503, null));
      fetchMock.mockImplementation(async (url: string) =>
        isDeps(url)
          ? json(200, { relatedProjects: [{ projectKey: { id: 'github.com/serde-rs/serde' }, relationType: 'SOURCE_REPO' }] })
          : json(200, scorecardBody(9))
      );
      const out = await lookupScorecards(db, redis, route('cargo', [PUBLIC.cargo]), 'serde', ['1.0.0']);
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { via: 'deps.dev' } });
    });

    it('is unavailable when the registry and deps.dev both fail, and caches nothing', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(503, null));
      fetchMock.mockResolvedValue(json(503, null));
      const out = await lookupScorecards(db, redis, route('cargo', [PUBLIC.cargo]), 'serde', ['1.0.0']);
      expect(out.get('1.0.0')).toEqual({ status: 'unavailable' });
      expect(await redis.get('scorecard:v1:map:cargo:serde:1.0.0')).toBeNull();
    });

    it('Composer has no backup: no usable source.url is unknown', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(200, { packages: { 'acme/lib': [{ version: '1.0.0', source: { url: 'https://bitbucket.org/acme/lib' } }] } }));
      const out = await lookupScorecards(db, redis, route('composer', [PUBLIC.composer]), 'acme/lib', ['1.0.0']);
      expect(out.get('1.0.0')).toEqual({ status: 'unknown', reason: 'unsupported-host' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('tells "no repository" from "a host without Scorecard"', async () => {
      fetchFromUpstream.mockResolvedValue(upstream(200, { crate: { repository: null } }));
      const out = await lookupScorecards(db, redis, route('cargo', [PUBLIC.cargo]), 'nothing', ['1.0.0']);
      expect(out.get('1.0.0')).toEqual({ status: 'unknown', reason: 'no-repository' });
    });
  });

  describe('step 2: the score', () => {
    const seeds = (version: string) => new Map([[version, 'https://github.com/expressjs/express']]);

    const depsProject = (overall: number) =>
      json(200, { scorecard: { date: '2026-08-24T00:00:00Z', overallScore: overall, checks: [{ name: 'Maintained', score: 10 }] } });

    it('uses the deps.dev score when the Scorecard API has no result (404), and caches it for the full TTL', async () => {
      fetchMock.mockImplementation(async (url: string) => (isScorecard(url) ? json(404, null) : depsProject(6.2)));
      const setex = vi.spyOn(redis, 'setex');
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { overall: 6.2, scoreVia: 'deps.dev' } });
      expect(calls()).toEqual([`${SCORECARD}/projects/github.com/expressjs/express`, `${DEPS}/v3/projects/github.com%2Fexpressjs%2Fexpress`]);
      const projectWrite = setex.mock.calls.find((call) => String(call[0]).startsWith('scorecard:v1:proj:'));
      expect(projectWrite?.[1]).toBe(config.scorecard.cacheTtl);
    });

    it('uses the deps.dev score when the Scorecard API answers without a score', async () => {
      fetchMock.mockImplementation(async (url: string) => (isScorecard(url) ? json(200, { date: '2026-10-12T00:00:00Z' }) : depsProject(3)));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { overall: 3, scoreVia: 'deps.dev' } });
    });

    it('is unknown when neither the Scorecard API nor deps.dev has a result, and remembers the miss', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        isScorecard(url) ? json(404, null) : json(200, { projectKey: { id: 'github.com/expressjs/express' } })
      );
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toEqual({ status: 'unknown', reason: 'not-scanned', project: 'github.com/expressjs/express' });
      expect(JSON.parse((await redis.get('scorecard:v1:proj:github.com/expressjs/express'))!)).toEqual({ miss: true });
    });

    it('is unknown, not unavailable, when the Scorecard API has no result and deps.dev fails; the miss is not cached', async () => {
      fetchMock.mockImplementation(async (url: string) => (isScorecard(url) ? json(404, null) : json(503, null)));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toEqual({ status: 'unknown', reason: 'not-scanned', project: 'github.com/expressjs/express' });
      expect(await redis.get('scorecard:v1:proj:github.com/expressjs/express')).toBeNull();
    });

    it('does not ask deps.dev for the score when DEPS_DEV_ENABLED is off', async () => {
      const settings = config.depsDev as { enabled: boolean };
      settings.enabled = false;
      try {
        fetchMock.mockResolvedValue(json(404, null));
        const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
        expect(out.get('1.0.0')?.status).toBe('unknown');
        expect(calls().filter((url) => isDeps(url))).toEqual([]);
      } finally {
        settings.enabled = true;
      }
    });

    it('uses the deps.dev project while the Scorecard API fails, and keeps it only briefly', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        isScorecard(url)
          ? json(503, null)
          : json(200, { scorecard: { date: '2026-08-24T00:00:00Z', overallScore: 8.5, checks: [{ name: 'Maintained', score: 10 }] } })
      );
      const setex = vi.spyOn(redis, 'setex');
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toMatchObject({ status: 'found', result: { overall: 8.5, scoreVia: 'deps.dev', checks: { Maintained: 10 } } });
      expect(calls()[1]).toBe(`${DEPS}/v3/projects/github.com%2Fexpressjs%2Fexpress`);
      const projectWrite = setex.mock.calls.find((call) => String(call[0]).startsWith('scorecard:v1:proj:'));
      expect(projectWrite?.[1]).toBe(config.scorecard.negativeTtl);
    });

    it('is unavailable when the Scorecard API and deps.dev both fail', async () => {
      fetchMock.mockResolvedValue(json(503, null));
      const out = await lookupScorecards(db, redis, route('npm', [PUBLIC.npm]), 'express', ['1.0.0'], seeds('1.0.0'));
      expect(out.get('1.0.0')).toEqual({ status: 'unavailable' });
      expect(await redis.get('scorecard:v1:proj:github.com/expressjs/express')).toBeNull();
    });

    it('reads every version mapping in one Redis round trip, then from process memory', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(8)));
      const memoryRedis = createMemoryRedis();
      const r = route('npm', [PUBLIC.npm]);
      const versions = Array.from({ length: 50 }, (_, i) => `1.0.${i}`);
      const seeds = new Map(versions.map((version) => [version, 'https://github.com/qs/qs']));
      await lookupScorecards(db, memoryRedis as unknown as Redis, r, 'qs', versions, seeds);

      clearScorecardMemory();
      memoryRedis.calls.length = 0;
      const out = await lookupScorecards(db, memoryRedis as unknown as Redis, r, 'qs', versions, seeds);
      expect(out.get('1.0.49')?.status).toBe('found');
      expect(memoryRedis.calls.filter((call) => call.startsWith('mget'))).toEqual(['mget 50']);
      expect(memoryRedis.calls.filter((call) => call.startsWith('get scorecard:v1:map:'))).toEqual([]);

      memoryRedis.calls.length = 0;
      await lookupScorecards(db, memoryRedis as unknown as Redis, r, 'qs', versions, seeds);
      expect(memoryRedis.calls).toEqual([]);
      expect(calls().filter((url) => isScorecard(url))).toHaveLength(1);
    });

    it('fetches one project once for every package and version that maps to it', async () => {
      fetchMock.mockResolvedValue(json(200, scorecardBody(8)));
      const r = route('npm', [PUBLIC.npm]);
      const repo = 'https://github.com/babel/babel';
      await lookupScorecards(db, redis, r, '@babel/core', ['7.0.0', '7.1.0'], new Map([['7.0.0', repo], ['7.1.0', repo]]));
      await lookupScorecards(db, redis, r, '@babel/parser', ['7.0.0'], new Map([['7.0.0', repo]]));
      expect(calls().filter((url) => isScorecard(url))).toHaveLength(1);
    });
  });

  it('scorecardView lists checks by name and passes unknown reasons through', () => {
    expect(
      scorecardView({
        status: 'found',
        result: { project: 'github.com/x/y', via: 'registry', scoreVia: 'scorecard', date: 'd', overall: 5, checks: { SAST: 10, Fuzzing: 0 } },
      }).checks
    ).toEqual([
      { name: 'Fuzzing', score: 0 },
      { name: 'SAST', score: 10 },
    ]);
    expect(scorecardView({ status: 'unknown', reason: 'no-repository' })).toEqual({ status: 'unknown', reason: 'no-repository', project: undefined });
  });
});

describe('repository extractors', () => {
  it('expands minified Composer metadata, where later versions inherit source', () => {
    const urls = composerSourceUrls(
      {
        minified: 'composer/2.0',
        packages: {
          'monolog/monolog': [
            { version: '3.5.0', version_normalized: '3.5.0.0', source: { url: 'https://github.com/Seldaek/monolog.git' } },
            { version: '3.4.0', version_normalized: '3.4.0.0' },
            { version: '3.3.0', version_normalized: '3.3.0.0', source: '__unset' },
          ],
        },
      },
      'monolog/monolog'
    );
    expect(urls.get('3.5.0')).toBe('https://github.com/Seldaek/monolog.git');
    expect(urls.get('3.4.0')).toBe('https://github.com/Seldaek/monolog.git');
    expect(urls.get('3.3.0')).toBeUndefined();
  });

  it('reads POM scm, then connection, then the project url, ignoring nested urls', () => {
    expect(pomRepositoryCandidates('<project><scm><connection>scm:git:git://github.com/a/b.git</connection></scm></project>')).toEqual([
      'scm:git:git://github.com/a/b.git',
    ]);
    expect(
      pomRepositoryCandidates('<project><licenses><license><url>https://apache.org</url></license></licenses><url>https://github.com/c/d</url></project>')
    ).toEqual(['https://github.com/c/d']);
  });

  it('decodes Go module paths and ignores vanity paths', () => {
    expect(goRepositoryCandidate('github.com/!burnt!sushi/toml')).toBe('github.com/BurntSushi/toml');
    expect(goRepositoryCandidate('golang.org/x/net')).toBeUndefined();
  });

  it('orders PyPI URLs by how likely they are to be the source', () => {
    expect(pypiRepositoryCandidates({ project_urls: { Documentation: 'd', Repository: 'r', Homepage: 'h' }, home_page: 'hp' })).toEqual(['r', 'h', 'd', 'hp']);
  });
});
