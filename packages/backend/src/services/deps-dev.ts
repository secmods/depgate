import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { config } from '../config.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { resolveRemoteTargets, type RemoteTarget } from './repository-resolve.js';

/**
 * deps.dev systems. Composer is absent: Packagist is the only source for it.
 * Names match the API path segment, lowercased.
 */
const DEPS_DEV_SYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'pypi',
  go: 'go',
  maven: 'maven',
  nuget: 'nuget',
  cargo: 'cargo',
  rubygems: 'rubygems',
};

/** Hosts whose public metadata deps.dev indexes. A mirror qualifies through its public source instead. */
const PUBLIC_HOSTS: Record<string, readonly string[]> = {
  npm: ['registry.npmjs.org'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  go: ['proxy.golang.org'],
  maven: [
    'repo1.maven.org',
    'repo.maven.apache.org',
    'maven.google.com',
    'dl.google.com',
    'repo.jenkins-ci.org',
    'plugins.gradle.org',
  ],
  nuget: ['api.nuget.org'],
  cargo: ['crates.io', 'index.crates.io', 'static.crates.io'],
  rubygems: ['rubygems.org', 'index.rubygems.org'],
};

const PACKAGE_PREFIX = 'depsdev:v1:pkg:';
const VERSION_PREFIX = 'depsdev:v1:ver:';
const MISS = '{"miss":true}';

export type DepsBackup = {
  publishedAt: Map<string, string>;
  packageLastReleaseAt?: string;
  licenses: Map<string, string>;
};

type CachedPackage = {
  miss?: boolean;
  versions?: Record<string, string>;
  latest?: string;
};

type CachedVersion = {
  miss?: boolean;
  license?: string;
  publishedAt?: string;
  /** The SOURCE_REPO related project, e.g. `github.com/expressjs/express`. */
  sourceRepo?: string;
  provenance?: string;
  /** Set once relatedProjects was read, so entries written before it are fetched again for a mapping. */
  related?: boolean;
};

function usable(redis: Redis | null | undefined): redis is Redis {
  return !!redis && typeof redis.get === 'function' && typeof redis.setex === 'function';
}

export function depsDevSystem(ecosystem: string): string | undefined {
  return DEPS_DEV_SYSTEM[ecosystem];
}

export function hostIsPublicRegistry(ecosystem: string, url: string): boolean {
  const hosts = PUBLIC_HOSTS[ecosystem];
  if (!hosts) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.includes(host);
  } catch {
    return false;
  }
}

/**
 * Every remote must be marked public or sit on a known public registry host. A mirror or a
 * JFrog remote the admin marked public counts; one internal remote in the mix does not.
 */
export async function repoUsesPublicUpstream(
  db: DataSource,
  ecosystem: string,
  repoKey: string
): Promise<boolean> {
  if (!depsDevSystem(ecosystem)) return false;
  let targets: Array<Pick<RemoteTarget, 'url' | 'source'>>;
  try {
    targets = await resolveRemoteTargets(db, ecosystem, repoKey);
  } catch {
    return false;
  }
  return targetsArePublic(ecosystem, targets);
}

/** At least one remote, and each one marked public or on a known public registry host. Composer qualifies only by its source. */
export function targetsArePublic(ecosystem: string, targets: Array<Pick<RemoteTarget, 'url' | 'source'>>): boolean {
  if (targets.length === 0) return false;
  return targets.every((target) => target.source === 'public' || hostIsPublicRegistry(ecosystem, target.url));
}

/** SPDX ids only. "non-standard" and an empty list stay unknown. deps.dev does not say AND or OR, so several are read as AND. */
export function spdxLicense(licenses: readonly string[] | undefined): string | undefined {
  const usableIds = (licenses ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.toLowerCase() !== 'non-standard');
  if (usableIds.length === 0) return undefined;
  if (usableIds.length === 1) return usableIds[0];
  return usableIds.map((id) => (/\s/.test(id) ? `(${id})` : id)).join(' AND ');
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

function latestOf(values: Iterable<string>): string | undefined {
  let best: number | undefined;
  for (const value of values) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) continue;
    if (best === undefined || at > best) best = at;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Math.min(Math.max(limit, 1), items.length);
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function readCache(redis: Redis | null, key: string): Promise<string | null | undefined> {
  if (!usable(redis)) return undefined;
  try {
    return await redis.get(key);
  } catch {
    return undefined;
  }
}

async function writeCache(redis: Redis | null, key: string, ttl: number, value: string): Promise<void> {
  if (!usable(redis) || ttl <= 0) return;
  try {
    await redis.setex(key, ttl, value);
  } catch {
    /* the caller still uses the value for this request */
  }
}

/** 200 and 404 are successful responses. Transport errors and 5xx open the breaker. */
async function depsFetch(url: string): Promise<{ status: number; body: unknown } | null> {
  const breaker = getCircuitBreaker('depsdev');
  if (!breaker.canExecute()) return null;
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'depgate' },
      signal: AbortSignal.timeout(config.depsDev.timeoutMs),
    });
    if (res.status === 404) {
      breaker.recordSuccess();
      return { status: 404, body: null };
    }
    if (!res.ok) {
      breaker.recordFailure();
      return null;
    }
    breaker.recordSuccess();
    return { status: 200, body: await res.json() };
  } catch {
    breaker.recordFailure();
    return null;
  }
}

