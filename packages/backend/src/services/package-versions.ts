import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import {
  getPackument,
  latestVersionPublishTime,
  packumentTimeMap,
  withVersionPublishTime,
  type PackumentVersion,
} from './npm-packument.js';
import { readUpstreamJson, readUpstreamText } from './package-facts.js';
import { resolvePackageTargets, type PackageRoute } from './namespace-protection.js';
import { extractMavenMetadataVersions } from './maven-proxy.js';
import { extractFlatContainerVersions } from './nuget-proxy.js';
import { extractComposerVersions } from './composer-proxy.js';
import { extractRubygemsVersions } from './rubygems-proxy.js';
import { compareVersions } from './version-range.js';
import { classifyRelease } from './release-type.js';

export type ListedVersion = {
  version: string;
  /** ISO time when the version document says so. */
  publishedAt?: string;
  /** npm only: the version document, so evaluation needs no second read. */
  versionMeta?: PackumentVersion;
};

export type PackageVersionList = {
  /** Newest first by the ecosystem's ordering; versions that cannot be ordered go last. */
  versions: ListedVersion[];
  /** npm `latest` dist-tag. Other ecosystems use the highest stable version. */
  latestTag?: string;
  packageLastReleaseAt?: string;
};

export type ListOptions = {
  /** Composer: also read `~dev.json` for branch versions. */
  composerDev?: boolean;
  /**
   * Composer branch versions asked for by name, such as `dev-main`.
   * Included from `~dev.json` even when `composerDev` is false, without the other branches.
   */
  composerVersions?: string[];
  /** Go: versions asked for by name. `@v/list` holds tagged versions only, so these are looked up by `.info`. */
  goVersions?: string[];
};

export const PACKAGE_NAME_MAX_LENGTH = 512;

const NAME_PATTERNS: Record<string, RegExp> = {
  npm: /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i,
  pypi: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i,
  go: /^[a-z0-9.!_~+-]+(?:\/[a-z0-9.!_~+-]+)*$/i,
  maven: /^[a-z0-9_.-]+:[a-z0-9_.-]+$/i,
  nuget: /^[a-z0-9_.-]+$/i,
  cargo: /^[a-z0-9_-]+$/i,
  composer: /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/,
  rubygems: /^[a-z0-9_.-]+$/i,
};

const NAME_HINTS: Record<string, string> = {
  maven: 'Use groupId:artifactId, e.g. org.slf4j:slf4j-api',
  composer: 'Use vendor/package, e.g. monolog/monolog',
  go: 'Use the module path, e.g. golang.org/x/net',
};

/**
 * The name each ecosystem's own client sends, which is also the name the gateway evaluates:
 * PEP 503 for PyPI, lowercase for NuGet, Cargo, Composer and RubyGems, and the module
 * proxy's `!` case-encoding for Go.
 */
export function normalizePackageName(ecosystem: string, name: string): string {
  const trimmed = name.trim();
  switch (ecosystem) {
    case 'pypi':
      return trimmed.toLowerCase().replace(/[-_.]+/g, '-');
    case 'nuget':
    case 'cargo':
    case 'composer':
    case 'rubygems':
      return trimmed.toLowerCase();
    case 'go':
      return trimmed.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
    default:
      return trimmed;
  }
}

/** Why the name cannot be checked, or null. Runs before any upstream call. */
export function packageNameError(ecosystem: string, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter a package name';
  if (trimmed.length > PACKAGE_NAME_MAX_LENGTH) return `Package names are ${PACKAGE_NAME_MAX_LENGTH} characters or fewer`;
  if (/\s/.test(trimmed)) return 'Package names cannot contain spaces';
  if (trimmed.includes('..')) return 'Package names cannot contain ".."';
  if (trimmed.startsWith('/')) return 'Package names cannot start with "/"';
  const pattern = NAME_PATTERNS[ecosystem];
  const normalized = normalizePackageName(ecosystem, trimmed);
  if (pattern && !pattern.test(normalized)) {
    return `"${trimmed}" is not a valid ${ecosystem} package name${NAME_HINTS[ecosystem] ? `. ${NAME_HINTS[ecosystem]}` : ''}`;
  }
  return null;
}

/** Newest first by the ecosystem's rules. Versions that cannot be ordered keep registry order, last. */
export function sortVersionsNewestFirst<T extends { version: string }>(ecosystem: string, rows: T[]): T[] {
  const ordered: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    if (compareVersions(ecosystem, row.version, row.version) === null) rest.push(row);
    else ordered.push(row);
  }
  ordered.sort((a, b) => -(compareVersions(ecosystem, a.version, b.version) ?? 0));
  return [...ordered, ...rest];
}

