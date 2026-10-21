import type Redis from 'ioredis';

/**
 * Fixed-window counter in Redis, shared across replicas. Returns false once `limit` is passed
 * inside the window. If Redis is unavailable the request is let through rather than locking people out.
 */
export async function allowHit(redis: Redis | undefined, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (!redis) return true;
  try {
    const redisKey = `rl:${key}`;
    // One MULTI, so a crash between the two can never leave a counter without a TTL.
    const replies = await redis.multi().set(redisKey, '0', 'EX', windowSeconds, 'NX').incr(redisKey).exec();
    const count = Number(replies?.[1]?.[1] ?? 0);
    return count <= limit;
  } catch {
    return true;
  }
}

/**
 * Counts only failures: `failureCount` reads the counter without raising it, `noteFailure` raises it.
 * Used for sign-in, so a busy office behind one address is never limited by its successful sign-ins.
 */
export async function failureCount(redis: Redis | undefined, key: string): Promise<number> {
  if (!redis) return 0;
  try {
    return Number((await redis.get(`rl:${key}`)) ?? 0);
  } catch {
    return 0;
  }
}

export async function noteFailure(redis: Redis | undefined, key: string, windowSeconds: number): Promise<void> {
  if (!redis) return;
  try {
    const redisKey = `rl:${key}`;
    await redis.multi().set(redisKey, '0', 'EX', windowSeconds, 'NX').incr(redisKey).exec();
  } catch {
    /* Redis down: no limit rather than no sign-in. */
  }
}