function packageUrl(system: string, name: string): string {
  const base = config.depsDev.apiUrl.replace(/\/$/, '');
  return `${base}/v3/systems/${encodeURIComponent(system)}/packages/${encodeURIComponent(name)}`;
}

function versionUrl(system: string, name: string, version: string): string {
  return `${packageUrl(system, name)}/versions/${encodeURIComponent(version)}`;
}

function rememberVersion(into: Map<string, string>, version: string, publishedAt: string): void {
  into.set(version, publishedAt);
}

export function lookupDepsVersion(map: Map<string, string>, version: string): string | undefined {
  const exact = map.get(version);
  if (exact) return exact;
  const lower = version.toLowerCase();
  for (const [key, at] of map) {
    if (key.toLowerCase() === lower) return at;
  }
  return undefined;
}

function parsePackage(body: unknown): { publishedAt: Map<string, string>; packageLastReleaseAt?: string } {
  const publishedAt = new Map<string, string>();
  const versions = (body as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions)) return { publishedAt };
  for (const row of versions) {
    if (!row || typeof row !== 'object') continue;
    const version = (row as { versionKey?: { version?: unknown } }).versionKey?.version;
    const at = iso((row as { publishedAt?: unknown }).publishedAt);
    if (typeof version !== 'string' || !at) continue;
    rememberVersion(publishedAt, version, at);
  }
  return { publishedAt, packageLastReleaseAt: latestOf(publishedAt.values()) };
}

async function loadPackage(
  redis: Redis | null,
  system: string,
  name: string
): Promise<{ publishedAt: Map<string, string>; packageLastReleaseAt?: string } | null> {
  const key = `${PACKAGE_PREFIX}${system}:${name}`;
  const cached = await readCache(redis, key);
  if (cached === MISS) return null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedPackage;
      if (parsed.miss) return null;
      const publishedAt = new Map<string, string>();
      for (const [version, at] of Object.entries(parsed.versions ?? {})) {
        if (typeof at === 'string') publishedAt.set(version, at);
      }
      return { publishedAt, packageLastReleaseAt: parsed.latest };
    } catch {
      /* fetch */
    }
  }

  const result = await depsFetch(packageUrl(system, name));
  if (!result) return null;
  if (result.status === 404) {
    await writeCache(redis, key, config.depsDev.negativeTtl, MISS);
    return null;
  }
  const parsed = parsePackage(result.body);
  const stored: CachedPackage = {
    versions: Object.fromEntries(parsed.publishedAt),
    latest: parsed.packageLastReleaseAt,
  };
  await writeCache(redis, key, config.gateway.factsCacheTtl, JSON.stringify(stored));
  return parsed;
}

async function loadVersion(
  redis: Redis | null,
  system: string,
  name: string,
  version: string
): Promise<{ license?: string; publishedAt?: string } | null> {
  const key = `${VERSION_PREFIX}${system}:${name}:${version}`;
  const cached = await readCache(redis, key);
  if (cached === MISS) return null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedVersion;
      if (parsed.miss) return null;
      return { license: parsed.license, publishedAt: parsed.publishedAt };
    } catch {
      /* fetch */
    }
  }

  const record = await fetchVersion(redis, system, name, version);
  return record ? { license: record.license, publishedAt: record.publishedAt } : null;
}

