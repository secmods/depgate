import { describe, expect, it } from 'vitest';
import {
  acquireLock,
  errorMarkerFor,
  readErrorMarker,
  rememberedError,
  setexMany,
  waitForFill,
  writeErrorMarker,
} from './cache-coalesce.js';
import { createMemoryRedis } from '../test-support/memory-redis.js';

describe('cache coalesce lock', () => {
  it('lets one caller hold the lock until it is released', async () => {
    const redis = createMemoryRedis();
    const first = await acquireLock(redis, 'lock:pkg', 30);
    expect(first?.held).toBe(true);
    expect(await acquireLock(redis, 'lock:pkg', 30)).toBeNull();
    await first!.release();
    const second = await acquireLock(redis, 'lock:pkg', 30);
    expect(second?.held).toBe(true);
    await second!.release();
  });

  it('does not delete a lock that another owner took after expiry', async () => {
    const redis = createMemoryRedis();
    const first = await acquireLock(redis, 'lock:pkg', 30);
    // Simulate expiry and a second replica taking over.
    await redis.del('lock:pkg');
    const second = await acquireLock(redis, 'lock:pkg', 30);
    await first!.release();
    expect(await redis.exists('lock:pkg')).toBe(1);
    await second!.release();
    expect(await redis.exists('lock:pkg')).toBe(0);
  });

  it('proceeds unlocked when the client cannot take locks', async () => {
    const handle = await acquireLock({}, 'lock:pkg', 30);
    expect(handle?.held).toBe(false);
  });
});

describe('waitForFill', () => {
  it('returns the value once it appears', async () => {
    const redis = createMemoryRedis();
    await redis.set('lock:pkg', 'holder', 'EX', 30);
    let value: string | null = null;
    setTimeout(() => {
      value = 'ready';
    }, 60);
    await expect(waitForFill(redis, 'lock:pkg', async () => value, 2000, 10)).resolves.toBe('ready');
  });

  it('stops waiting when the lock disappears without a value', async () => {
    const redis = createMemoryRedis();
    await redis.set('lock:pkg', 'holder', 'EX', 30);
    setTimeout(() => void redis.del('lock:pkg'), 40);
    const started = Date.now();
    await expect(waitForFill(redis, 'lock:pkg', async () => null, 5000, 10)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('error markers and batched writes', () => {
  it('round-trips an error marker', async () => {
    const redis = createMemoryRedis();
    await writeErrorMarker(redis, 'err:pkg', { status: 503, message: 'Upstream returned 503' }, 5);
    expect(await readErrorMarker(redis, 'err:pkg')).toEqual({ status: 503, message: 'Upstream returned 503' });
    expect(await redis.ttl('err:pkg')).toBeLessThanOrEqual(5);
  });

  it('keeps an open breaker Retry-After through the marker, counting down', async () => {
    const redis = createMemoryRedis();
    const open = Object.assign(new Error('Upstream cargo/default is unavailable: circuit breaker open'), {
      retryAfterSeconds: 8,
    });
    await writeErrorMarker(redis, 'err:crate', errorMarkerFor(open), 5);
    const again = rememberedError((await readErrorMarker(redis, 'err:crate'))!);
    expect(again.message).toBe(open.message);
    expect(again.retryAfterSeconds).toBeGreaterThan(0);
    expect(again.retryAfterSeconds).toBeLessThanOrEqual(8);

    expect(rememberedError(errorMarkerFor(new Error('timed out'))).retryAfterSeconds).toBeUndefined();
    expect(rememberedError({ message: 'old', retryAt: Date.now() - 1000 }).retryAfterSeconds).toBeUndefined();
  });

  it('writes many keys through one pipeline', async () => {
    const redis = createMemoryRedis();
    await setexMany(redis, [
      { key: 'a', ttl: 10, value: '1' },
      { key: 'b', ttl: 10, value: '2' },
    ]);
    expect(await redis.mget('a', 'b')).toEqual(['1', '2']);
  });
});
