import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import Redis from 'ioredis';
import semver from 'semver';
import { DataSource } from 'typeorm';
import { fetchFromUpstream } from './upstream-provider.js';
import { config } from '../config.js';
import { resolvePackageTargets, type PackageRoute } from './namespace-protection.js';
import type { RemoteTarget } from './repository-resolve.js';
import { repoPathPrefix, type RepoUrlContext } from './repo-keys.js';
import {
  acquireLock,
  errorMarkerFor,
  readErrorMarker,
  rememberedError,
  singleFlight,
  waitForFill,
  writeErrorMarker,
  type CachedError,
} from './cache-coalesce.js';
import { ByteLru } from './memory-lru.js';
import { blockedVersionMessage, type VersionBlockNotice } from './policy-notice.js';

export { blockedVersionMessage, type VersionBlockNotice };

const gzipAsync = promisify(gzip);

/** Read-only: string entries written before the hash layout. Served once, then replaced. */
const LEGACY_PREFIX = 'npm:packument:';
/** Hash per variant: m = {freshUntil, etag}, j = JSON, g = gzip bytes. */
const STORE_PREFIX = 'npm:pk:v3:';
/** Hash per package: one small row per version for the tarball route, plus INDEX_META_FIELD. v2 reads the legacy licenses array. */
const INDEX_PREFIX = 'npm:pkver:v2:';
const NEGATIVE_PREFIX = 'npm:404:';
const ERROR_PREFIX = 'npm:err:';
/** Not a valid npm version, so it cannot collide with one. */
const INDEX_META_FIELD = ':meta';

const ABBREVIATED_TYPE = 'application/vnd.npm.install-v1+json';

const VERSION_FIELDS = [
  'name',
  'version',
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
  'bin',
  'os',
  'cpu',
  'directories',
  'engines',
  'deprecated',
  '_hasShrinkwrap',
  'hasInstallScript',
  'funding',
  'license',
] as const;

const DIST_FIELDS = ['tarball', 'shasum', 'integrity', 'fileCount', 'unpackedSize', 'signatures', 'npm-signature'] as const;

export type Packument = {
  name?: string;
  modified?: string;
  time?: Record<string, string>;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, PackumentVersion>;
  /** npm RFC 0015. These versions are omitted from `versions` and install as E403. */
  policyRestrictions?: {
    message: string;
    versions: Record<string, PackumentVersion>;
  };
  [key: string]: unknown;
};

export type PackumentVersion = {
  dist?: { tarball?: string; integrity?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type PackumentResult = {
  status: number;
  body: Packument;
  /** Rewritten JSON exactly as cached, so an unfiltered response needs no second serialization. */
  json?: string;
  etag?: string;
  gzip?: Buffer;
  /** Names this exact cached document (storage key plus ETag). Set only for cached 200s. */
  cacheId?: string;
};

type Entry = {
  key: string;
  freshUntil: number;
  etag: string;
  json: string;
  gzip: Buffer;
  /** Shared across requests. Callers must not mutate it. */
  body: Packument;
};

type Loaded = { status: 200; full: Entry; abbr: Entry } | { status: number; body: Packument };

export type PackumentOutput = { json: string; etag: string; gzip?: Buffer };

function memoryBudget(): number {
  return Math.max(0, config.gateway.npmMemoryCacheMb) * 1024 * 1024;
}

/** Parsed packuments keyed by storage key and ETag, so a hot hit skips the transfer and the parse. */
const parsedMemory = new ByteLru<Entry>(Math.floor(memoryBudget() * 0.75));
/** Filtered responses keyed by document and blocked-version set. Deterministic, so never invalidated. */
const filteredMemory = new ByteLru<PackumentOutput>(Math.floor(memoryBudget() * 0.25));

export function resetNpmMemoryCache(): void {
  parsedMemory.clear();
  filteredMemory.clear();
}

export function etagFor(body: string): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

/** Runs on the libuv thread pool so a large packument does not block other requests. */
export function gzipJson(json: string): Promise<Buffer> {
  return gzipAsync(Buffer.from(json));
}

export function wantsAbbreviatedPackument(accept: string | undefined): boolean {
  if (!accept) return false;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().split(';').map((s) => s.trim());
    if (type.toLowerCase() !== ABBREVIATED_TYPE) continue;
    const q = params.find((p) => p.toLowerCase().startsWith('q='));
    if (q && Number(q.slice(2)) === 0) return false;
    return true;
  }
  return false;
}

export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const [enc, ...params] = part.trim().split(';').map((s) => s.trim().toLowerCase());
    if (enc !== 'gzip' && enc !== '*') return false;
    const q = params.find((p) => p.startsWith('q='));
    return !(q && Number(q.slice(2)) === 0);
  });
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const want = etag.replace(/^W\//, '').replace(/"/g, '');
  return header.split(',').some((part) => part.trim().replace(/^W\//, '').replace(/"/g, '') === want);
}

/** npm packuments store publish times in a top-level map, not on each version. */
const PACKUMENT_TIME_META = new Set(['created', 'modified']);

export function packumentTimeMap(packument: { time?: unknown; [key: string]: unknown }): Record<string, string> | undefined {
  const time = packument.time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(time as Record<string, unknown>)) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function latestVersionPublishTime(timeMap: Record<string, string> | undefined): string | undefined {
  if (!timeMap) return undefined;
  let best: { at: number; iso: string } | undefined;
  for (const [key, iso] of Object.entries(timeMap)) {
    if (PACKUMENT_TIME_META.has(key)) continue;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) continue;
    if (!best || at > best.at) best = { at, iso };
  }
  return best?.iso;
}

function versionPublishTime(meta: PackumentVersion | undefined): string | undefined {
  const t = meta?.time ?? meta?.published;
  return typeof t === 'string' && !Number.isNaN(Date.parse(t)) ? t : undefined;
}

export function withVersionPublishTime<T extends PackumentVersion>(
  meta: T | undefined,
  version: string,
  timeMap: Record<string, string> | undefined
): T | undefined {
  if (meta && versionPublishTime(meta)) return meta;
  const iso = timeMap?.[version];
  if (!iso) return meta;
  return { ...(meta ?? ({} as T)), time: iso };
}

function licenseText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (value && typeof value === 'object' && 'type' in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' && type.trim() ? type.trim() : undefined;
  }
  return undefined;
}

