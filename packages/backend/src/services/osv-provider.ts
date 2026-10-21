import Redis from 'ioredis';
import { config } from '../config.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { setexMany } from './cache-coalesce.js';
import { cvssSeverity, vulnCvss } from './cvss.js';

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Math.min(Math.max(limit, 1), items.length);
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  }
  if (items.length === 0) return;
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** v3: entries carry the advisory aliases (a GHSA advisory lists its CVE id there); v2 entries lack them. */
const CACHE_PREFIX = 'osv:vuln:v3:';
const CACHE_TTL = config.osv.cacheTtl;

/** OSV ecosystem names are not DepGate's internal ids. npm happens to match. */
const OSV_ECOSYSTEM: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  cargo: 'crates.io',
  composer: 'Packagist',
  rubygems: 'RubyGems',
};

export function toOsvEcosystem(ecosystem: string): string {
  return OSV_ECOSYSTEM[ecosystem] ?? ecosystem;
}

export type OSVVuln = {
  id: string;
  /** Other ids for the same advisory, such as the CVE id of a GHSA advisory. */
  aliases?: string[];
  summary?: string;
  severity?: { type: string; score: string }[];
  database_specific?: Record<string, unknown>;
};

export type OSVQueryResponse = {
  vulns?: OSVVuln[];
};

/** CRITICAL, HIGH, MEDIUM, LOW, NONE or UNKNOWN: the rating of the CVSS score, else the database's own label. */
export function vulnSeverity(vuln: OSVVuln): string {
  return cvssSeverity(vulnCvss(vuln));
}

export async function queryOSV(
  redis: Redis,
  ecosystem: string,
  pkg: string,
  version: string
): Promise<OSVQueryResponse> {
  const cacheKey = `${CACHE_PREFIX}${ecosystem}:${pkg}:${version}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as OSVQueryResponse;
    } catch {
      /* ignore */
    }
  }

  const url = `${config.osv.apiUrl.replace(/\/$/, '')}/v1/query`;
  const body = {
    package: { name: pkg, ecosystem: toOsvEcosystem(ecosystem) },
    version,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.osv.queryTimeoutMs),
    });
  } catch (err) {
    throw new Error(`OSV API request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (!res.ok) {
    throw new Error(`OSV API returned ${res.status}`);
  }

  const data = (await res.json()) as OSVQueryResponse;
  await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
  return data;
}

const VULN_DOC_PREFIX = 'osv:id:v1:';
const BATCH_LIMIT = 1000;

function redisUsable(redis: Redis | null): redis is Redis {
  return !!redis && typeof redis.get === 'function';
}

async function osvFetch(url: string, init?: RequestInit): Promise<Response> {
  const breaker = getCircuitBreaker('osv');
  if (!breaker.canExecute()) throw new Error('OSV circuit breaker open');
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.osv.timeoutMs) });
    if (!res.ok) throw new Error(`OSV API returned ${res.status}`);
    breaker.recordSuccess();
    return res;
  } catch (err) {
    breaker.recordFailure();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function vulnCacheKey(ecosystem: string, pkg: string, version: string): string {
  return `${CACHE_PREFIX}${ecosystem}:${pkg}:${version}`;
}

/** Entries written before the v2 prefix. Read only; a body without a vulns array is ignored. */
function legacyVulnCacheKey(ecosystem: string, pkg: string, version: string): string {
  return `osv:vuln:${ecosystem}:${pkg}:${version}`;
}

function parseVulnList(raw: string | null | undefined): OSVVuln[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OSVQueryResponse;
    return Array.isArray(parsed.vulns) ? parsed.vulns : null;
  } catch {
    return null;
  }
}

const MGET_CHUNK = 500;

/** One MGET per chunk of versions, covering the current and the legacy key. */
async function readCachedVulns(
  redis: Redis,
  ecosystem: string,
  pkg: string,
  versions: string[]
): Promise<Map<string, OSVVuln[]>> {
  const out = new Map<string, OSVVuln[]>();
  if (typeof redis.mget !== 'function') return out;
  for (let offset = 0; offset < versions.length; offset += MGET_CHUNK) {
    const slice = versions.slice(offset, offset + MGET_CHUNK);
    const keys = slice.flatMap((version) => [
      vulnCacheKey(ecosystem, pkg, version),
      legacyVulnCacheKey(ecosystem, pkg, version),
    ]);
    let raw: Array<string | null> | undefined;
    try {
      raw = await redis.mget(...keys);
    } catch {
      return out;
    }
    if (!Array.isArray(raw)) continue;
    slice.forEach((version, index) => {
      const vulns = parseVulnList(raw[index * 2]) ?? parseVulnList(raw[index * 2 + 1]);
      if (vulns) out.set(version, vulns);
    });
  }
  return out;
}

