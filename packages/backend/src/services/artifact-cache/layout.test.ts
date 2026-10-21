import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_ECOSYSTEMS,
  artifactKey,
  artifactRef,
  composerCacheable,
  knownRemote,
  locate,
  mavenCacheable,
  nugetCacheable,
  packageHash,
  sameVersion,
  type ArtifactRef,
  type CacheEcosystem,
} from './layout.js';
import type { RemoteTarget } from '../repository-resolve.js';

const ROOT = path.resolve('/var/lib/depgate/artifacts');

function remote(over: Partial<RemoteTarget> = {}): RemoteTarget {
  return {
    id: 'remote-1',
    key: 'default',
    url: 'https://registry.example.org',
    timeoutMs: 1000,
    retryCount: 0,
    authType: null,
    authEncrypted: null,
    source: 'public',
    ...over,
  };
}

function ref(over: Partial<ArtifactRef> = {}): ArtifactRef {
  return { ecosystem: 'npm', packageName: 'lodash', version: '4.17.21', path: 'lodash/-/lodash-4.17.21.tgz', remote: remote(), ...over };
}

/** One realistic key path per ecosystem, as each route builds it. */
const SAMPLES: Record<CacheEcosystem, { name: string; version: string; path: string }> = {
  npm: { name: '@scope/pkg', version: '1.0.0', path: '@scope/pkg/-/pkg-1.0.0.tgz' },
  pypi: { name: 'requests', version: '2.32.3', path: 'requests-2.32.3-py3-none-any.whl' },
  go: { name: 'rsc.io/quote', version: 'v1.5.2', path: 'rsc.io/quote/@v/v1.5.2.zip' },
  maven: { name: 'org.example:core', version: '1.0', path: 'org/example/core/1.0/core-1.0.jar' },
  nuget: { name: 'newtonsoft.json', version: '13.0.3', path: 'v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg' },
  cargo: { name: 'serde', version: '1.0.0', path: 'api/v1/crates/serde/1.0.0/download' },
  composer: { name: 'monolog/monolog', version: '3.5.0', path: 'monolog/monolog|3.5.0|abc123' },
  rubygems: { name: 'rails', version: '7.1.0', path: 'gems/rails-7.1.0.gem' },
};