/**
 * npm `license` (string or `{type}`), then the legacy `licenses` array.
 * Several legacy entries are alternatives, so they are joined with OR.
 */
export function npmDeclaredLicense(meta: PackumentVersion | null | undefined): string | undefined {
  const direct = licenseText(meta?.license);
  if (direct) return direct;
  if (!Array.isArray(meta?.licenses)) return undefined;
  const parts = meta.licenses.map(licenseText).filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' OR ') : undefined;
}

function licenseOf(meta: PackumentVersion | undefined): string | undefined {
  return npmDeclaredLicense(meta);
}

/** npm install fails when dist-tags.latest points at a version policy removed. */
export function repairDistTags(packument: Packument): Packument {
  const versions = packument.versions ?? {};
  const names = Object.keys(versions);
  if (names.length === 0) {
    return { ...packument, versions, 'dist-tags': {} };
  }
  const valid = names.filter((version) => semver.valid(version));
  const stable = valid.filter((version) => semver.prerelease(version) == null);
  const pool = stable.length > 0 ? stable : valid;
  const highest = pool.length > 0 ? [...pool].sort(semver.rcompare)[0] : names[names.length - 1];
  const tags: Record<string, string> = { ...(packument['dist-tags'] ?? {}) };
  for (const [tag, version] of Object.entries(tags)) {
    if (!versions[version]) tags[tag] = highest;
  }
  if (!versions[tags.latest]) tags.latest = highest;
  return { ...packument, versions, 'dist-tags': tags };
}

/**
 * Drop the per-version clause. npm prints the top-level message for the one
 * version it selected, and that line already names the version.
 */
function reasonsForPrintedMessage(reasons: string[] | null | undefined): string[] {
  return (reasons ?? []).filter((reason) => !/^Version \S+ matches range /.test(reason));
}

/** New URL so npm cannot satisfy the install from a tarball it cached before the block. */
function blockedTarballUrl(tarball: string): string {
  try {
    const url = new URL(tarball);
    url.searchParams.set('depgate-decision', 'block');
    return url.toString();
  } catch {
    const sep = tarball.includes('?') ? '&' : '?';
    return `${tarball}${sep}depgate-decision=block`;
  }
}

/**
 * Keep a blocked version in the document so `npm install name@version` requests
 * that tarball. The decision ledger records the 403. `policyRestrictions` fails
 * inside npm before any download, so there is no request to record. `deprecated`
 * is left unchanged: npm installs a deprecated version after printing a warning.
 * Dist-tags are already pointed at an allowed version by `repairDistTags`.
 */
