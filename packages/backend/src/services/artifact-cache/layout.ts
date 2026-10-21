import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalPackageName } from '../package-name.js';
import { canonicalComposerVersion } from '../composer-proxy.js';
import type { RemoteTarget } from '../repository-resolve.js';
import type { UpstreamFetchOptions } from '../upstream-provider.js';

/** Bumped when the key or the layout changes; older trees are never read again. */
export const LAYOUT_VERSION = 'v1';

export const CACHE_ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'] as const;
export type CacheEcosystem = (typeof CACHE_ECOSYSTEMS)[number];

export function isCacheEcosystem(value: unknown): value is CacheEcosystem {
  return typeof value === 'string' && (CACHE_ECOSYSTEMS as readonly string[]).includes(value);
}

export type CacheRemote = Pick<RemoteTarget, 'id' | 'key' | 'url' | 'source'>;

/** One file a route is about to serve, and the remote it comes from. */
export type ArtifactRef = {
  ecosystem: CacheEcosystem;
  packageName: string;
  version: string;
  /** The upstream path the route fetches; the file name for PyPI; `name|version|reference` for Composer. */
  path: string;
  remote: CacheRemote;
};

export type EntryLocation = {
  key: string;
  /** `{dir}/v1/{ecosystem}/{pkgHash[0:2]}/{pkgHash}` */
  packageDir: string;
  dataPath: string;
  metaPath: string;
};

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** SHA-256 of the canonical package name: one directory per package, whatever spelling the client used. */
export function packageHash(ecosystem: CacheEcosystem, packageName: string): string {
  return sha256Hex(canonicalPackageName(ecosystem, packageName));
}

/** `v1 | ecosystem | remoteId | sha256(remoteUrl)[0:12] | path`, hashed. A changed remote URL starts fresh keys. */
export function artifactKey(ref: Pick<ArtifactRef, 'ecosystem' | 'path' | 'remote'>): string {
  const urlHash = sha256Hex(ref.remote.url.replace(/\/+$/, '')).slice(0, 12);
  return sha256Hex([LAYOUT_VERSION, ref.ecosystem, ref.remote.id, urlHash, ref.path].join('|'));
}

export function packageDir(root: string, ecosystem: CacheEcosystem, packageName: string): string {
  const hash = packageHash(ecosystem, packageName);
  return path.join(root, LAYOUT_VERSION, ecosystem, hash.slice(0, 2), hash);
}

/** Every segment is a hash or a fixed ecosystem name: nothing the client sent reaches the file system. */
export function locate(root: string, ref: ArtifactRef): EntryLocation {
  if (!isCacheEcosystem(ref.ecosystem)) throw new Error(`Not a cached ecosystem: ${String(ref.ecosystem)}`);
  const key = artifactKey(ref);
  const dir = packageDir(root, ref.ecosystem, ref.packageName);
  return { key, packageDir: dir, dataPath: path.join(dir, key), metaPath: path.join(dir, `${key}.json`) };
}

export const KEY_PATTERN = /^[0-9a-f]{64}$/;
export const META_PATTERN = /^[0-9a-f]{64}\.json$/;

/** Whether two versions name the same release, as each ecosystem spells them. */
export function sameVersion(ecosystem: CacheEcosystem, a: string, b: string): boolean {
  switch (ecosystem) {
    case 'composer':
      return canonicalComposerVersion(a.replace(/^v(?=\d)/i, '')) === canonicalComposerVersion(b.replace(/^v(?=\d)/i, ''));
    case 'go':
      return a.replace(/^v/, '') === b.replace(/^v/, '');
    case 'nuget':
    case 'rubygems':
    case 'pypi':
      return a.toLowerCase() === b.toLowerCase();
    default:
      return a === b;
  }
}

const MAVEN_SIGNATURE_OR_CHECKSUM = /\.(sha1|sha256|sha512|md5|asc)$/i;
const MAVEN_CACHED_FILE = /\.(jar|war|aar|pom|module)$/i;

/** Release jar, war, aar, pom and `.module`, with their checksums and signatures. Never metadata or snapshots. */
export function mavenCacheable(fileName: string, version: string): boolean {
  if (/-SNAPSHOT$/i.test(version) || /^maven-metadata\.xml/i.test(fileName)) return false;
  let base = fileName;
  while (MAVEN_SIGNATURE_OR_CHECKSUM.test(base)) base = base.replace(MAVEN_SIGNATURE_OR_CHECKSUM, '');
  return MAVEN_CACHED_FILE.test(base);
}

export function nugetCacheable(fileName: string): boolean {
  return /\.(nupkg|nuspec)$/i.test(fileName);
}

/** Dist archives of tagged versions; a branch (`dev-main`, `2.x-dev`) moves, so it is never stored. */
export function composerCacheable(version: string, reference: string | undefined): boolean {
  return Boolean(reference) && !/^dev-/i.test(version) && !/-dev$/i.test(version);
}

/**
 * The remote that serves the file when it is known without another upstream call: a single target, or the
 * remote a policy decision already pinned (R5). Null when the fetch would search several remotes.
 */
export function knownRemote(opts: UpstreamFetchOptions | null | undefined): RemoteTarget | null {
  const targets = opts?.targets ?? opts?.route?.targets ?? [];
  return targets.length === 1 ? targets[0] : null;
}

/** A reference for a route's file, or null when its remote is unknown or the file is not one the cache keeps. */
export function artifactRef(
  ecosystem: CacheEcosystem,
  packageName: string,
  version: string,
  keyPath: string,
  remote: RemoteTarget | null | undefined,
  cacheable = true
): ArtifactRef | null {
  if (!cacheable || !remote || !packageName || !keyPath) return null;
  return { ecosystem, packageName, version, path: keyPath, remote };
}
