import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPlainRoutes } from '../test-support/plain-route.js';

const docs = vi.hoisted(() => ({
  json: new Map<string, unknown>(),
  text: new Map<string, string>(),
  packument: null as null | { status: number; body: Record<string, unknown> },
  fail: false,
}));

vi.mock('./package-facts.js', () => ({
  readUpstreamJson: vi.fn(async (_db: unknown, _redis: unknown, route: { ecosystem: string }, path: string) => {
    if (docs.fail) throw new Error('Upstream returned 503');
    return docs.json.get(`${route.ecosystem}:${path}`) ?? null;
  }),
  readUpstreamText: vi.fn(async (_db: unknown, _redis: unknown, route: { ecosystem: string }, path: string) => {
    if (docs.fail) throw new Error('Upstream returned 503');
    const text = docs.text.get(`${route.ecosystem}:${path}`);
    return text == null ? null : { status: 200, fromUrl: '', bodyText: text };
  }),
}));

vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

vi.mock('./npm-packument.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./npm-packument.js')>();
  return {
    ...actual,
    getPackument: vi.fn(async () => docs.packument ?? { status: 404, body: {} }),
  };
});

import {
  listPackageVersions,
  normalizePackageName,
  packageNameError,
  selectWindow,
  sortVersionsNewestFirst,
  type PackageVersionList,
} from './package-versions.js';

const db = {} as never;
const redis = {} as never;

async function versionsOf(ecosystem: string, pkg: string, options = {}): Promise<string[]> {
  const list = await listPackageVersions(db, redis, ecosystem, 'default', pkg, options);
  return list?.versions.map((row) => row.version) ?? [];
}

