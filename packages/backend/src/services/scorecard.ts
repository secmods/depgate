import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { config } from '../config.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { singleFlight } from './cache-coalesce.js';
import { lookupDepsProject, lookupDepsSourceRepo, targetsArePublic } from './deps-dev.js';
import { isPrivateName, type PackageRoute } from './namespace-protection.js';
import { readUpstreamJson, readUpstreamText } from './upstream-documents.js';
import { getPackument } from './npm-packument.js';
import { ByteLru } from './memory-lru.js';
import {
  looksLikeRepository,
  normaliseRepoUrl,
  parseDepsDevProject,
  parseScorecardApi,
  type ScorecardLookup,
  type ScorecardResult,
} from './scorecard-rule.js';

/**
 * OpenSSF Scorecard lookups (requirements_scorecard.md §5): the source repository from the
 * registry the repository proxies (deps.dev as backup), then the score from the Scorecard API
 * (deps.dev as backup while it fails). Only for public repositories and names outside reserved
 * or monitored namespaces; nothing about other packages leaves the gateway.
 */

const MAP_PREFIX = 'scorecard:v1:map:';
const PROJECT_PREFIX = 'scorecard:v1:proj:';
const CONCURRENCY = 8;

type Mapping = { project: string; via: 'registry' | 'deps.dev'; provenance?: string };
type CachedMapping = Mapping | { miss: true; reason: 'no-repository' | 'unsupported-host' };
type ProjectScore = { date: string; overall: number; checks: Record<string, number>; scoreVia: 'scorecard' | 'deps.dev' };
type CachedProject = ProjectScore | { miss: true };

/** Candidate repository values per version, in preference order. Throws when the registry could not be read. */
type CandidateReader = (
  db: DataSource,
  redis: Redis | null,
  route: PackageRoute,
  pkg: string,
  versions: string[]
) => Promise<Map<string, unknown[]>>;

function usable(redis: Redis | null | undefined): redis is Redis {
  return !!redis && typeof redis.get === 'function' && typeof redis.setex === 'function';
}

/**
 * Per-process copy of recent Redis entries, so a packument with hundreds of versions does not
 * cost a Redis round trip per version on every request. Short-lived: Redis stays the source.
 */
const MEMORY_TTL_MS = 60_000;
const memory = new ByteLru<{ value: unknown; until: number }>(8 * 1024 * 1024);

