import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import type { CachedDocument } from './metadata-cache.js';
import { queryOSVBatch, type OSVVuln } from './osv-provider.js';
import { cargoVersionMetaMap } from './cargo-proxy.js';
import { extractComposerVersions } from './composer-proxy.js';
import { extractRubygemsVersions } from './rubygems-proxy.js';
import { setexMany } from './cache-coalesce.js';
import { lookupDepsBackup, lookupDepsVersion } from './deps-dev.js';
import { config } from '../config.js';
import { isPrivateName, resolvePackageTargets, type PackageRoute } from './namespace-protection.js';
import { licenseFromClassifiers, parseLicense } from './license-expression.js';
import { readUpstreamJson, readUpstreamText } from './upstream-documents.js';
import { lookupScorecards } from './scorecard.js';
import type { ScorecardLookup } from './scorecard-rule.js';
import { lookupEpss } from './epss.js';
import { cvesOf } from './epss-rule.js';
import type { EpssValue } from './epss-feed.js';

export { readUpstreamJson, readUpstreamText };

/**
 * Keys carry the repository, because a private and a public package with the same name
 * can have different licenses and publish times. v3: licenses are read as SPDX expressions
 * (PyPI license_expression and classifiers, every Maven and Composer license). Vulnerabilities are
 * not stored here; they live in the OSV cache under OSV_CACHE_TTL.
 */
const FACTS_PREFIX = 'facts:v3:';
const UPSTREAM_CONCURRENCY = 8;

export type FactNeed = {
  license: boolean;
  publishedAt: boolean;
  cve: boolean;
  /** EPSS of the CVE ids among the vulnerabilities; read from DepGate's store with the CVE data. */
  epss?: boolean;
  scorecard?: boolean;
};

export type VersionFacts = {
  license?: string;
  publishedAt?: string;
  /** Newest release of the whole package, when the upstream document says so. */
  packageLastReleaseAt?: string;
  vulns: OSVVuln[];
  licenseKnown: boolean;
  publishedKnown: boolean;
  cveKnown: boolean;
  /** The package document could not be read, so license and publish time are guesses. */
  metaUnavailable?: boolean;
  /** OSV could not be reached, so `vulns` is empty rather than checked. */
  cveUnavailable?: boolean;
  /** Present once the Scorecard lookup finished; its status says whether a result was found. */
  scorecard?: ScorecardLookup;
  /** EPSS of this version's CVE ids that have a score. A CVE missing here has none. */
  epss?: Map<string, EpssValue>;
  /** Day the EPSS scores are from; null when never synced. */
  epssDate?: string | null;
  epssKnown?: boolean;
};

type StoredMeta = {
  license?: string;
  publishedAt?: string;
  packageLastReleaseAt?: string;
  hasLicense: boolean;
  hasPublishedAt: boolean;
};

/** Values the caller already read from a version document. A field is used only when its flag is set. */
export type SeededFacts = {
  license?: string;
  publishedAt?: string;
  licenseKnown: boolean;
  publishedKnown: boolean;
  /** npm: the version document's `repository`, so the Scorecard lookup needs no packument read. */
  repository?: string;
};

type FactPair = { license?: string; publishedAt?: string; packageLastReleaseAt?: string };

/** Fills facts for the requested versions and returns the versions the upstream document actually listed. */
type Filler = (
  db: DataSource,
  redis: Redis | null,
  pkg: string,
  versions: string[],
  route: PackageRoute,
  facts: Map<string, VersionFacts>
) => Promise<Set<string>>;

function usable(redis: Redis | null | undefined): redis is Redis {
  return !!redis && typeof redis.get === 'function' && typeof redis.setex === 'function';
}

export function factsKey(ecosystem: string, repoKey: string, pkg: string, version: string): string {
  return `${FACTS_PREFIX}${ecosystem}:${repoKey || 'default'}:${pkg}:${version}`;
}

function emptyFacts(): VersionFacts {
  return { vulns: [], licenseKnown: false, publishedKnown: false, cveKnown: false };
}