describe('listPackageVersions', () => {
  beforeEach(() => {
    docs.json.clear();
    docs.text.clear();
    docs.packument = null;
    docs.fail = false;
  });

  it('npm: reads packument versions, publish times and the latest tag', async () => {
    docs.packument = {
      status: 200,
      body: {
        name: 'lodash',
        'dist-tags': { latest: '4.17.21' },
        time: { '4.17.20': '2020-08-13T16:53:54.152Z', '4.17.21': '2021-02-20T15:42:16.891Z', '5.0.0-rc.1': '2026-01-01T00:00:00.000Z' },
        versions: { '4.17.20': {}, '4.17.21': { license: 'MIT' }, '5.0.0-rc.1': {} },
      },
    };
    const list = await listPackageVersions(db, redis, 'npm', 'default', 'lodash');
    expect(list?.versions.map((row) => row.version)).toEqual(['5.0.0-rc.1', '4.17.21', '4.17.20']);
    expect(list?.latestTag).toBe('4.17.21');
    expect(list?.versions[1].publishedAt).toBe('2021-02-20T15:42:16.891Z');
    expect(list?.versions[1].versionMeta?.license).toBe('MIT');
  });

  it('npm: a 404 packument is an unknown package', async () => {
    docs.packument = { status: 404, body: {} };
    expect(await listPackageVersions(db, redis, 'npm', 'default', 'nope')).toBeNull();
  });

  it('PyPI: JSON releases with upload times, skipping releases with no files, PEP 440 order', async () => {
    docs.json.set('pypi:pypi/requests/json', {
      releases: {
        '2.31.0': [{ upload_time_iso_8601: '2023-05-22T15:12:44.175626Z' }],
        '2.32.0rc1': [{ upload_time_iso_8601: '2024-05-01T00:00:00Z' }],
        '2.32.0': [{ upload_time_iso_8601: '2024-05-20T10:00:00Z' }],
        '2.30.0.post1': [{ upload_time: '2023-05-01T00:00:00' }],
        '3.0.0': [],
      },
    });
    const list = await listPackageVersions(db, redis, 'pypi', 'default', 'requests');
    expect(list?.versions.map((row) => row.version)).toEqual(['2.32.0', '2.32.0rc1', '2.31.0', '2.30.0.post1']);
    expect(list?.versions[0].publishedAt).toBe('2024-05-20T10:00:00.000Z');
  });

  it('Go: tagged versions from @v/list', async () => {
    docs.text.set('go:golang.org/x/net/@v/list', 'v0.9.0\nv0.10.0\nv0.10.1-rc.1\n\n');
    expect(await versionsOf('go', 'golang.org/x/net')).toEqual(['v0.10.1-rc.1', 'v0.10.0', 'v0.9.0']);
  });

  it('Go: a requested pseudo-version missing from @v/list is found through .info', async () => {
    const pseudo = 'v0.9.2-0.20260327151000-87f8819acf6d';
    docs.text.set('go:github.com/pkg/errors/@v/list', 'v0.8.1\nv0.9.1\n');
    docs.text.set(`go:github.com/pkg/errors/@v/${pseudo}.info`, JSON.stringify({ Version: pseudo, Time: '2026-03-27T15:10:00Z' }));
    const list = await listPackageVersions(db, redis, 'go', 'default', 'github.com/pkg/errors', {
      goVersions: [pseudo, 'v9.9.9'],
    });
    const row = list?.versions.find((r) => r.version === pseudo);
    expect(row?.publishedAt).toBe('2026-03-27T15:10:00.000Z');
    expect(list?.versions.map((r) => r.version)).not.toContain('v9.9.9');
  });

  it('Maven: artifact maven-metadata.xml with Maven ordering', async () => {
    docs.text.set(
      'maven:org/slf4j/slf4j-api/maven-metadata.xml',
      '<metadata><versioning><versions><version>1.7.36</version><version>2.0.0-alpha1</version><version>2.0.0</version><version>2.0.0-SNAPSHOT</version></versions></versioning></metadata>'
    );
    expect(await versionsOf('maven', 'org.slf4j:slf4j-api')).toEqual(['2.0.0', '2.0.0-SNAPSHOT', '2.0.0-alpha1', '1.7.36']);
  });

  it('NuGet: flat container index', async () => {
    docs.json.set('nuget:v3-flatcontainer/newtonsoft.json/index.json', { versions: ['12.0.3', '13.0.1', '13.0.2-beta1'] });
    expect(await versionsOf('nuget', 'newtonsoft.json')).toEqual(['13.0.2-beta1', '13.0.1', '12.0.3']);
  });

  it('Cargo: crate versions excluding yanked ones', async () => {
    docs.json.set('cargo:api/v1/crates/serde', {
      versions: [
        { num: '1.0.200', created_at: '2024-04-01T00:00:00Z' },
        { num: '1.0.201', yanked: true },
        { num: '1.0.199', created_at: '2024-03-01T00:00:00Z' },
      ],
    });
    expect(await versionsOf('cargo', 'serde')).toEqual(['1.0.200', '1.0.199']);
  });

  it('Composer: p2 versions, with ~dev only when asked', async () => {
    docs.json.set('composer:p2/monolog/monolog.json', {
      packages: { 'monolog/monolog': [{ version: '3.5.0', version_normalized: '3.5.0.0', time: '2023-10-27T15:32:31+00:00' }, { version: '3.4.0', version_normalized: '3.4.0.0' }] },
    });
    docs.json.set('composer:p2/monolog/monolog~dev.json', {
      packages: { 'monolog/monolog': [{ version: 'dev-main', version_normalized: 'dev-main' }] },
    });
    expect(await versionsOf('composer', 'monolog/monolog')).toEqual(['3.5.0', '3.4.0']);
    expect(await versionsOf('composer', 'monolog/monolog', { composerDev: true })).toEqual(['3.5.0', '3.4.0', 'dev-main']);
    expect(await versionsOf('composer', 'monolog/monolog', { composerVersions: ['dev-main', 'dev-other'] })).toEqual([
      '3.5.0',
      '3.4.0',
      'dev-main',
    ]);
  });

  it('RubyGems: one row per version with platforms merged', async () => {
    docs.json.set('rubygems:api/v1/versions/nokogiri.json', [
      { number: '1.16.0', platform: 'ruby', created_at: '2024-01-01T00:00:00Z' },
      { number: '1.16.0', platform: 'java', created_at: '2024-01-01T00:00:00Z' },
      { number: '1.15.5', platform: 'ruby' },
      { number: '1.16.0.rc1', platform: 'ruby' },
    ]);
    expect(await versionsOf('rubygems', 'nokogiri')).toEqual(['1.16.0', '1.16.0.rc1', '1.15.5']);
  });

  it('throws when the upstream cannot be read', async () => {
    docs.fail = true;
    await expect(listPackageVersions(db, redis, 'pypi', 'default', 'requests')).rejects.toThrow('503');
  });
});