export function restoreBlockedVersions(
  packument: Packument,
  source: Packument,
  blocked: Record<string, VersionBlockNotice>
): Packument {
  const entries = Object.entries(blocked);
  if (entries.length === 0) return packument;
  const versions = { ...(packument.versions ?? {}) };
  for (const [ver] of entries) {
    const meta = source.versions?.[ver];
    if (!meta) continue;
    const dist = meta.dist ? { ...meta.dist } : undefined;
    if (dist?.tarball) dist.tarball = blockedTarballUrl(dist.tarball);
    if (dist) {
      delete dist.integrity;
      delete dist.shasum;
    }
    versions[ver] = dist ? { ...meta, dist } : { ...meta };
  }
  return { ...packument, versions };
}

/**
 * npm-pick-manifest reads this instead of treating a removed version as ETARGET.
 * Each manifest must include `version`. The text npm prints is the top-level message,
 * not the per-version one, and not a list of versions it tried.
 */
export function withPolicyRestrictions(
  packument: Packument,
  blocked: Record<string, VersionBlockNotice>
): Packument {
  const entries = Object.entries(blocked);
  if (entries.length === 0) return packument;
  const versions: Record<string, PackumentVersion> = {};
  const messages: string[] = [];
  for (const [ver, block] of entries) {
    const message = blockedVersionMessage(block);
    versions[ver] = {
      name: packument.name,
      version: ver,
      message,
    };
    const printed = blockedVersionMessage({
      ...block,
      reasons: reasonsForPrintedMessage(block.reasons),
    });
    if (!messages.includes(printed)) messages.push(printed);
  }
  return {
    ...packument,
    policyRestrictions: {
      message: messages.join('\n'),
      versions,
    },
  };
}

/** Single-line value for the npm-notice response header. */
export function npmNoticeHeader(message: string): string {
  return message.replace(/[\r\n]+/g, ' ').slice(0, 512);
}

/**
 * Install-sized packument. dist.tarball is copied from the already rewritten document.
 * The time map is kept: npm ignores it, and release-age policies need it to filter
 * versions here rather than failing later at the tarball.
 */
export function abbreviatePackument(packument: Packument): Packument {
  const versions: Record<string, PackumentVersion> = {};
  for (const [ver, meta] of Object.entries(packument.versions ?? {})) {
    const next: PackumentVersion = {};
    if (meta && typeof meta === 'object') {
      for (const field of VERSION_FIELDS) {
        if (meta[field] !== undefined) next[field] = meta[field];
      }
      if (!next.version) next.version = ver;
      if (meta.dist && typeof meta.dist === 'object') {
        const dist: Record<string, unknown> = {};
        for (const field of DIST_FIELDS) {
          const value = meta.dist[field];
          if (value !== undefined) dist[field] = value;
        }
        next.dist = dist as PackumentVersion['dist'];
      }
    }
    versions[ver] = next;
  }
  const out: Packument = {
    name: packument.name,
    'dist-tags': packument['dist-tags'] ? { ...packument['dist-tags'] } : undefined,
    versions,
  };
  if (typeof packument.modified === 'string') out.modified = packument.modified;
  const timeMap = packumentTimeMap(packument);
  if (timeMap) out.time = timeMap;
  return out;
}