function isoOrUndefined(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  // Registries use 1900-01-01 (NuGet) and 1980-01-02 (reproducible gem builds) for "no real date".
  return Number.isNaN(at) || new Date(at).getUTCFullYear() < 1990 ? undefined : new Date(at).toISOString();
}

function latestOf(values: Iterable<string | undefined>): string | undefined {
  let best: number | undefined;
  for (const value of values) {
    if (!value) continue;
    const at = Date.parse(value);
    if (Number.isNaN(at) || new Date(at).getUTCFullYear() < 1990) continue;
    if (best === undefined || at > best) best = at;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.min(Math.max(limit, 1), items.length);
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index]);
    }
  }
  if (items.length === 0) return out;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}

/** Both fields become known: the caller read the authoritative document for this version. */
function applyPair(facts: Map<string, VersionFacts>, version: string, pair: FactPair): void {
  const current = facts.get(version) ?? emptyFacts();
  if (!current.licenseKnown) {
    current.license = pair.license;
    current.licenseKnown = true;
  }
  if (!current.publishedKnown) {
    current.publishedAt = isoOrUndefined(pair.publishedAt);
    current.publishedKnown = true;
  }
  if (pair.packageLastReleaseAt && !current.packageLastReleaseAt) {
    current.packageLastReleaseAt = pair.packageLastReleaseAt;
  }
  facts.set(version, current);
}

const fillPypi: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const doc = await readUpstreamJson(db, redis, route, `pypi/${encodeURIComponent(pkg)}/json`);
  if (!doc) return found;
  const body = doc as {
    info?: { license?: string; license_expression?: string; classifiers?: unknown };
    releases?: Record<string, Array<{ upload_time_iso_8601?: string; upload_time?: string }>>;
  };
  const license = pypiLicense(body.info);
  const releaseTime = (files: Array<{ upload_time_iso_8601?: string; upload_time?: string }> | undefined) =>
    files?.[0]?.upload_time_iso_8601 ?? files?.[0]?.upload_time;
  const last = latestOf(Object.values(body.releases ?? {}).map(releaseTime));
  for (const version of versions) {
    const files = body.releases?.[version];
    if (!files) continue;
    found.add(version);
    applyPair(facts, version, { license, publishedAt: releaseTime(files), packageLastReleaseAt: last });
  }
  return found;
};

/**
 * PEP 639 `license_expression` first, then a short `license` field (it often holds the whole
 * license text instead), then the license classifiers.
 */
export function pypiLicense(info: { license?: string; license_expression?: string; classifiers?: unknown } | undefined): string | undefined {
  const expression = info?.license_expression?.trim();
  if (expression) return expression;
  const field = info?.license?.trim();
  if (field && field.length <= 100 && !field.includes('\n') && parseLicense(field)) return field;
  return licenseFromClassifiers(info?.classifiers) ?? (field || undefined);
}

const fillCargo: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const doc = await readUpstreamJson(db, redis, route, `api/v1/crates/${encodeURIComponent(pkg)}`);
  if (!doc) return found;
  const byVersion = cargoVersionMetaMap(doc);
  const last = latestOf([...byVersion.values()].map((meta) => meta.time));
  for (const version of versions) {
    const meta = byVersion.get(version);
    if (!meta) continue;
    found.add(version);
    applyPair(facts, version, { license: meta.license, publishedAt: meta.time, packageLastReleaseAt: last });
  }
  return found;
};

const fillComposer: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const doc = await readUpstreamJson(db, redis, route, `p2/${pkg}.json`);
  if (!doc) return found;
  const rows = extractComposerVersions(doc, pkg);
  const byVersion = new Map(rows.map((row) => [row.version, row]));
  const last = latestOf(rows.map((row) => row.time));
  for (const version of versions) {
    const row = byVersion.get(version);
    if (!row) continue;
    found.add(version);
    applyPair(facts, version, { license: row.license, publishedAt: row.time, packageLastReleaseAt: last });
  }
  return found;
};