describe('sortVersionsNewestFirst', () => {
  it('puts versions that cannot be ordered last, in registry order', () => {
    const rows = ['1.0', 'banana', '2.0', 'apple'].map((version) => ({ version }));
    expect(sortVersionsNewestFirst('pypi', rows).map((row) => row.version)).toEqual(['2.0', '1.0', 'banana', 'apple']);
  });

  it('orders npm pre-releases below their release', () => {
    const rows = ['1.0.0-rc.1', '1.0.0', '0.9.9'].map((version) => ({ version }));
    expect(sortVersionsNewestFirst('npm', rows).map((row) => row.version)).toEqual(['1.0.0', '1.0.0-rc.1', '0.9.9']);
  });
});

describe('selectWindow', () => {
  const list: PackageVersionList = {
    versions: Array.from({ length: 30 }, (_, i) => ({ version: `1.${29 - i}.0` })),
  };

  it('takes the newest 10, plus requested versions and the default version', () => {
    const withRc: PackageVersionList = { versions: [{ version: '2.0.0-rc.1' }, ...list.versions] };
    const window = selectWindow('npm', withRc, ['1.2.0', '9.9.9'], 0, 10);
    const versions = window.rows.map((row) => row.version);
    expect(versions).toHaveLength(11);
    expect(versions[0]).toBe('2.0.0-rc.1');
    expect(versions).toContain('1.2.0');
    expect(window.requested.has('1.2.0')).toBe(true);
    expect(window.missing).toEqual(['9.9.9']);
    expect(window.defaultVersion).toBe('1.29.0');
  });

  it('uses the npm latest tag as the default even when it is old', () => {
    const window = selectWindow('npm', { ...list, latestTag: '1.3.0' }, [], 0, 10);
    expect(window.defaultVersion).toBe('1.3.0');
    expect(window.rows.map((row) => row.version)).toContain('1.3.0');
  });

  it('pages with offset and skips requested versions after the first page', () => {
    const window = selectWindow('npm', list, ['1.0.0'], 10, 10);
    expect(window.rows.map((row) => row.version)).toEqual(list.versions.slice(10, 20).map((row) => row.version));
    expect(window.requested.size).toBe(0);
  });

  it('matches a requested version to an equal listed one', () => {
    const composer: PackageVersionList = { versions: [{ version: '3.5.0.0' }, { version: '3.4.0.0' }] };
    const window = selectWindow('composer', composer, ['3.4.0'], 0, 1);
    expect(window.requested.has('3.4.0.0')).toBe(true);
    expect(window.missing).toEqual([]);
  });
});

describe('package names', () => {
  it('normalises the way each client does', () => {
    expect(normalizePackageName('pypi', 'Django_Rest.Framework')).toBe('django-rest-framework');
    expect(normalizePackageName('nuget', 'Newtonsoft.Json')).toBe('newtonsoft.json');
    expect(normalizePackageName('go', 'github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml');
    expect(normalizePackageName('maven', 'org.slf4j:slf4j-api')).toBe('org.slf4j:slf4j-api');
    expect(normalizePackageName('npm', 'JSONStream')).toBe('JSONStream');
  });

  it('rejects names that are empty, too long, or not valid for the ecosystem', () => {
    expect(packageNameError('npm', '')).toMatch(/Enter a package name/);
    expect(packageNameError('npm', 'a'.repeat(513))).toMatch(/512/);
    expect(packageNameError('npm', 'lo dash')).toMatch(/spaces/);
    expect(packageNameError('go', 'golang.org/../etc')).toMatch(/\.\./);
    expect(packageNameError('npm', '/etc/passwd')).toMatch(/start with/);
    expect(packageNameError('maven', 'slf4j-api')).toMatch(/groupId:artifactId/);
    expect(packageNameError('composer', 'monolog')).toMatch(/vendor\/package/);
    expect(packageNameError('npm', '@types/node')).toBeNull();
    expect(packageNameError('pypi', 'Django')).toBeNull();
    expect(packageNameError('go', 'github.com/BurntSushi/toml')).toBeNull();
  });
});