/** The version a plain install picks: npm's `latest` tag, otherwise the highest stable version. */
export function defaultVersion(ecosystem: string, list: PackageVersionList): string | undefined {
  if (list.latestTag && list.versions.some((row) => row.version === list.latestTag)) return list.latestTag;
  return list.versions.find((row) => classifyRelease(ecosystem, row.version).type === 'stable')?.version;
}

/** A requested version as the registry lists it: exact text first, then an equal version (1.2.3 and 1.2.3.0). */
export function findListedVersion(ecosystem: string, rows: ListedVersion[], wanted: string): ListedVersion | undefined {
  return (
    rows.find((row) => row.version === wanted) ??
    rows.find((row) => compareVersions(ecosystem, row.version, wanted) === 0)
  );
}

export type WindowSelection = {
  /** Rows to evaluate, newest first, without duplicates. */
  rows: ListedVersion[];
  requested: Set<string>;
  missing: string[];
  defaultVersion?: string;
};

/**
 * The newest `limit` versions from `offset`, plus every requested version and the default
 * install version. Requested and default versions are added on the first page only.
 */
export function selectWindow(
  ecosystem: string,
  list: PackageVersionList,
  requested: string[],
  offset: number,
  limit: number
): WindowSelection {
  const picked = new Set<string>(list.versions.slice(offset, offset + limit).map((row) => row.version));
  const requestedSet = new Set<string>();
  const missing: string[] = [];
  const fallback = defaultVersion(ecosystem, list);
  if (offset === 0) {
    for (const wanted of requested) {
      const row = findListedVersion(ecosystem, list.versions, wanted);
      if (!row) {
        if (!missing.includes(wanted)) missing.push(wanted);
        continue;
      }
      requestedSet.add(row.version);
      picked.add(row.version);
    }
    if (fallback) picked.add(fallback);
  }
  return {
    rows: list.versions.filter((row) => picked.has(row.version)),
    requested: requestedSet,
    missing,
    defaultVersion: fallback,
  };
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const at = Date.parse(value);
  // 1900-01-01 (NuGet) and 1980-01-02 (reproducible gem builds) mean "no real date".
  return Number.isNaN(at) || new Date(at).getUTCFullYear() < 1990 ? undefined : new Date(at).toISOString();
}

function newest(rows: ListedVersion[]): string | undefined {
  let best: number | undefined;
  for (const row of rows) {
    const at = row.publishedAt ? Date.parse(row.publishedAt) : NaN;
    if (!Number.isNaN(at) && (best === undefined || at > best)) best = at;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

function finish(ecosystem: string, rows: ListedVersion[], latestTag?: string, last?: string): PackageVersionList {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.version)) return false;
    seen.add(row.version);
    return true;
  });
  return {
    versions: sortVersionsNewestFirst(ecosystem, unique),
    latestTag,
    packageLastReleaseAt: last ?? newest(unique),
  };
}

type Lister = (
  db: DataSource,
  redis: Redis,
  route: PackageRoute,
  pkg: string,
  options: ListOptions
) => Promise<PackageVersionList | null>;

const listNpm: Lister = async (db, redis, route, pkg) => {
  const packed = await getPackument(db, redis, pkg, { key: route.repoKey }, { route });
  if (packed.status === 404) return null;
  if (packed.status !== 200) throw new Error(`Upstream returned ${packed.status}`);
  const body = packed.body;
  const timeMap = packumentTimeMap(body);
  const rows = Object.entries(body.versions ?? {}).map(([version, meta]) => {
    const versionMeta = withVersionPublishTime(meta, version, timeMap) ?? meta;
    return { version, publishedAt: iso(timeMap?.[version]), versionMeta };
  });
  const latest = body['dist-tags']?.latest;
  return finish('npm', rows, typeof latest === 'string' ? latest : undefined, latestVersionPublishTime(timeMap));
};

const listPypi: Lister = async (db, redis, route, pkg) => {
  const doc = await readUpstreamJson(db, redis, route, `pypi/${encodeURIComponent(pkg)}/json`);
  if (!doc) return null;
  const releases = (doc as { releases?: Record<string, Array<{ upload_time_iso_8601?: string; upload_time?: string }>> })
    .releases;
  const rows: ListedVersion[] = [];
  for (const [version, files] of Object.entries(releases ?? {})) {
    // A release with no files cannot be installed.
    if (!Array.isArray(files) || files.length === 0) continue;
    rows.push({ version, publishedAt: iso(files[0]?.upload_time_iso_8601 ?? files[0]?.upload_time) });
  }
  return finish('pypi', rows);
};

