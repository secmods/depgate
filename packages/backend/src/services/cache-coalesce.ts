import { randomUUID } from 'node:crypto';
import { retryAfterSeconds } from './circuit-breaker.js';

type CoalesceRedis = {
  set?: (key: string, value: string, expiryMode: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
  setex?: (key: string, ttl: number, value: string) => Promise<unknown>;
  get?: (key: string) => Promise<string | null>;
  del?: (...keys: string[]) => Promise<unknown>;
  exists?: (...keys: string[]) => Promise<number>;
  eval?: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
  pipeline?: () => {
    setex: (key: string, ttl: number, value: string) => unknown;
    exec: () => Promise<unknown>;
  };
};

const inflight = new Map<string, Promise<unknown>>();

/** One in-process caller runs fn. Concurrent callers for the same key share that promise. */
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export type LockHandle = {
  /** False when Redis could not be asked, so the caller proceeds unlocked. */
  held: boolean;
  release: () => Promise<void>;
};

const UNLOCKED: LockHandle = { held: false, release: async () => {} };

/**
 * NX lock with an owner token. The holder renews it while it works, so a slow
 * upstream fetch cannot outlive the lock and let a second replica start the same fetch.
 * Returns null when another caller holds it. Fails open when Redis cannot answer.
 */
export async function acquireLock(redis: CoalesceRedis, key: string, ttlSec: number): Promise<LockHandle | null> {
  if (typeof redis.set !== 'function') return UNLOCKED;
  const token = randomUUID();
  const ttl = Math.max(1, Math.floor(ttlSec));
  let res: string | null;
  try {
    res = await redis.set(key, token, 'EX', ttl, 'NX');
  } catch {
    return UNLOCKED;
  }
  if (res !== 'OK') return null;

  const ttlMs = ttl * 1000;
  const timer = setInterval(() => {
    if (typeof redis.eval !== 'function') return;
    redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs).catch(() => {});
  }, Math.max(250, Math.floor(ttlMs / 3)));
  timer.unref?.();

  let released = false;
  return {
    held: true,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        if (typeof redis.eval === 'function') {
          await redis.eval(RELEASE_SCRIPT, 1, key, token);
          return;
        }
        if (typeof redis.get === 'function' && typeof redis.del === 'function') {
          if ((await redis.get(key)) === token) await redis.del(key);
        }
      } catch {
        /* the lock expires on its own */
      }
    },
  };
}

async function lockExists(redis: CoalesceRedis, key: string): Promise<boolean | null> {
  try {
    if (typeof redis.exists === 'function') return (await redis.exists(key)) > 0;
    if (typeof redis.get === 'function') return (await redis.get(key)) !== null;
  } catch {
    return null;
  }
  return null;
}

/**
 * Poll until probe settles, the lock disappears, or maxMs passes.
 * Returns the settled value, or null so the caller fetches for itself.
 */
export async function waitForFill<T>(
  redis: CoalesceRedis,
  lockKey: string,
  probe: () => Promise<T | null>,
  maxMs: number,
  intervalMs = 50
): Promise<T | null> {
  const deadline = Date.now() + Math.max(0, maxMs);
  for (;;) {
    const settled = await probe();
    if (settled !== null) return settled;
    const held = await lockExists(redis, lockKey);
    if (held === false) return probe();
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** `retryAt` (epoch ms) is set when the failure was an open circuit breaker. */
export type CachedError = { status?: number; message: string; retryAt?: number };

/** The marker for a thrown upstream failure. An open breaker's Retry-After is kept as a time. */
export function errorMarkerFor(error: unknown): CachedError {
  const marker: CachedError = { message: error instanceof Error ? error.message : String(error) };
  const retryAfter = retryAfterSeconds(error);
  if (retryAfter) marker.retryAt = Date.now() + retryAfter * 1000;
  return marker;
}

/** The remembered failure as an error to throw again, with what is left of its Retry-After. */
export function rememberedError(marker: CachedError): Error & { retryAfterSeconds?: number } {
  const error: Error & { retryAfterSeconds?: number } = new Error(marker.message);
  const waitMs = typeof marker.retryAt === 'number' ? marker.retryAt - Date.now() : 0;
  if (waitMs > 0) error.retryAfterSeconds = Math.ceil(waitMs / 1000);
  return error;
}

/** Short-lived record of an upstream failure so waiters and new misses fail fast instead of piling on. */
export async function writeErrorMarker(
  redis: CoalesceRedis,
  key: string,
  error: CachedError,
  ttlSec: number
): Promise<void> {
  if (typeof redis.setex !== 'function' || ttlSec <= 0) return;
  try {
    await redis.setex(key, Math.max(1, Math.floor(ttlSec)), JSON.stringify(error));
  } catch {
    /* callers still see the error on this request */
  }
}

export async function readErrorMarker(redis: CoalesceRedis, key: string): Promise<CachedError | null> {
  if (typeof redis.get !== 'function') return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedError;
    return typeof parsed.message === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Write many SETEX entries in one round trip when the client supports pipelines. */
export async function setexMany(
  redis: CoalesceRedis,
  entries: Array<{ key: string; ttl: number; value: string }>
): Promise<void> {
  if (entries.length === 0) return;
  if (typeof redis.pipeline === 'function') {
    const pipe = redis.pipeline();
    for (const entry of entries) pipe.setex(entry.key, Math.max(1, Math.floor(entry.ttl)), entry.value);
    await pipe.exec();
    return;
  }
  if (typeof redis.setex !== 'function') return;
  await Promise.all(entries.map((entry) => redis.setex!(entry.key, Math.max(1, Math.floor(entry.ttl)), entry.value)));
}