const fillRubygems: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const doc = await readUpstreamJson(db, redis, route, `api/v1/versions/${encodeURIComponent(pkg)}.json`);
  if (!doc) return found;
  const rows = extractRubygemsVersions(doc, pkg);
  const byVersion = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byVersion.has(row.version)) byVersion.set(row.version, row);
  const last = latestOf(rows.map((row) => row.time));
  for (const version of versions) {
    const row = byVersion.get(version);
    if (!row) continue;
    found.add(version);
    applyPair(facts, version, { license: row.license, publishedAt: row.time, packageLastReleaseAt: last });
  }
  return found;
};

export function mavenCoords(pkg: string): { groupPath: string; artifactId: string } | null {
  const idx = pkg.indexOf(':');
  if (idx <= 0) return null;
  const groupId = pkg.slice(0, idx);
  const artifactId = pkg.slice(idx + 1);
  if (!groupId || !artifactId) return null;
  return { groupPath: groupId.replace(/\./g, '/'), artifactId };
}

function mavenLastUpdated(xml: string): string | undefined {
  const match = xml.match(/<lastUpdated>\s*(\d{14})\s*<\/lastUpdated>/i);
  if (!match) return undefined;
  const raw = match[1];
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}.000Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

/** Maven lets the user choose among several declared licenses, so they are joined with OR. */
export function pomLicense(xml: string): string | undefined {
  const names = [...xml.matchAll(/<license>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>[\s\S]*?<\/license>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (names.length === 0) return undefined;
  return names.length === 1 ? names[0] : names.map((name) => (/\s/.test(name) ? `(${name})` : name)).join(' OR ');
}

/**
 * Each version's publish time is its POM's Last-Modified header. The metadata file's
 * lastUpdated is the package's newest release, so it only feeds the unmaintained check.
 */
const fillMaven: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const coords = mavenCoords(pkg);
  if (!coords) return found;
  let last: string | undefined;
  try {
    const metadata = await readUpstreamText(db, redis, route, `${coords.groupPath}/${coords.artifactId}/maven-metadata.xml`);
    last = metadata ? mavenLastUpdated(metadata.bodyText) : undefined;
  } catch {
    last = undefined;
  }
  await mapLimit(versions, UPSTREAM_CONCURRENCY, async (version) => {
    let pom: CachedDocument | null;
    try {
      pom = await readUpstreamText(
        db,
        redis,
        route,
        `${coords.groupPath}/${coords.artifactId}/${version}/${coords.artifactId}-${version}.pom`
      );
    } catch {
      return;
    }
    if (!pom) return;
    found.add(version);
    applyPair(facts, version, {
      license: pomLicense(pom.bodyText),
      publishedAt: pom.lastModified,
      packageLastReleaseAt: last,
    });
  });
  return found;
};

const fillGo: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  await mapLimit(versions, UPSTREAM_CONCURRENCY, async (version) => {
    let info: CachedDocument | null;
    try {
      info = await readUpstreamText(db, redis, route, `${pkg}/@v/${version}.info`);
    } catch {
      return;
    }
    if (!info) return;
    let time: string | undefined;
    try {
      time = (JSON.parse(info.bodyText) as { Time?: string }).Time;
    } catch {
      return;
    }
    found.add(version);
    // The module proxy has no license. A public-registry backup may fill it afterwards.
    applyPair(facts, version, { publishedAt: time });
  });
  return found;
};

type NugetEntry = { license?: string; publishedAt?: string; projectUrl?: string };

function walkNuget(
  doc: unknown,
  into: Map<string, NugetEntry>,
  pages: string[]
): void {
  if (!doc || typeof doc !== 'object') return;
  const items = (doc as { items?: unknown }).items;
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      walkNuget({ items: obj.items }, into, pages);
      continue;
    }
    const entry = obj.catalogEntry;
    if (entry && typeof entry === 'object') {
      const version = (entry as { version?: unknown }).version;
      if (typeof version === 'string') {
        const published = (entry as { published?: unknown }).published;
        const license = (entry as { licenseExpression?: unknown }).licenseExpression;
        const projectUrl = (entry as { projectUrl?: unknown }).projectUrl;
        into.set(version.toLowerCase(), {
          license: typeof license === 'string' ? license : undefined,
          publishedAt: typeof published === 'string' ? published : undefined,
          projectUrl: typeof projectUrl === 'string' && projectUrl ? projectUrl : undefined,
        });
        continue;
      }
    }
    const id = obj['@id'];
    if (typeof id === 'string') pages.push(id);
  }
}