/** GetVersion, cached with its license, publish time and source repository. Null on 404 or failure. */
async function fetchVersion(redis: Redis | null, system: string, name: string, version: string): Promise<CachedVersion | null | undefined> {
  const key = `${VERSION_PREFIX}${system}:${name}:${version}`;
  const result = await depsFetch(versionUrl(system, name, version));
  if (!result) return undefined;
  if (result.status === 404) {
    await writeCache(redis, key, config.depsDev.negativeTtl, MISS);
    return null;
  }
  const body = result.body as { licenses?: unknown; publishedAt?: unknown; relatedProjects?: unknown } | null;
  const licenses = Array.isArray(body?.licenses) ? body.licenses.filter((item): item is string => typeof item === 'string') : [];
  const source = sourceRepoOf(body?.relatedProjects);
  const record: CachedVersion = {
    license: spdxLicense(licenses),
    publishedAt: iso(body?.publishedAt),
    sourceRepo: source?.project,
    provenance: source?.provenance,
    related: true,
  };
  await writeCache(redis, key, config.gateway.factsCacheTtl, JSON.stringify(record));
  return record;
}

function sourceRepoOf(related: unknown): { project: string; provenance?: string } | undefined {
  if (!Array.isArray(related)) return undefined;
  for (const row of related) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as { relationType?: unknown; relationProvenance?: unknown; projectKey?: { id?: unknown } };
    if (entry.relationType !== 'SOURCE_REPO' || typeof entry.projectKey?.id !== 'string') continue;
    return {
      project: entry.projectKey.id,
      provenance: typeof entry.relationProvenance === 'string' ? entry.relationProvenance : undefined,
    };
  }
  return undefined;
}

export type DepsSourceRepo = { project: string; provenance?: string };

/**
 * The SOURCE_REPO project deps.dev relates to a package version. Null when deps.dev has the
 * version but no source repository, or does not have the version; undefined when it could not be
 * asked (disabled, no system, breaker open, failure). The caller checks the repository is public.
 */
export async function lookupDepsSourceRepo(
  redis: Redis | null,
  ecosystem: string,
  name: string,
  version: string
): Promise<DepsSourceRepo | null | undefined> {
  const system = depsDevSystem(ecosystem);
  if (!config.depsDev.enabled || !system) return undefined;
  const key = `${VERSION_PREFIX}${system}:${name}:${version}`;
  const cached = await readCache(redis, key);
  if (cached === MISS) return null;
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedVersion;
      if (parsed.miss) return null;
      if (parsed.related) return parsed.sourceRepo ? { project: parsed.sourceRepo, provenance: parsed.provenance } : null;
    } catch {
      /* fetch */
    }
  }
  const record = await fetchVersion(redis, system, name, version);
  if (record === undefined) return undefined;
  if (!record?.sourceRepo) return null;
  return { project: record.sourceRepo, provenance: record.provenance };
}

/**
 * GetProject for a repository key such as `github.com/expressjs/express`: the body, null on 404,
 * undefined when deps.dev could not be asked. Used as the Scorecard backup; the caller caches.
 */
export async function lookupDepsProject(projectKey: string): Promise<unknown | null | undefined> {
  if (!config.depsDev.enabled) return undefined;
  const base = config.depsDev.apiUrl.replace(/\/$/, '');
  const result = await depsFetch(`${base}/v3/projects/${encodeURIComponent(projectKey)}`);
  if (!result) return undefined;
  return result.status === 404 ? null : result.body;
}

/**
 * Publish times from GetPackage, licenses from GetVersion.
 * Null when a remote of the repository is internal and not on a known public host, or the API is disabled or unreachable.
 * A null result is not a reason to block the install.
 */
export async function lookupDepsBackup(
  db: DataSource,
  redis: Redis | null,
  ecosystem: string,
  repoKey: string,
  pkg: string,
  opts: { dates: boolean; licenseVersions: string[] }
): Promise<DepsBackup | null> {
  if (!config.depsDev.enabled) return null;
  const system = depsDevSystem(ecosystem);
  if (!system) return null;
  if (!opts.dates && opts.licenseVersions.length === 0) return null;
  if (!(await repoUsesPublicUpstream(db, ecosystem, repoKey))) return null;

  const backup: DepsBackup = { publishedAt: new Map(), licenses: new Map() };
  if (opts.dates) {
    const pack = await loadPackage(redis, system, pkg);
    if (pack) {
      backup.publishedAt = pack.publishedAt;
      backup.packageLastReleaseAt = pack.packageLastReleaseAt;
    }
  }

  await mapLimit(opts.licenseVersions, 8, async (version) => {
    const row = await loadVersion(redis, system, pkg, version);
    if (!row) return;
    if (row.license) backup.licenses.set(version, row.license);
    if (row.publishedAt && !lookupDepsVersion(backup.publishedAt, version)) {
      rememberVersion(backup.publishedAt, version, row.publishedAt);
    }
  });

  return backup;
}
