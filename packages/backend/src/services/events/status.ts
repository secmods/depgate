import type Redis from 'ioredis';
import { dgKey, hourBucket } from './summary.js';

/**
 * Destination status in Redis (requirements_event_streaming.md R-D13), written by whichever consumer saw the
 * outcome and read by any replica for the UI. No row per event is written to Postgres.
 */

export type DestinationHealth = 'healthy' | 'retrying' | 'auth_failed';

export type DestinationStatus = {
  status: DestinationHealth | 'disabled' | 'idle';
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pausedUntil: string | null;
  sent24h: number;
  dropped24h: Record<string, number>;
  sentTotal: number;
  lagSeconds: number | null;
  lastLoss: { count: number; at: string } | null;
};

const COUNTER_TTL_SECONDS = 26 * 3600;
/** The status hash outlives any outage it describes, and goes when a destination is idle for a month. */
const STATUS_TTL_SECONDS = 30 * 86_400;

export function statusKey(destinationId: string): string {
  return dgKey(`events:dest:${destinationId}`);
}

function hourKey(destinationId: string, what: string, bucket: string): string {
  return `${statusKey(destinationId)}:${what}:${bucket}`;
}

export async function noteSent(redis: Redis, destinationId: string, count: number, now = Date.now()): Promise<void> {
  const key = statusKey(destinationId);
  const hour = hourKey(destinationId, 'sent', hourBucket(now));
  await redis
    .multi()
    .hset(key, 'status', 'healthy', 'lastSuccessAt', new Date(now).toISOString(), 'pausedUntil', '')
    .hincrby(key, 'sent', count)
    .expire(key, STATUS_TTL_SECONDS)
    .incrby(hour, count)
    .expire(hour, COUNTER_TTL_SECONDS)
    .exec();
}

export async function noteDropped(redis: Redis, destinationId: string, reason: string, count: number, now = Date.now()): Promise<void> {
  if (count <= 0) return;
  const key = statusKey(destinationId);
  const hour = hourKey(destinationId, `dropped:${reason}`, hourBucket(now));
  const tx = redis.multi().hincrby(key, `dropped:${reason}`, count).expire(key, STATUS_TTL_SECONDS).incrby(hour, count).expire(hour, COUNTER_TTL_SECONDS);
  if (reason === 'buffer_full') tx.hset(key, 'lastLossCount', String(count), 'lastLossAt', new Date(now).toISOString());
  await tx.exec();
}

export async function noteError(redis: Redis, destinationId: string, health: DestinationHealth, error: string, pausedUntil?: number): Promise<void> {
  const fields = ['status', health, 'lastError', error.slice(0, 500), 'lastErrorAt', new Date().toISOString()];
  if (pausedUntil !== undefined) fields.push('pausedUntil', new Date(pausedUntil).toISOString());
  await redis.multi().hset(statusKey(destinationId), ...fields).expire(statusKey(destinationId), STATUS_TTL_SECONDS).exec();
}

export async function notePaused(redis: Redis, destinationId: string): Promise<number | null> {
  const value = await redis.hget(statusKey(destinationId), 'pausedUntil');
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
}

export async function setLag(redis: Redis, destinationId: string, seconds: number | null): Promise<void> {
  await redis
    .multi()
    .hset(statusKey(destinationId), 'lagSeconds', seconds === null ? '' : String(Math.round(seconds)))
    .expire(statusKey(destinationId), STATUS_TTL_SECONDS)
    .exec();
}

export async function clearStatus(redis: Redis, destinationId: string): Promise<void> {
  const keys = [statusKey(destinationId)];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${statusKey(destinationId)}:*`, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  await redis.del(...keys);
}

export async function readStatus(redis: Redis, destinationId: string, enabled: boolean, now = Date.now()): Promise<DestinationStatus> {
  const hash = await redis.hgetall(statusKey(destinationId));
  const buckets = Array.from({ length: 24 }, (_, i) => hourBucket(now - i * 3_600_000));
  const sentKeys = buckets.map((bucket) => hourKey(destinationId, 'sent', bucket));
  const reasons = ['buffer_full', 'rejected', 'unknown_type', 'redis_unavailable'];
  const droppedKeys = reasons.flatMap((reason) => buckets.map((bucket) => hourKey(destinationId, `dropped:${reason}`, bucket)));
  const values = await redis.mget(...sentKeys, ...droppedKeys);
  const sum = (from: number, to: number) => values.slice(from, to).reduce((n, v) => n + Number(v ?? 0), 0);
  const dropped24h: Record<string, number> = {};
  reasons.forEach((reason, i) => {
    const n = sum(24 + i * 24, 24 + (i + 1) * 24);
    if (n) dropped24h[reason] = n;
  });
  const pausedUntil = hash.pausedUntil && Date.parse(hash.pausedUntil) > now ? hash.pausedUntil : null;
  const health = (hash.status as DestinationHealth | undefined) ?? null;
  return {
    status: !enabled ? 'disabled' : (health ?? 'idle'),
    lastSuccessAt: hash.lastSuccessAt || null,
    lastError: hash.lastError || null,
    lastErrorAt: hash.lastErrorAt || null,
    pausedUntil,
    sent24h: sum(0, 24),
    dropped24h,
    sentTotal: Number(hash.sent ?? 0),
    lagSeconds: hash.lagSeconds ? Number(hash.lagSeconds) : null,
    lastLoss: hash.lastLossCount ? { count: Number(hash.lastLossCount), at: hash.lastLossAt } : null,
  };
}