/** Registration catalog entries by lowercased version, or null when the package is not there. */
export async function readNugetEntries(
  db: DataSource,
  redis: Redis | null,
  route: PackageRoute,
  pkg: string
): Promise<Map<string, NugetEntry> | null> {
  const id = pkg.toLowerCase();
  const index = await readUpstreamJson(db, redis, route, `v3/registration5-gz-semver2/${id}/index.json`);
  if (!index) return null;
  const rows = new Map<string, NugetEntry>();
  const pages: string[] = [];
  walkNuget(index, rows, pages);
  if (pages.length > 0 && rows.size === 0) {
    await mapLimit(pages, UPSTREAM_CONCURRENCY, async (pageUrl) => {
      let path = pageUrl;
      try {
        path = new URL(pageUrl).pathname.replace(/^\/+/, '');
      } catch {
        /* already a relative path */
      }
      const page = await readUpstreamJson(db, redis, route, path);
      if (page) walkNuget(page, rows, []);
    });
  }
  return rows;
}

const fillNuget: Filler = async (db, redis, pkg, versions, route, facts) => {
  const found = new Set<string>();
  const rows = await readNugetEntries(db, redis, route, pkg);
  if (!rows) return found;
  const last = latestOf([...rows.values()].map((row) => row.publishedAt));
  for (const version of versions) {
    const row = rows.get(version.toLowerCase());
    if (!row) continue;
    found.add(version);
    applyPair(facts, version, { license: row.license, publishedAt: row.publishedAt, packageLastReleaseAt: last });
  }
  return found;
};

/** npm has no filler: callers always pass the version document they already hold. */
const FILLERS: Record<string, Filler> = {
  pypi: fillPypi,
  cargo: fillCargo,
  composer: fillComposer,
  rubygems: fillRubygems,
  maven: fillMaven,
  go: fillGo,
  nuget: fillNuget,
};

async function mergeStored(
  redis: Redis,
  ecosystem: string,
  repoKey: string,
  pkg: string,
  versions: string[],
  facts: Map<string, VersionFacts>
): Promise<void> {
  if (versions.length === 0 || typeof redis.mget !== 'function') return;
  let raw: Array<string | null> = [];
  try {
    raw = (await redis.mget(...versions.map((version) => factsKey(ecosystem, repoKey, pkg, version)))) ?? [];
  } catch {
    return;
  }
  versions.forEach((version, index) => {
    const text = raw[index];
    if (!text) return;
    let stored: StoredMeta;
    try {
      stored = JSON.parse(text) as StoredMeta;
    } catch {
      return;
    }
    const current = facts.get(version) ?? emptyFacts();
    if (stored.hasLicense && !current.licenseKnown) {
      current.license = stored.license;
      current.licenseKnown = true;
    }
    if (stored.hasPublishedAt && !current.publishedKnown) {
      current.publishedAt = isoOrUndefined(stored.publishedAt);
      current.publishedKnown = true;
    }
    if (stored.packageLastReleaseAt && !current.packageLastReleaseAt) {
      current.packageLastReleaseAt = stored.packageLastReleaseAt;
    }
    facts.set(version, current);
  });
}