export function rewritePackument(
  packument: Packument,
  gatewayBase: string,
  repo?: RepoUrlContext
): Packument {
  const base = gatewayBase.replace(/\/$/, '');
  const name = packument.name ?? '';
  const prefix = `npm/${repoPathPrefix(repo)}`.replace(/\/$/, '');

  const rewritten = { ...packument };
  if (rewritten.versions && typeof rewritten.versions === 'object') {
    const versions: Record<string, PackumentVersion> = {};
    for (const [ver, meta] of Object.entries(rewritten.versions)) {
      if (meta && typeof meta === 'object' && meta.dist?.tarball) {
        const orig = meta.dist.tarball;
        const match = orig.match(/\/(?:@[^/]+\/)?[^/]+\/-\/(.+)$/);
        const tarballName = match ? match[1] : `${name}-${ver}.tgz`;
        const pathSegment = name.replace(/\//g, '%2f');
        const tarballPath = `${prefix}/${pathSegment}/-/${tarballName}`;
        versions[ver] = {
          ...meta,
          dist: {
            ...meta.dist,
            tarball: `${base}/${tarballPath}`,
          },
        };
      } else {
        versions[ver] = meta as PackumentVersion;
      }
    }
    rewritten.versions = versions;
  }
  return rewritten;
}

function scopeOf(repoKey: string, packageName: string): string {
  return !repoKey || repoKey === 'default' ? packageName : `${repoKey}:${packageName}`;
}

export type NpmCacheKeys = {
  full: string;
  abbr: string;
  legacyFull: string;
  legacyAbbr: string;
  index: string;
  negative: string;
  error: string;
  lock: string;
};

export function npmCacheKeys(packageName: string, repoKey: string): NpmCacheKeys {
  const scope = scopeOf(repoKey, packageName);
  return {
    full: `${STORE_PREFIX}${scope}`,
    abbr: `${STORE_PREFIX}${scope}:abbr`,
    legacyFull: `${LEGACY_PREFIX}${scope}`,
    legacyAbbr: `${LEGACY_PREFIX}${scope}:abbr`,
    index: `${INDEX_PREFIX}${scope}`,
    negative: `${NEGATIVE_PREFIX}${scope}`,
    error: `${ERROR_PREFIX}${scope}`,
    lock: `lock:${STORE_PREFIX}${scope}`,
  };
}

/** Every key a publish must drop so the next read sees the new version. */
export function npmMetadataCacheKeys(packageName: string, repoKey: string): string[] {
  const keys = npmCacheKeys(packageName, repoKey);
  return [keys.full, keys.abbr, keys.legacyFull, keys.legacyAbbr, keys.index, keys.negative, keys.error];
}

function staleSeconds(): number {
  return Math.max(config.gateway.npmMetadataTtl, config.gateway.npmMetadataStaleTtl, 1);
}

async function buildEntry(key: string, body: Packument, freshUntil: number): Promise<Entry> {
  const json = JSON.stringify(body);
  return { key, freshUntil, etag: etagFor(json), json, gzip: await gzipJson(json), body };
}

function remember(entry: Entry): void {
  // A parsed object costs roughly twice its JSON text on top of the text itself.
  parsedMemory.set(`${entry.key}|${entry.etag}`, entry, entry.json.length * 3 + entry.gzip.length);
}

function toResult(entry: Entry): PackumentResult {
  return {
    status: 200,
    body: entry.body,
    json: entry.json,
    etag: entry.etag,
    gzip: entry.gzip,
    cacheId: `${entry.key}|${entry.etag}`,
  };
}

function parseMeta(raw: string | null | undefined): { freshUntil: number; etag: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { freshUntil?: unknown; etag?: unknown };
    if (typeof parsed.etag !== 'string') return null;
    return {
      etag: parsed.etag,
      freshUntil: typeof parsed.freshUntil === 'number' ? parsed.freshUntil : Number.POSITIVE_INFINITY,
    };
  } catch {
    return null;
  }
}

/** One small HGET; the body is transferred and parsed only when this process has not seen that ETag. */
async function readEntry(redis: Redis, key: string): Promise<Entry | null> {
  const meta = parseMeta(await redis.hget(key, 'm'));
  if (!meta) return null;
  const known = parsedMemory.get(`${key}|${meta.etag}`);
  if (known) return { ...known, freshUntil: meta.freshUntil };

  const [m, j, g] = await redis.hmgetBuffer(key, 'm', 'j', 'g');
  const current = parseMeta(m?.toString('utf8'));
  if (!current || !j || !g) return null;
  const json = j.toString('utf8');
  let body: Packument;
  try {
    body = JSON.parse(json) as Packument;
  } catch {
    return null;
  }
  const entry: Entry = { key, freshUntil: current.freshUntil, etag: current.etag, json, gzip: g, body };
  remember(entry);
  return entry;
}

type Multi = ReturnType<Redis['multi']>;

function queueEntry(multi: Multi, entry: Entry, ttlSec: number): void {
  multi.del(entry.key);
  multi.hset(entry.key, {
    m: JSON.stringify({ freshUntil: entry.freshUntil, etag: entry.etag }),
    j: entry.json,
    g: entry.gzip,
  });
  multi.expire(entry.key, Math.max(1, Math.ceil(ttlSec)));
}

type IndexRow = { l?: string; t?: string };