describe('artifact cache key', () => {
  it.each(CACHE_ECOSYSTEMS)('%s: a 64-hex key, stable for the same input', (ecosystem) => {
    const sample = SAMPLES[ecosystem];
    const a = ref({ ecosystem, packageName: sample.name, version: sample.version, path: sample.path });
    expect(artifactKey(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(artifactKey(a)).toBe(artifactKey({ ...a }));
  });

  it('differs by ecosystem, remote, remote URL and path', () => {
    const base = artifactKey(ref());
    expect(artifactKey(ref({ ecosystem: 'pypi' }))).not.toBe(base);
    expect(artifactKey(ref({ remote: remote({ id: 'remote-2' }) }))).not.toBe(base);
    expect(artifactKey(ref({ remote: remote({ url: 'https://mirror.example.org' }) }))).not.toBe(base);
    expect(artifactKey(ref({ path: 'lodash/-/lodash-4.17.20.tgz' }))).not.toBe(base);
  });

  it('ignores the remote key, the version label and a trailing slash on the URL', () => {
    const base = artifactKey(ref());
    expect(artifactKey(ref({ remote: remote({ key: 'renamed' }) }))).toBe(base);
    expect(artifactKey(ref({ version: 'other' }))).toBe(base);
    expect(artifactKey(ref({ remote: remote({ url: 'https://registry.example.org/' }) }))).toBe(base);
  });
});

describe('artifact cache layout', () => {
  it.each(CACHE_ECOSYSTEMS)('%s: v1/{ecosystem}/{pkgHash[0:2]}/{pkgHash}/{key} and {key}.json', (ecosystem) => {
    const sample = SAMPLES[ecosystem];
    const loc = locate(ROOT, ref({ ecosystem, packageName: sample.name, path: sample.path }));
    const hash = packageHash(ecosystem, sample.name);
    expect(loc.packageDir).toBe(path.join(ROOT, 'v1', ecosystem, hash.slice(0, 2), hash));
    expect(loc.dataPath).toBe(path.join(loc.packageDir, loc.key));
    expect(loc.metaPath).toBe(`${loc.dataPath}.json`);
  });

  it.each([
    '../../../etc/passwd',
    '..',
    '/absolute/name',
    'a\\..\\b',
    'name\u0000with-nul',
    '%2e%2e%2f',
    'ünïcödé/名前',
    'x'.repeat(4000),
  ])('no client text reaches the path: %j', (hostile) => {
    for (const ecosystem of CACHE_ECOSYSTEMS) {
      const loc = locate(ROOT, ref({ ecosystem, packageName: hostile, path: hostile, version: hostile }));
      const relative = path.relative(ROOT, loc.dataPath);
      expect(relative.startsWith('..')).toBe(false);
      const segments = relative.split(path.sep);
      expect(segments).toHaveLength(5);
      expect(segments[0]).toBe('v1');
      expect(segments[1]).toBe(ecosystem);
      expect(segments[2]).toMatch(/^[0-9a-f]{2}$/);
      expect(segments[3]).toMatch(/^[0-9a-f]{64}$/);
      expect(segments[4]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses an ecosystem it does not cache', () => {
    expect(() => locate(ROOT, ref({ ecosystem: '../npm' as CacheEcosystem }))).toThrow(/Not a cached ecosystem/);
  });

  it('puts every spelling of a package in one directory', () => {
    expect(packageHash('pypi', 'Foo_Bar.baz')).toBe(packageHash('pypi', 'foo-bar-baz'));
    expect(packageHash('nuget', 'Newtonsoft.Json')).toBe(packageHash('nuget', 'newtonsoft.json'));
    expect(packageHash('cargo', 'serde_json')).toBe(packageHash('cargo', 'serde-json'));
    expect(packageHash('go', 'github.com/!buffer!zone/x')).toBe(packageHash('go', 'github.com/BufferZone/x'));
    expect(packageHash('composer', 'Monolog/Monolog')).toBe(packageHash('composer', 'monolog/monolog'));
  });

  it('keeps case-sensitive ecosystems apart', () => {
    expect(packageHash('npm', 'JSONStream')).not.toBe(packageHash('npm', 'jsonstream'));
    expect(packageHash('maven', 'org.Example:core')).not.toBe(packageHash('maven', 'org.example:core'));
  });
});

describe('what is cached', () => {
  it.each([
    ['core-1.0.jar', '1.0', true],
    ['core-1.0-sources.jar', '1.0', true],
    ['core-1.0.war', '1.0', true],
    ['core-1.0.aar', '1.0', true],
    ['core-1.0.pom', '1.0', true],
    ['core-1.0.module', '1.0', true],
    ['core-1.0.jar.sha1', '1.0', true],
    ['core-1.0.pom.sha512', '1.0', true],
    ['core-1.0.jar.md5', '1.0', true],
    ['core-1.0.jar.asc', '1.0', true],
    ['core-1.0.jar.asc.sha256', '1.0', true],
    ['maven-metadata.xml', '1.0', false],
    ['maven-metadata.xml.sha1', 'core', false],
    ['core-1.0-SNAPSHOT.jar', '1.0-SNAPSHOT', false],
    ['core-1.0-20261019.123456-1.jar', '1.0-SNAPSHOT', false],
    ['core-1.0.tar.gz', '1.0', false],
    ['core-1.0.zip', '1.0', false],
  ])('maven %s (%s) → %s', (fileName, version, expected) => {
    expect(mavenCacheable(fileName, version)).toBe(expected);
  });

  it('nuget: .nupkg and .nuspec only', () => {
    expect(nugetCacheable('newtonsoft.json.13.0.3.nupkg')).toBe(true);
    expect(nugetCacheable('newtonsoft.json.nuspec')).toBe(true);
    expect(nugetCacheable('index.json')).toBe(false);
    expect(nugetCacheable('icon.png')).toBe(false);
  });

  it('composer: tagged versions with a reference, never branches', () => {
    expect(composerCacheable('3.5.0', 'abc')).toBe(true);
    expect(composerCacheable('3.5.0', undefined)).toBe(false);
    expect(composerCacheable('dev-main', 'abc')).toBe(false);
    expect(composerCacheable('2.x-dev', 'abc')).toBe(false);
  });

  it('artifactRef needs a remote and a cacheable file', () => {
    expect(artifactRef('npm', 'lodash', '1.0.0', 'lodash/-/lodash-1.0.0.tgz', remote())).not.toBeNull();
    expect(artifactRef('npm', 'lodash', '1.0.0', 'lodash/-/lodash-1.0.0.tgz', null)).toBeNull();
    expect(artifactRef('npm', 'lodash', '1.0.0', 'lodash/-/lodash-1.0.0.tgz', remote(), false)).toBeNull();
    expect(artifactRef('npm', '', '1.0.0', 'x', remote())).toBeNull();
  });
});

describe('knownRemote (§3 rule 3)', () => {
  const a = remote({ id: 'a' });
  const b = remote({ id: 'b', source: 'internal' });

  it('is the single target of a route', () => {
    expect(knownRemote({ route: { targets: [a] } })).toBe(a);
  });

  it('is the remote pinned for the policy or listed in metadata', () => {
    expect(knownRemote({ targets: [b] })).toBe(b);
  });

  it('is unknown when the fetch would search several remotes', () => {
    expect(knownRemote({ route: { targets: [a, b] } })).toBeNull();
    expect(knownRemote({ route: { targets: [] } })).toBeNull();
    expect(knownRemote(null)).toBeNull();
  });
});

describe('sameVersion', () => {
  it('compares as each ecosystem spells versions', () => {
    expect(sameVersion('go', 'v1.2.3', '1.2.3')).toBe(true);
    expect(sameVersion('composer', '3.5.0.0', '3.5.0')).toBe(true);
    expect(sameVersion('composer', 'v3.5.0', '3.5.0')).toBe(true);
    expect(sameVersion('nuget', '1.0.0-Beta', '1.0.0-beta')).toBe(true);
    expect(sameVersion('npm', '1.0.0-Beta', '1.0.0-beta')).toBe(false);
    expect(sameVersion('maven', '1.0', '1.0.0')).toBe(false);
  });
});