async function writeStored(
  redis: Redis,
  ecosystem: string,
  repoKey: string,
  pkg: string,
  facts: Map<string, VersionFacts>,
  versions: string[]
): Promise<void> {
  const entries: Array<{ key: string; ttl: number; value: string }> = [];
  for (const version of versions) {
    const fact = facts.get(version);
    if (!fact || (!fact.licenseKnown && !fact.publishedKnown)) continue;
    const stored: StoredMeta = {
      license: fact.license,
      publishedAt: fact.publishedAt,
      packageLastReleaseAt: fact.packageLastReleaseAt,
      hasLicense: fact.licenseKnown,
      hasPublishedAt: fact.publishedKnown,
    };
    entries.push({ key: factsKey(ecosystem, repoKey, pkg, version), ttl: config.gateway.factsCacheTtl, value: JSON.stringify(stored) });
  }
  try {
    await setexMany(redis, entries);
  } catch {
    /* facts remain in memory for this request */
  }
}

/**
 * Fills a publish time or SPDX license the registry left empty.
 * A present registry value is kept. Composer and private repositories are skipped.
 * Versions that gained a concrete value are returned so they can be cached.
 */
async function fillFromDepsDev(
  db: DataSource,
  redis: Redis | null,
  ecosystem: string,
  pkg: string,
  versions: string[],
  need: FactNeed,
  repoKey: string,
  facts: Map<string, VersionFacts>
): Promise<Set<string>> {
  const filled = new Set<string>();
  const licenseVersions = need.license ? versions.filter((version) => !facts.get(version)?.license) : [];
  const wantDates =
    need.publishedAt &&
    versions.some((version) => {
      const fact = facts.get(version);
      if (!fact?.publishedAt) return true;
      return ecosystem === 'go' && !fact.packageLastReleaseAt;
    });
  if (!wantDates && licenseVersions.length === 0) return filled;

  let backup;
  try {
    backup = await lookupDepsBackup(db, redis, ecosystem, repoKey, pkg, {
      dates: Boolean(wantDates),
      licenseVersions,
    });
  } catch {
    return filled;
  }
  if (!backup) return filled;

  if (backup.packageLastReleaseAt) {
    for (const version of versions) {
      const fact = facts.get(version);
      if (fact && !fact.packageLastReleaseAt) fact.packageLastReleaseAt = backup.packageLastReleaseAt;
    }
  }
  for (const version of versions) {
    const fact = facts.get(version);
    if (!fact) continue;
    const published = lookupDepsVersion(backup.publishedAt, version);
    if (published && !fact.publishedAt) {
      fact.publishedAt = published;
      fact.publishedKnown = true;
      filled.add(version);
    }
    const license = lookupDepsVersion(backup.licenses, version);
    if (license && !fact.license) {
      fact.license = license;
      fact.licenseKnown = true;
      filled.add(version);
    }
  }
  return filled;
}

/**
 * Seeds come first and are never written to Redis: the caller can read them again for free.
 * Then cached facts, then the upstream package document. Only versions the document
 * actually listed are cached, so a version published after the document was fetched
 * is not remembered as having no publish time.
 * Anything still unknown is treated as absent for this request only.
 */