function versionIndexFields(packument: Packument, freshUntil: number, sourceId?: string): Record<string, string> {
  const timeMap = packumentTimeMap(packument);
  const fields: Record<string, string> = {
    // `src`: the remote that served the packument, so its tarballs come from it too (R5).
    [INDEX_META_FIELD]: JSON.stringify({ freshUntil, latest: latestVersionPublishTime(timeMap), src: sourceId }),
  };
  for (const [version, meta] of Object.entries(packument.versions ?? {})) {
    const row: IndexRow = {};
    const license = licenseOf(meta);
    if (license) row.l = license;
    const time = timeMap?.[version] ?? versionPublishTime(meta);
    if (time) row.t = time;
    fields[version] = JSON.stringify(row);
  }
  return fields;
}

function notFound(): { status: number; body: Packument } {
  return { status: 404, body: {} as Packument };
}

/** A remembered status is returned as that status; a remembered exception is thrown again. */
function fromError(error: CachedError): { status: number; body: Packument } {
  if (typeof error.status === 'number') return { status: error.status, body: { error: error.message } as Packument };
  throw rememberedError(error);
}

function decodeLegacy(raw: string): { freshUntil: number; result: PackumentResult } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v === 2 && typeof obj.json === 'string') {
    try {
      const body = JSON.parse(obj.json) as Packument;
      return {
        freshUntil: typeof obj.freshUntil === 'number' ? obj.freshUntil : Number.POSITIVE_INFINITY,
        result: {
          status: 200,
          body,
          json: obj.json,
          etag: typeof obj.etag === 'string' ? obj.etag : undefined,
          gzip: typeof obj.gzip === 'string' ? Buffer.from(obj.gzip, 'base64') : undefined,
        },
      };
    } catch {
      return null;
    }
  }
  return { freshUntil: Number.POSITIVE_INFINITY, result: { status: 200, body: parsed as Packument } };
}

async function readLegacy(
  redis: Redis,
  keys: NpmCacheKeys,
  abbreviated: boolean
): Promise<{ freshUntil: number; result: PackumentResult } | null> {
  if (abbreviated) {
    const abbr = await redis.get(keys.legacyAbbr);
    const decoded = abbr ? decodeLegacy(abbr) : null;
    if (decoded) return decoded;
  }
  const full = await redis.get(keys.legacyFull);
  const decoded = full ? decodeLegacy(full) : null;
  if (!decoded) return null;
  if (!abbreviated) return decoded;
  return { freshUntil: decoded.freshUntil, result: { status: 200, body: abbreviatePackument(decoded.result.body) } };
}