const listGo: Lister = async (db, redis, route, pkg, options) => {
  const doc = await readUpstreamText(db, redis, route, `${pkg}/@v/list`);
  if (!doc) return null;
  const rows: ListedVersion[] = doc.bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((version) => ({ version }));
  // Pseudo-versions (untagged commits) never appear in @v/list, but the proxy serves them.
  const listed = new Set(rows.map((row) => row.version));
  const extra = (options?.goVersions ?? []).filter((version) => version && !listed.has(version));
  const found = await Promise.all(
    extra.map(async (version) => {
      try {
        const info = await readUpstreamText(db, redis, route, `${pkg}/@v/${version}.info`);
        if (!info) return null;
        const parsed = JSON.parse(info.bodyText) as { Version?: unknown; Time?: unknown };
        if (parsed.Version !== version) return null;
        return { version, publishedAt: iso(typeof parsed.Time === 'string' ? parsed.Time : undefined) };
      } catch {
        return null;
      }
    })
  );
  for (const row of found) if (row) rows.push(row);
  return finish('go', rows);
};

const listMaven: Lister = async (db, redis, route, pkg) => {
  const idx = pkg.indexOf(':');
  const groupPath = pkg.slice(0, idx).replace(/\./g, '/');
  const artifactId = pkg.slice(idx + 1);
  const doc = await readUpstreamText(db, redis, route, `${groupPath}/${artifactId}/maven-metadata.xml`);
  if (!doc) return null;
  const rows = extractMavenMetadataVersions(doc.bodyText).map((version) => ({ version }));
  return finish('maven', rows);
};

const listNuget: Lister = async (db, redis, route, pkg) => {
  const doc = await readUpstreamJson(db, redis, route, `v3-flatcontainer/${encodeURIComponent(pkg)}/index.json`);
  if (!doc) return null;
  return finish('nuget', extractFlatContainerVersions(doc).map((version) => ({ version })));
};

const listCargo: Lister = async (db, redis, route, pkg) => {
  const doc = await readUpstreamJson(db, redis, route, `api/v1/crates/${encodeURIComponent(pkg)}`);
  if (!doc) return null;
  const versions = (doc as { versions?: unknown }).versions;
  const rows: ListedVersion[] = [];
  for (const entry of Array.isArray(versions) ? versions : []) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as { num?: unknown; yanked?: unknown; created_at?: unknown };
    if (typeof row.num !== 'string' || row.yanked === true) continue;
    rows.push({ version: row.num, publishedAt: iso(row.created_at) });
  }
  return finish('cargo', rows);
};

const listComposer: Lister = async (db, redis, route, pkg, options) => {
  const doc = await readUpstreamJson(db, redis, route, `p2/${pkg}.json`);
  if (!doc) return null;
  const records = extractComposerVersions(doc, pkg);
  const wantedBranches = (options.composerVersions ?? [])
    .map((version) => version.trim().toLowerCase())
    .filter((version) => version.startsWith('dev-'));
  if (options.composerDev || wantedBranches.length > 0) {
    const dev = await readUpstreamJson(db, redis, route, `p2/${pkg}~dev.json`).catch(() => null);
    if (dev) {
      const branches = extractComposerVersions(dev, pkg);
      const names = new Set(wantedBranches);
      records.push(...(options.composerDev ? branches : branches.filter((row) => names.has(row.version.toLowerCase()))));
    }
  }
  const rows = records
    .filter((row) => row.packageName === pkg)
    .map((row) => ({ version: row.version, publishedAt: iso(row.time) }));
  return finish('composer', rows);
};

const listRubygems: Lister = async (db, redis, route, pkg) => {
  const doc = await readUpstreamJson(db, redis, route, `api/v1/versions/${encodeURIComponent(pkg)}.json`);
  if (!doc) return null;
  // One row per version: platform builds of the same version share its decision.
  const rows = extractRubygemsVersions(doc, pkg).map((row) => ({ version: row.version, publishedAt: iso(row.time) }));
  return finish('rubygems', rows);
};

const LISTERS: Record<string, Lister> = {
  npm: listNpm,
  pypi: listPypi,
  go: listGo,
  maven: listMaven,
  nuget: listNuget,
  cargo: listCargo,
  composer: listComposer,
  rubygems: listRubygems,
};

/**
 * Every version the repository lists, from the same upstream documents and caches the proxy
 * routes read, so a check warms the install path and an install warms the check.
 * Virtual repositories try members in order, as downloads do.
 * Returns null when no member lists the package; throws when the upstream cannot be read.
 */
export async function listPackageVersions(
  db: DataSource,
  redis: Redis,
  ecosystem: string,
  repoKey: string,
  pkg: string,
  options: ListOptions = {},
  route?: PackageRoute
): Promise<PackageVersionList | null> {
  const lister = LISTERS[ecosystem];
  if (!lister) throw new Error(`Unsupported ecosystem: ${ecosystem}`);
  return lister(db, redis, route ?? (await resolvePackageTargets(db, ecosystem, repoKey || 'default', pkg)), pkg, options);
}