export async function loadVersionFacts(
  db: DataSource,
  redis: Redis | null | undefined,
  ecosystem: string,
  pkg: string,
  versions: string[],
  need: FactNeed,
  repoKey: string,
  seeded?: Map<string, SeededFacts>,
  route?: PackageRoute
): Promise<Map<string, VersionFacts>> {
  const facts = new Map<string, VersionFacts>();
  const resolved = route ?? (await resolvePackageTargets(db, ecosystem, repoKey, pkg));
  // Facts of a reserved name come from its internal remotes, so they are cached apart from a public copy.
  const scope = resolved.cacheScope;
  const privateName = isPrivateName(resolved);
  for (const version of versions) {
    const fact = emptyFacts();
    const seed = seeded?.get(version);
    if (seed?.licenseKnown) {
      fact.license = seed.license;
      fact.licenseKnown = true;
    }
    if (seed?.publishedKnown) {
      fact.publishedAt = seed.publishedAt;
      fact.publishedKnown = true;
    }
    facts.set(version, fact);
  }

  const lacksMeta = (version: string): boolean => {
    const fact = facts.get(version) ?? emptyFacts();
    return (need.license && !fact.licenseKnown) || (need.publishedAt && !fact.publishedKnown);
  };

  let missing = versions.filter(lacksMeta);
  if (missing.length > 0 && usable(redis)) {
    await mergeStored(redis, ecosystem, scope, pkg, missing, facts);
    missing = versions.filter(lacksMeta);
  }

  const persist: string[] = [];
  if (missing.length > 0) {
    const filler = FILLERS[ecosystem];
    if (filler) {
      try {
        const found = await filler(db, redis ?? null, pkg, missing, resolved, facts);
        for (const version of missing) if (found.has(version)) persist.push(version);
      } catch {
        /* upstream failure: decide this request without the fact and do not cache the gap */
        for (const version of missing) {
          const fact = facts.get(version) ?? emptyFacts();
          fact.metaUnavailable = true;
          facts.set(version, fact);
        }
      }
    }
  }

  // deps.dev would learn the internal name, and it does not index internal packages anyway.
  const backed = privateName
    ? new Set<string>()
    : await fillFromDepsDev(db, redis ?? null, ecosystem, pkg, versions, need, repoKey, facts);
  for (const version of backed) {
    if (!persist.includes(version)) persist.push(version);
  }

  if (missing.length > 0) {
    for (const version of missing) {
      const fact = facts.get(version) ?? emptyFacts();
      if (need.license) fact.licenseKnown = true;
      if (need.publishedAt) fact.publishedKnown = true;
      facts.set(version, fact);
    }
  }

  if (need.cve) {
    const missingCve = versions.filter((version) => !facts.get(version)?.cveKnown);
    if (missingCve.length > 0) {
      let vulns: Map<string, OSVVuln[]> | null;
      if (privateName) {
        // Known, none: OSV has no internal packages, and asking would leak the name.
        vulns = new Map();
      } else {
        try {
          vulns = await queryOSVBatch(redis ?? null, ecosystem, pkg, missingCve);
        } catch {
          vulns = null;
        }
      }
      for (const version of missingCve) {
        const fact = facts.get(version) ?? emptyFacts();
        fact.vulns = vulns?.get(version) ?? [];
        fact.cveKnown = true;
        if (!vulns) fact.cveUnavailable = true;
        facts.set(version, fact);
      }
    }
  }

  if (need.epss) {
    const missingEpss = versions.filter((version) => facts.get(version)?.cveKnown && !facts.get(version)?.epssKnown);
    if (missingEpss.length > 0) {
      // One query for every CVE of every version in this round; DepGate's own table, never FIRST.
      const all = cvesOf(missingEpss.flatMap((version) => facts.get(version)?.vulns ?? []));
      const { scores, scoreDate } = await lookupEpss(db, all);
      for (const version of missingEpss) {
        const fact = facts.get(version)!;
        const own = new Map<string, EpssValue>();
        for (const cve of cvesOf(fact.vulns)) {
          const value = scores.get(cve);
          if (value) own.set(cve, value);
        }
        fact.epss = own;
        fact.epssDate = scoreDate;
        fact.epssKnown = true;
      }
    }
  }

  if (need.scorecard) {
    const missingScorecard = versions.filter((version) => !facts.get(version)?.scorecard);
    if (missingScorecard.length > 0) {
      const repositories = new Map<string, string | undefined>();
      for (const version of missingScorecard) {
        const seed = seeded?.get(version);
        if (seed && 'repository' in seed) repositories.set(version, seed.repository);
      }
      let lookups: Map<string, ScorecardLookup>;
      try {
        lookups = await lookupScorecards(db, redis ?? null, resolved, pkg, missingScorecard, repositories);
      } catch {
        lookups = new Map(missingScorecard.map((version) => [version, { status: 'unavailable' } as ScorecardLookup]));
      }
      for (const version of missingScorecard) {
        const fact = facts.get(version) ?? emptyFacts();
        fact.scorecard = lookups.get(version) ?? { status: 'unavailable' };
        facts.set(version, fact);
      }
    }
  }

  if (persist.length > 0 && usable(redis)) {
    await writeStored(redis, ecosystem, scope, pkg, facts, persist);
  }
  return facts;
}