async function vulnDocument(redis: Redis | null, id: string): Promise<OSVVuln> {
  const key = `${VULN_DOC_PREFIX}${id}`;
  if (redisUsable(redis) && typeof redis.get === 'function') {
    try {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached) as OSVVuln;
    } catch {
      /* fetch */
    }
  }
  const url = `${config.osv.apiUrl.replace(/\/$/, '')}/v1/vulns/${encodeURIComponent(id)}`;
  const res = await osvFetch(url);
  const doc = (await res.json()) as OSVVuln;
  if (redisUsable(redis) && typeof redis.setex === 'function') {
    try {
      await redis.setex(key, config.osv.vulnCacheTtl, JSON.stringify(doc));
    } catch {
      /* severity is still applied for this request */
    }
  }
  return doc;
}

/**
 * One batch query for every version that is not already cached, then one
 * document fetch per distinct vulnerability id so severity is available.
 * Results are cached per version for OSV_CACHE_TTL, so a newly published
 * vulnerability is enforced within that window.
 * Throws on transport failure; callers fail open per policy.
 */
export async function queryOSVBatch(
  redis: Redis | null,
  ecosystem: string,
  pkg: string,
  versions: string[]
): Promise<Map<string, OSVVuln[]>> {
  const out = redisUsable(redis)
    ? await readCachedVulns(redis, ecosystem, pkg, versions)
    : new Map<string, OSVVuln[]>();
  const pending = versions.filter((version) => !out.has(version));
  if (pending.length === 0) return out;

  const osvEco = toOsvEcosystem(ecosystem);
  const base = config.osv.apiUrl.replace(/\/$/, '');
  for (let offset = 0; offset < pending.length; offset += BATCH_LIMIT) {
    const slice = pending.slice(offset, offset + BATCH_LIMIT);
    const res = await osvFetch(`${base}/v1/querybatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: slice.map((version) => ({
          package: { name: pkg, ecosystem: osvEco },
          version,
        })),
      }),
    });
    const data = (await res.json()) as { results?: Array<{ vulns?: OSVVuln[] }> };
    slice.forEach((version, index) => {
      out.set(version, data.results?.[index]?.vulns ?? []);
    });
  }

  const ids = new Set<string>();
  for (const version of pending) {
    for (const vuln of out.get(version) ?? []) {
      if (vuln.id && (!vuln.severity?.length || !vuln.aliases)) ids.add(vuln.id);
    }
  }
  const docs = new Map<string, OSVVuln>();
  const failed = new Set<string>();
  await mapLimit([...ids], 8, async (id) => {
    try {
      docs.set(id, await vulnDocument(redis, id));
    } catch {
      /* keep the id without severity; block-list checks still work */
      failed.add(id);
    }
  });
  const writes: Array<{ key: string; ttl: number; value: string }> = [];
  for (const version of pending) {
    const vulns = (out.get(version) ?? []).map((vuln) => {
      const full = docs.get(vuln.id);
      return full
        ? { ...vuln, aliases: full.aliases ?? vuln.aliases ?? [], severity: full.severity ?? vuln.severity, database_specific: full.database_specific }
        : vuln;
    });
    out.set(version, vulns);
    // A list missing severity would hide a threshold match for the whole TTL, so it is not cached.
    if (vulns.some((vuln) => failed.has(vuln.id))) continue;
    writes.push({ key: vulnCacheKey(ecosystem, pkg, version), ttl: CACHE_TTL, value: JSON.stringify({ vulns }) });
  }
  if (redisUsable(redis)) {
    try {
      await setexMany(redis, writes);
    } catch {
      /* results still apply to this request */
    }
  }
  return out;
}

/** Every id a policy author may have listed: the advisory's own id and its aliases (CVE ids among them). */
export function getVulnIds(vulns: OSVVuln[]): string[] {
  return (vulns ?? []).flatMap((v) => [v.id, ...(v.aliases ?? [])]);
}

/** The id people know the advisory by: its CVE id when it has one, else its own id. */
export function displayVulnId(vuln: OSVVuln): string {
  return vuln.aliases?.find((alias) => /^CVE-\d{4}-\d+$/i.test(alias)) ?? vuln.id;
}

export function hasVulnInBlockList(vulnIds: string[], blockList: string[]): boolean {
  const blockSet = new Set(blockList.map((id) => id.toUpperCase()));
  return vulnIds.some((id) => blockSet.has(id.toUpperCase()));
}
