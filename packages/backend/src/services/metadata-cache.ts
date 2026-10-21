import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { config } from '../config.js';
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

const POSITIVE_PREFIX = 'meta:v1:';
const NEGATIVE_PREFIX = 'meta:404:v1:';
const ERROR_PREFIX = 'meta:err:v1:';

export type CachedDocument = {
  status: number;
  fromUrl: string;
  bodyText: string;
  /** Upstream Last-Modified header, when the loader captured it. */
  lastModified?: string;
};

type LoadResult = CachedDocument;

type StoredPositive = {
  fromUrl?: string;
  bodyText?: string;
  freshUntil?: number;
  lastModified?: string;
};

type ReadState = { kind: 'fresh' | 'stale'; doc: CachedDocument } | { kind: 'negative' } | null;

type Settled = { doc: CachedDocument } | { error: CachedError };

function usable(redis: Redis | null | undefined): redis is Redis {
  return !!redis && typeof redis.get === 'function' && typeof redis.setex === 'function';
}

function positiveKey(ecosystem: string, repoKey: string, path: string): string {
  return `${POSITIVE_PREFIX}${ecosystem}:${repoKey}:${path}`;
}

function negativeKey(ecosystem: string, repoKey: string, path: string): string {
  return `${NEGATIVE_PREFIX}${ecosystem}:${repoKey}:${path}`;
}

function errorKey(ecosystem: string, repoKey: string, path: string): string {
  return `${ERROR_PREFIX}${ecosystem}:${repoKey}:${path}`;
}

function lockKey(positive: string): string {
  return `lock:${positive}`;
}

function staleSeconds(): number {
  return Math.max(config.gateway.metadataTtl, config.gateway.metadataStaleTtl, 1);
}

function negativeDoc(): CachedDocument {
  return { status: 404, fromUrl: '', bodyText: '' };
}

function toDoc(loaded: LoadResult): CachedDocument {
  const doc: CachedDocument = { status: loaded.status, fromUrl: loaded.fromUrl, bodyText: loaded.bodyText };
  if (loaded.lastModified) doc.lastModified = loaded.lastModified;
  return doc;
}

/** A remembered status becomes that status; a remembered exception is thrown again. */
function fromError(error: CachedError): CachedDocument {
  if (typeof error.status === 'number') return { status: error.status, fromUrl: '', bodyText: '' };
  throw rememberedError(error);
}

function parsePositive(raw: string): { doc: CachedDocument; freshUntil: number } | null {
  try {
    const parsed = JSON.parse(raw) as StoredPositive;
    if (typeof parsed.bodyText !== 'string') return null;
    const doc: CachedDocument = { status: 200, fromUrl: parsed.fromUrl ?? '', bodyText: parsed.bodyText };
    if (typeof parsed.lastModified === 'string') doc.lastModified = parsed.lastModified;
    return {
      doc,
      freshUntil: typeof parsed.freshUntil === 'number' ? parsed.freshUntil : Number.POSITIVE_INFINITY,
    };
  } catch {
    return null;
  }
}

async function persist(redis: Redis, pos: string, neg: string, err: string, loaded: LoadResult): Promise<void> {
  try {
    if (loaded.status === 200) {
      const stored: StoredPositive = {
        fromUrl: loaded.fromUrl,
        bodyText: loaded.bodyText,
        freshUntil: Date.now() + config.gateway.metadataTtl * 1000,
      };
      if (loaded.lastModified) stored.lastModified = loaded.lastModified;
      await redis.setex(pos, staleSeconds(), JSON.stringify(stored));
      if (typeof redis.del === 'function') await redis.del(neg, err);
    } else if (loaded.status === 404) {
      if (typeof redis.del === 'function') await redis.del(pos, err);
      await redis.setex(neg, config.gateway.metadataNegativeTtl, '1');
    } else {
      await writeErrorMarker(
        redis,
        err,
        { status: loaded.status, message: `Upstream returned ${loaded.status}` },
        config.gateway.cacheErrorTtl
      );
    }
  } catch {
    /* serve the fresh document even if Redis rejects the write */
  }
}

/**
 * Cache the raw upstream document. Callers filter and rewrite after the read.
 * A fresh hit is served as stored. A stale hit is served while one replica refreshes it.
 * A miss is fetched once per process and once across replicas. 404s use the short negative TTL.
 * Upstream failures are remembered for CACHE_ERROR_TTL so waiters return at once.
 */
export async function getCachedDocument(
  redis: Redis | null | undefined,
  _db: DataSource,
  ecosystem: string,
  repoKey: string,
  path: string,
  load: () => Promise<LoadResult>
): Promise<CachedDocument> {
  const key = repoKey || 'default';
  if (!usable(redis)) return toDoc(await load());

  const pos = positiveKey(ecosystem, key, path);
  const neg = negativeKey(ecosystem, key, path);
  const err = errorKey(ecosystem, key, path);
  const lock = lockKey(pos);

  const read = async (): Promise<ReadState> => {
    const cached = await redis.get(pos);
    if (cached) {
      const parsed = parsePositive(cached);
      if (parsed) {
        return { kind: parsed.freshUntil > Date.now() ? 'fresh' : 'stale', doc: parsed.doc };
      }
    }
    if (await redis.get(neg)) return { kind: 'negative' };
    return null;
  };

  const probe = async (): Promise<Settled | null> => {
    const state = await read();
    if (state?.kind === 'negative') return { doc: negativeDoc() };
    if (state) return { doc: state.doc };
    const error = await readErrorMarker(redis, err);
    return error ? { error } : null;
  };

  const refresh = async (force: boolean): Promise<CachedDocument | null> => {
    if (!force) {
      const again = await read();
      if (again?.kind === 'negative') return negativeDoc();
      if (again) return again.doc;
    }

    const handle = await acquireLock(redis, lock, config.gateway.cacheLockTtl);
    if (!handle) {
      // Another replica is fetching. A background refresh simply stops; a miss waits for that fetch.
      if (force) return null;
      const settled = await waitForFill(redis, lock, probe, config.gateway.cacheWaitMaxMs);
      if (settled) return 'doc' in settled ? settled.doc : fromError(settled.error);
    }

    try {
      const loaded = await load();
      await persist(redis, pos, neg, err, loaded);
      return toDoc(loaded);
    } catch (error) {
      await writeErrorMarker(redis, err, errorMarkerFor(error), config.gateway.cacheErrorTtl);
      throw error;
    } finally {
      await handle?.release();
    }
  };

  let hit: ReadState;
  let remembered: CachedError | null = null;
  try {
    hit = await read();
    if (!hit) remembered = await readErrorMarker(redis, err);
  } catch {
    // Redis is unavailable: serve straight from upstream, still one fetch per process.
    return toDoc(await singleFlight(`${pos}|direct`, load));
  }

  if (hit?.kind === 'negative') return negativeDoc();
  if (hit?.kind === 'fresh') return hit.doc;
  if (hit?.kind === 'stale') {
    void singleFlight(`${pos}|bg`, () => refresh(true)).catch(() => {});
    return hit.doc;
  }
  if (remembered) return fromError(remembered);

  const doc = await singleFlight(pos, () => refresh(false));
  return doc ?? toDoc(await load());
}