function fromMemory<T>(key: string): T | undefined {
  const hit = memory.get(key);
  if (!hit) return undefined;
  if (hit.until <= Date.now()) {
    memory.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function remember(key: string, value: unknown, ttlSeconds: number): void {
  memory.set(key, { value, until: Date.now() + Math.min(MEMORY_TTL_MS, ttlSeconds * 1000) }, key.length + 256);
}

/** For tests: forget the per-process copies. */
export function clearScorecardMemory(): void {
  memory.clear();
}

async function readCache<T>(redis: Redis | null, key: string): Promise<T | undefined> {
  const held = fromMemory<T>(key);
  if (held !== undefined) return held;
  if (!usable(redis)) return undefined;
  try {
    const raw = await redis.get(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as T;
    remember(key, value, MEMORY_TTL_MS / 1000);
    return value;
  } catch {
    return undefined;
  }
}

/** Many keys in one round trip; missing or unreadable entries are undefined. */
async function readMany<T>(redis: Redis | null, keys: string[]): Promise<Array<T | undefined>> {
  const out: Array<T | undefined> = keys.map((key) => fromMemory<T>(key));
  const missing = keys.map((key, index) => (out[index] === undefined ? index : -1)).filter((index) => index >= 0);
  if (missing.length === 0 || !usable(redis) || typeof redis.mget !== 'function') return out;
  try {
    const raw = await redis.mget(...missing.map((index) => keys[index]));
    missing.forEach((index, i) => {
      const text = raw?.[i];
      if (!text) return;
      try {
        out[index] = JSON.parse(text) as T;
        remember(keys[index], out[index], MEMORY_TTL_MS / 1000);
      } catch {
        /* refetched */
      }
    });
  } catch {
    /* treated as misses */
  }
  return out;
}

async function writeCache(redis: Redis | null, key: string, ttl: number, value: unknown): Promise<void> {
  if (ttl <= 0) return;
  remember(key, value, ttl);
  if (!usable(redis)) return;
  try {
    await redis.setex(key, ttl, JSON.stringify(value));
  } catch {
    /* used for this request only */
  }
}

async function mapLimit<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/** Whether the rule may run for this route, or why not (§5.1). */
export function scorecardApplicability(route: PackageRoute): ScorecardLookup | null {
  if (!config.scorecard.enabled) return { status: 'disabled' };
  if (isPrivateName(route)) return { status: 'not-applicable', reason: 'private-name' };
  if (!targetsArePublic(route.ecosystem, route.targets)) return { status: 'not-applicable', reason: 'internal-remote' };
  return null;
}

function npmRepository(meta: unknown): unknown {
  const repo = meta && typeof meta === 'object' ? (meta as { repository?: unknown }).repository : undefined;
  if (repo && typeof repo === 'object') return (repo as { url?: unknown }).url;
  return repo;
}

/** The npm version document's `repository`, as a seed for the lookup. Undefined when the document has none. */
export function npmRepositorySeed(meta: unknown): string | undefined {
  const value = npmRepository(meta);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

const PYPI_SOURCE_KEYS = ['source', 'source code', 'repository', 'code', 'github', 'gitlab', 'homepage'];

/** PyPI `project_urls` (source-like keys first, then any other value) and `home_page`. */
export function pypiRepositoryCandidates(info: unknown): unknown[] {
  if (!info || typeof info !== 'object') return [];
  const doc = info as { project_urls?: unknown; home_page?: unknown };
  const out: unknown[] = [];
  if (doc.project_urls && typeof doc.project_urls === 'object') {
    const entries = Object.entries(doc.project_urls as Record<string, unknown>);
    for (const key of PYPI_SOURCE_KEYS) {
      for (const [label, value] of entries) if (label.trim().toLowerCase() === key) out.push(value);
    }
    for (const [, value] of entries) if (!out.includes(value)) out.push(value);
  }
  out.push(doc.home_page);
  return out;
}

/**
 * Composer 2 metadata is minified: each version lists only what changed since the previous one,
 * and `__unset` removes a field. Returns `source.url` per version as Composer would expand it.
 */
export function composerSourceUrls(doc: unknown, pkg: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  const packages = doc && typeof doc === 'object' ? (doc as { packages?: unknown }).packages : undefined;
  if (!packages || typeof packages !== 'object') return out;
  const entries = Object.entries(packages as Record<string, unknown>).find(([name]) => name.toLowerCase() === pkg.toLowerCase())?.[1];
  if (!Array.isArray(entries)) return out;
  let source: unknown;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if ('source' in row) source = row.source === '__unset' ? undefined : row.source;
    const raw = source && typeof source === 'object' ? (source as { url?: unknown }).url : undefined;
    const url = typeof raw === 'string' ? raw : undefined;
    // The engine names a version as composer-proxy does: version_normalized without the fourth ".0".
    const keys = new Set<string>();
    if (typeof row.version === 'string') keys.add(row.version).add(row.version.replace(/^v/, ''));
    if (typeof row.version_normalized === 'string') keys.add(row.version_normalized.replace(/^(\d+\.\d+\.\d+)\.0(?=$|-)/, '$1'));
    for (const key of keys) out.set(key, url);
  }
  return out;
}

/** POM `<scm><url>`, `<scm><connection>`, then the project's own `<url>`. Parent POMs are not read. */
export function pomRepositoryCandidates(xml: string): unknown[] {
  const out: unknown[] = [];
  const scm = xml.match(/<scm>([\s\S]*?)<\/scm>/i)?.[1];
  if (scm) {
    out.push(scm.match(/<url>\s*([^<]+?)\s*<\/url>/i)?.[1]);
    out.push(scm.match(/<connection>\s*([^<]+?)\s*<\/connection>/i)?.[1]);
    out.push(scm.match(/<developerConnection>\s*([^<]+?)\s*<\/developerConnection>/i)?.[1]);
  }
  const project = xml.replace(
    /<(scm|parent|licenses|organization|developers|contributors|issueManagement|ciManagement|mailingLists|distributionManagement|repositories|pluginRepositories|build|reporting|dependencies|dependencyManagement|profiles)>[\s\S]*?<\/\1>/gi,
    ''
  );
  out.push(project.match(/<url>\s*([^<]+?)\s*<\/url>/i)?.[1]);
  return out.filter((value) => typeof value === 'string');
}

/** A Go module path on GitHub or GitLab is its repository; `!x` is the proxy's encoding of `X`. */
export function goRepositoryCandidate(modulePath: string): string | undefined {
  const decoded = modulePath.replace(/!([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const parts = decoded.split('/');
  if (parts.length < 3 || !['github.com', 'gitlab.com'].includes(parts[0].toLowerCase())) return undefined;
  return parts.slice(0, 3).join('/');
}

function same(versions: string[], values: unknown[]): Map<string, unknown[]> {
  return new Map(versions.map((version) => [version, values]));
}

const READERS: Record<string, CandidateReader> = {
  npm: async (db, redis, route, pkg, versions) => {
    if (!usable(redis)) return new Map();
    const packed = await getPackument(db, redis, pkg, { key: route.repoKey }, { route });
    if (packed.status === 404) return new Map();
    if (packed.status !== 200) throw new Error(`Upstream returned ${packed.status} for ${pkg}`);
    return new Map(versions.map((version) => [version, [npmRepository(packed.body.versions?.[version])]]));
  },
  pypi: async (db, redis, route, pkg, versions) => {
    const doc = await readUpstreamJson(db, redis, route, `pypi/${encodeURIComponent(pkg)}/json`);
    return same(versions, pypiRepositoryCandidates((doc as { info?: unknown } | null)?.info));
  },
  cargo: async (db, redis, route, pkg, versions) => {
    const doc = await readUpstreamJson(db, redis, route, `api/v1/crates/${encodeURIComponent(pkg)}`);
    const crate = (doc as { crate?: { repository?: unknown } } | null)?.crate;
    return same(versions, [crate?.repository]);
  },
  composer: async (db, redis, route, pkg, versions) => {
    const doc = await readUpstreamJson(db, redis, route, `p2/${pkg}.json`);
    const urls = composerSourceUrls(doc, pkg);
    return new Map(versions.map((version) => [version, [urls.get(version)]]));
  },
  rubygems: async (db, redis, route, pkg, versions) => {
    const doc = await readUpstreamJson(db, redis, route, `api/v1/versions/${encodeURIComponent(pkg)}.json`);
    const rows = Array.isArray(doc) ? (doc as Array<{ number?: unknown; metadata?: Record<string, unknown> }>) : [];
    return new Map(
      versions.map((version) => {
        const meta = rows.find((row) => row.number === version)?.metadata ?? {};
        return [version, [meta.source_code_uri, meta.homepage_uri]];
      })
    );
  },
  nuget: async (db, redis, route, pkg, versions) => {
    const { readNugetEntries } = await import('./package-facts.js');
    const rows = await readNugetEntries(db, redis, route, pkg);
    return new Map(versions.map((version) => [version, [rows?.get(version.toLowerCase())?.projectUrl]]));
  },
  maven: async (db, redis, route, pkg, versions) => {
    const { mavenCoords } = await import('./package-facts.js');
    const coords = mavenCoords(pkg);
    const out = new Map<string, unknown[]>();
    if (!coords) return out;
    let failed = false;
    await mapLimit(versions, async (version) => {
      try {
        const pom = await readUpstreamText(db, redis, route, `${coords.groupPath}/${coords.artifactId}/${version}/${coords.artifactId}-${version}.pom`);
        out.set(version, pom ? pomRepositoryCandidates(pom.bodyText) : []);
      } catch {
        failed = true;
      }
    });
    if (failed && out.size === 0) throw new Error(`POMs for ${pkg} could not be read`);
    return out;
  },
  go: async (_db, _redis, _route, pkg, versions) => same(versions, [goRepositoryCandidate(pkg)]),
};

type MapOutcome = Mapping | { unknown: 'no-repository' | 'unsupported-host' } | 'unavailable';

function firstRepository(candidates: unknown[], npmShorthand: boolean): { project?: string; seen: boolean } {
  let seen = false;
  for (const value of candidates) {
    const project = normaliseRepoUrl(value, { npmShorthand });
    if (project) return { project, seen: true };
    if (looksLikeRepository(value)) seen = true;
  }
  return { seen };
}

/** Step 1 for the versions without a cached mapping. */
async function mapVersions(
  db: DataSource,
  redis: Redis | null,
  route: PackageRoute,
  pkg: string,
  versions: string[],
  seeds: Map<string, string | undefined>
): Promise<Map<string, MapOutcome>> {
  const ecosystem = route.ecosystem;
  const out = new Map<string, MapOutcome>();
  const candidates = new Map<string, unknown[]>();
  for (const version of versions) if (seeds.has(version)) candidates.set(version, [seeds.get(version)]);
  const unseeded = versions.filter((version) => !candidates.has(version));
  let registryFailed = false;
  if (unseeded.length > 0) {
    const reader = READERS[ecosystem];
    try {
      const read = reader ? await reader(db, redis, route, pkg, unseeded) : new Map<string, unknown[]>();
      for (const [version, values] of read) candidates.set(version, values);
    } catch {
      registryFailed = true;
    }
  }

  await mapLimit(versions, async (version) => {
    const found = firstRepository(candidates.get(version) ?? [], ecosystem === 'npm');
    if (found.project) {
      out.set(version, { project: found.project, via: 'registry' });
      return;
    }
    const backup = await lookupDepsSourceRepo(redis, ecosystem, pkg, version);
    if (backup) {
      const project = normaliseRepoUrl(backup.project);
      out.set(version, project ? { project, via: 'deps.dev', provenance: backup.provenance } : { unknown: 'unsupported-host' });
      return;
    }
    const failedHere = registryFailed && !candidates.has(version);
    if (failedHere && backup === undefined) {
      out.set(version, 'unavailable');
      return;
    }
    out.set(version, { unknown: found.seen ? 'unsupported-host' : 'no-repository' });
  });
  return out;
}

function projectKey(project: string): string {
  return project.toLowerCase();
}

/** The Scorecard API, 404 as null, a failure as undefined. */
async function fetchScorecardApi(project: string): Promise<unknown | null | undefined> {
  const breaker = getCircuitBreaker('scorecard');
  if (!breaker.canExecute()) return undefined;
  const base = config.scorecard.apiUrl.replace(/\/$/, '');
  const path = project.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await fetch(`${base}/projects/${path}`, {
      headers: { accept: 'application/json', 'user-agent': 'depgate' },
      signal: AbortSignal.timeout(config.scorecard.timeoutMs),
    });
    if (res.status === 404) {
      breaker.recordSuccess();
      return null;
    }
    if (!res.ok) {
      breaker.recordFailure();
      return undefined;
    }
    breaker.recordSuccess();
    return await res.json();
  } catch {
    breaker.recordFailure();
    return undefined;
  }
}

/**
 * Step 2 for one repository: the cached result, the Scorecard API, then deps.dev whenever the API
 * has no usable score (404, a body without a score, or a failure).
 */
async function projectScore(redis: Redis | null, project: string): Promise<ProjectScore | null | 'unavailable'> {
  const key = `${PROJECT_PREFIX}${projectKey(project)}`;
  const cached = await readCache<CachedProject>(redis, key);
  if (cached) return 'miss' in cached ? null : cached;
  return singleFlight(key, async () => {
    const body = await fetchScorecardApi(project);
    const parsed = body ? parseScorecardApi(body) : null;
    if (parsed) {
      const score: ProjectScore = { ...parsed, scoreVia: 'scorecard' };
      await writeCache(redis, key, config.scorecard.cacheTtl, score);
      return score;
    }
    const apiFailed = body === undefined;
    const backup = await lookupDepsProject(project);
    if (backup === undefined) {
      if (apiFailed) return 'unavailable';
      // The API has no result and deps.dev could not be asked: remember the miss only when deps.dev is off.
      if (!config.depsDev.enabled) await writeCache(redis, key, config.scorecard.negativeTtl, { miss: true });
      return null;
    }
    const fromDeps = backup ? parseDepsDevProject(backup) : null;
    if (!fromDeps) {
      await writeCache(redis, key, config.scorecard.negativeTtl, { miss: true });
      return null;
    }
    // While the API fails its own result may come back soon, so the deps.dev copy is kept briefly.
    // When the API has no result at all, deps.dev is the only source until the next weekly scan.
    const score: ProjectScore = { ...fromDeps, scoreVia: 'deps.dev' };
    await writeCache(redis, key, apiFailed ? config.scorecard.negativeTtl : config.scorecard.cacheTtl, score);
    return score;
  });
}

/** How Package check and the lookup endpoint show a lookup. Checks keep the Scorecard order of SCORECARD_CHECKS where known. */
export type ScorecardView = {
  status: ScorecardLookup['status'];
  reason?: string;
  project?: string;
  via?: 'registry' | 'deps.dev';
  provenance?: string;
  scoreVia?: 'scorecard' | 'deps.dev';
  date?: string;
  overall?: number;
  checks?: Array<{ name: string; score: number }>;
};

export function scorecardView(lookup: ScorecardLookup): ScorecardView {
  switch (lookup.status) {
    case 'found': {
      const { result } = lookup;
      return {
        status: 'found',
        project: result.project,
        via: result.via,
        provenance: result.provenance,
        scoreVia: result.scoreVia,
        date: result.date,
        overall: result.overall,
        checks: Object.entries(result.checks)
          .map(([name, score]) => ({ name, score }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    }
    case 'unknown':
      return { status: 'unknown', reason: lookup.reason, project: lookup.project };
    case 'not-applicable':
      return { status: 'not-applicable', reason: lookup.reason };
    default:
      return { status: lookup.status };
  }
}

/**
 * One lookup per version. `seeds` holds repository values the caller already read (npm's version
 * document); a version present there is not read from the registry again.
 */
export async function lookupScorecards(
  db: DataSource,
  redis: Redis | null,
  route: PackageRoute,
  pkg: string,
  versions: string[],
  seeds: Map<string, string | undefined> = new Map()
): Promise<Map<string, ScorecardLookup>> {
  const out = new Map<string, ScorecardLookup>();
  if (versions.length === 0) return out;
  const skip = scorecardApplicability(route);
  if (skip) {
    for (const version of versions) out.set(version, skip);
    return out;
  }

  const ecosystem = route.ecosystem;
  const mappings = new Map<string, MapOutcome>();
  const unmapped: string[] = [];
  const cachedMappings = await readMany<CachedMapping>(redis, versions.map((version) => `${MAP_PREFIX}${ecosystem}:${pkg}:${version}`));
  versions.forEach((version, index) => {
    const cached = cachedMappings[index];
    if (!cached) unmapped.push(version);
    else mappings.set(version, 'miss' in cached ? { unknown: cached.reason } : cached);
  });
  if (unmapped.length > 0) {
    const fresh = await mapVersions(db, redis, route, pkg, unmapped, seeds);
    for (const [version, outcome] of fresh) {
      mappings.set(version, outcome);
      if (outcome === 'unavailable') continue;
      const key = `${MAP_PREFIX}${ecosystem}:${pkg}:${version}`;
      if ('unknown' in outcome) await writeCache(redis, key, config.scorecard.negativeTtl, { miss: true, reason: outcome.unknown });
      else await writeCache(redis, key, config.scorecard.cacheTtl, outcome);
    }
  }

  const projects = [...new Set([...mappings.values()].flatMap((outcome) => (typeof outcome === 'object' && 'project' in outcome ? [outcome.project] : [])))];
  const scores = new Map<string, ProjectScore | null | 'unavailable'>();
  await mapLimit(projects, async (project) => {
    scores.set(project, await projectScore(redis, project));
  });

  for (const version of versions) {
    const mapping = mappings.get(version);
    if (!mapping || mapping === 'unavailable') {
      out.set(version, { status: 'unavailable' });
      continue;
    }
    if ('unknown' in mapping) {
      out.set(version, { status: 'unknown', reason: mapping.unknown });
      continue;
    }
    const score = scores.get(mapping.project);
    if (score === 'unavailable' || score === undefined) {
      out.set(version, { status: 'unavailable' });
      continue;
    }
    if (!score) {
      out.set(version, { status: 'unknown', reason: 'not-scanned', project: mapping.project });
      continue;
    }
    const result: ScorecardResult = {
      project: mapping.project,
      via: mapping.via,
      provenance: mapping.provenance,
      scoreVia: score.scoreVia,
      date: score.date,
      overall: score.overall,
      checks: score.checks,
    };
    out.set(version, { status: 'found', result });
  }
  return out;
}
