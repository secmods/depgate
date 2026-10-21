import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export type MutexHandle = { release: () => Promise<void> };

/**
 * One run at a time across the cluster for a scheduled job. The key expires on its own if the holder
 * dies, and is renewed while the job runs, so a long job never loses it and a crashed one frees it soon.
 */
export async function acquireRunMutex(redis: Redis, key: string, ttlMs = 90_000): Promise<MutexHandle | null> {
  const token = randomUUID();
  if ((await redis.set(key, token, 'PX', ttlMs, 'NX')) !== 'OK') return null;
  const timer = setInterval(() => {
    void redis.eval(RENEW, 1, key, token, String(ttlMs)).catch(() => undefined);
  }, Math.max(Math.floor(ttlMs / 3), 1000));
  timer.unref?.();
  return {
    release: async () => {
      clearInterval(timer);
      await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    },
  };
}

export async function mutexHeld(redis: Redis, key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}