function cacheContext(db: DataSource, redis: Redis, packageName: string, route: PackageRoute, repo?: RepoUrlContext) {
  // An enforced reserved name has its own keys, so a copy cached from a public remote is never served for it.
  const keys = npmCacheKeys(packageName, route.cacheScope);

  const persist = async (full: Entry, abbr: Entry, index: Record<string, string>): Promise<void> => {
    const ttl = staleSeconds();
    try {
      const multi = redis.multi();
      queueEntry(multi, full, ttl);
      queueEntry(multi, abbr, ttl);
      multi.del(keys.index);
      multi.hset(keys.index, index);
      multi.expire(keys.index, ttl);
      multi.del(keys.negative, keys.error);
      await multi.exec();
    } catch {
      /* the request still returns the document */
    }
  };

  const rememberNotFound = async (): Promise<Loaded> => {
    try {
      const multi = redis.multi();
      multi.setex(keys.negative, Math.max(1, config.gateway.npmNegativeTtl), '1');
      multi.del(keys.full, keys.abbr, keys.index, keys.legacyFull, keys.legacyAbbr, keys.error);
      await multi.exec();
    } catch {
      /* still answer 404 */
    }
    return notFound();
  };

  const loadUpstream = async (): Promise<Loaded> => {
    const path = packageName.startsWith('@') ? packageName.replace(/\//g, '%2f') : packageName;
    if (route.targets.length === 0) return rememberNotFound();

    const result = await fetchFromUpstream(db, 'npm', path, { route });
    if (result.status !== 200) {
      if (result.status === 404) return rememberNotFound();
      await writeErrorMarker(
        redis,
        keys.error,
        { status: result.status, message: `Upstream returned ${result.status}` },
        config.gateway.cacheErrorTtl
      );
      return { status: result.status, body: (result.body as Packument) ?? ({} as Packument) };
    }

    const rewritten = rewritePackument(result.body as Packument, config.gateway.baseUrl, repo);
    const freshUntil = Date.now() + config.gateway.npmMetadataTtl * 1000;
    const [full, abbr] = await Promise.all([
      buildEntry(keys.full, rewritten, freshUntil),
      buildEntry(keys.abbr, abbreviatePackument(rewritten), freshUntil),
    ]);
    remember(full);
    remember(abbr);
    await persist(full, abbr, versionIndexFields(rewritten, freshUntil, result.source?.id));
    return { status: 200, full, abbr };
  };

  /** Rebuild the abbreviated variant from a cached full document and store it for the rest of that TTL. */
  const abbrFromFull = async (full: Entry): Promise<Entry> => {
    const abbr = await buildEntry(keys.abbr, abbreviatePackument(full.body), full.freshUntil);
    remember(abbr);
    try {
      const remaining = typeof redis.pttl === 'function' ? await redis.pttl(keys.full) : -1;
      const multi = redis.multi();
      queueEntry(multi, abbr, remaining > 0 ? remaining / 1000 : staleSeconds());
      await multi.exec();
    } catch {
      /* the derived body is still returned */
    }
    return abbr;
  };

  const currentLoaded = async (): Promise<Loaded | null> => {
    const full = await readEntry(redis, keys.full);
    if (!full) return null;
    const abbr = (await readEntry(redis, keys.abbr)) ?? (await abbrFromFull(full));
    return { status: 200, full, abbr };
  };

  const settledState = async (): Promise<Loaded | null> => {
    const current = await currentLoaded();
    if (current) return current;
    if (await redis.get(keys.negative)) return notFound();
    const remembered = await readErrorMarker(redis, keys.error);
    return remembered ? fromError(remembered) : null;
  };

  /**
   * Fetch both variants under one cross-replica lock. Every caller gets both and
   * picks its own, so concurrent full and abbreviated requests cannot swap documents.
   */
  const refresh = async (force: boolean): Promise<Loaded | null> => {
    if (!force) {
      const settled = await settledState();
      if (settled) return settled;
    }
    const handle = await acquireLock(redis, keys.lock, config.gateway.cacheLockTtl);
    if (!handle) {
      if (force) return null;
      const settled = await waitForFill(redis, keys.lock, settledState, config.gateway.cacheWaitMaxMs);
      if (settled) return settled;
    }
    try {
      return await loadUpstream();
    } catch (error) {
      await writeErrorMarker(redis, keys.error, errorMarkerFor(error), config.gateway.cacheErrorTtl);
      throw error;
    } finally {
      await handle?.release();
    }
  };

  const refreshInBackground = (): void => {
    void singleFlight(`${keys.full}|bg`, () => refresh(true)).catch(() => {});
  };

  return { keys, loadUpstream, refresh, refreshInBackground, abbrFromFull };
}

function pick(loaded: Loaded | null, abbreviated: boolean): PackumentResult {
  if (!loaded) throw new Error('Packument unavailable');
  if (loaded.status === 200 && 'full' in loaded) return toResult(abbreviated ? loaded.abbr : loaded.full);
  return { status: loaded.status, body: (loaded as { body: Packument }).body };
}

/**
 * A fresh hit is served as stored. A stale hit is served while one replica refreshes it.
 * A miss is fetched once per process and once across replicas, and an upstream failure
 * is remembered briefly so waiting requests return at once.
 */
export async function getPackument(
  db: DataSource,
  redis: Redis,
  packageName: string,
  repo?: RepoUrlContext,
  opts?: { abbreviated?: boolean; route?: PackageRoute }
): Promise<PackumentResult> {
  const abbreviated = opts?.abbreviated === true;
  const route = opts?.route ?? (await resolvePackageTargets(db, 'npm', repo?.key || 'default', packageName));
  const ctx = cacheContext(db, redis, packageName, route, repo);

  let remembered: CachedError | null;
  try {
    const own = await readEntry(redis, abbreviated ? ctx.keys.abbr : ctx.keys.full);
    if (own) {
      if (own.freshUntil <= Date.now()) ctx.refreshInBackground();
      return toResult(own);
    }
    if (abbreviated) {
      const full = await readEntry(redis, ctx.keys.full);
      if (full) {
        if (full.freshUntil <= Date.now()) ctx.refreshInBackground();
        return toResult(await ctx.abbrFromFull(full));
      }
    }
    const legacy = await readLegacy(redis, ctx.keys, abbreviated);
    if (legacy) {
      if (legacy.freshUntil <= Date.now()) ctx.refreshInBackground();
      return legacy.result;
    }
    if (await redis.get(ctx.keys.negative)) return notFound();
    remembered = await readErrorMarker(redis, ctx.keys.error);
  } catch {
    // Redis is unavailable: serve straight from upstream, still one fetch per process.
    return pick(await singleFlight(`${ctx.keys.full}|direct`, () => ctx.loadUpstream()), abbreviated);
  }
  if (remembered) return fromError(remembered);

  return pick(await singleFlight(ctx.keys.full, () => ctx.refresh(false)), abbreviated);
}

export type NpmVersionInfo = {
  status: number;
  versionMeta?: PackumentVersion;
  packageLastReleaseAt?: string;
  /** The remote that served the packument, when the cache recorded it. */
  sourceId?: string;
  /** The packument lists the version. A tarball of a version the registry removed is never served from the artifact cache. */
  listed?: boolean;
};

/**
 * What the tarball route needs for one version: license, publish time
 * and the package's newest release. Read from the per-version index so a download
 * does not transfer and parse the whole packument.
 */
export async function getNpmVersionInfo(
  db: DataSource,
  redis: Redis,
  packageName: string,
  version: string,
  repo?: RepoUrlContext,
  route?: PackageRoute
): Promise<NpmVersionInfo> {
  route ??= await resolvePackageTargets(db, 'npm', repo?.key || 'default', packageName);
  const ctx = cacheContext(db, redis, packageName, route, repo);
  try {
    const [metaRaw, rowRaw] = await redis.hmget(ctx.keys.index, INDEX_META_FIELD, version);
    if (metaRaw && rowRaw) {
      const meta = JSON.parse(metaRaw) as { freshUntil?: number; latest?: string; src?: string };
      const row = JSON.parse(rowRaw) as IndexRow;
      if (typeof meta.freshUntil === 'number' && meta.freshUntil <= Date.now()) ctx.refreshInBackground();
      const versionMeta: PackumentVersion = {};
      if (row.l) versionMeta.license = row.l;
      if (row.t) versionMeta.time = row.t;
      return { status: 200, versionMeta, packageLastReleaseAt: meta.latest, sourceId: meta.src, listed: true };
    }
  } catch {
    /* fall back to the packument */
  }

  const packed = await getPackument(db, redis, packageName, repo, { route });
  if (packed.status !== 200) return { status: packed.status };
  const timeMap = packumentTimeMap(packed.body);
  return {
    status: 200,
    versionMeta: withVersionPublishTime(packed.body.versions?.[version], version, timeMap),
    packageLastReleaseAt: latestVersionPublishTime(timeMap),
    listed: Boolean(packed.body.versions?.[version]),
  };
}

/** The remote that served the cached packument (R5), or null when the cache does not say. */
export async function npmPackumentSource(
  db: DataSource,
  redis: Redis,
  packageName: string,
  route: PackageRoute
): Promise<RemoteTarget | null> {
  if (route.targets.length === 1) return route.targets[0];
  const ctx = cacheContext(db, redis, packageName, route);
  try {
    const raw = await redis.hget(ctx.keys.index, INDEX_META_FIELD);
    const src = raw ? (JSON.parse(raw) as { src?: string }).src : undefined;
    return route.targets.find((target) => target.id === src) ?? null;
  } catch {
    return null;
  }
}

/** Stable name for a set of blocked versions, used to cache the filtered response. */
export function blockedSignature(versions: string[]): string {
  return createHash('sha1').update([...versions].sort().join('\n')).digest('hex');
}

/**
 * Serialize a filtered or tokenized packument. With a cache key, the result is kept in
 * memory: the same document with the same blocked set always renders the same bytes.
 */
export async function renderPackument(
  body: Packument,
  opts: { cacheKey?: string; wantGzip: boolean }
): Promise<PackumentOutput> {
  if (opts.cacheKey) {
    const hit = filteredMemory.get(opts.cacheKey);
    if (hit) return hit;
  }
  const json = JSON.stringify(body);
  const output: PackumentOutput = { json, etag: etagFor(json) };
  if (opts.wantGzip || opts.cacheKey) output.gzip = await gzipJson(json);
  if (opts.cacheKey) filteredMemory.set(opts.cacheKey, output, json.length + (output.gzip?.length ?? 0));
  return output;
}
