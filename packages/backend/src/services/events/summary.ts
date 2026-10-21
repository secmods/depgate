import { createHash, randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { config } from '../../config.js';
import { ByteLru } from '../memory-lru.js';
import { summaryWritesLostTotal } from './metrics.js';

/**
 * Summary tables without a database write per download (requirements_event_streaming.md §5.2).
 *
 * Counts: each replica sums in memory and sends the sums to Redis every 5 s (HINCRBY per hour hash).
 * A worker flushes the hour hashes to Postgres every 30 s: RENAME to a flush key, then one transaction that
 * records the key in `summary_flushes` and adds the counts, then DEL. A crash after the RENAME leaves the
 * flush key for the next flush (idle > 60 s); a crash after the commit is caught by `summary_flushes`.
 *
 * Usage: an in-memory LRU, then `SET NX EX 600` in Redis, then a pending set the worker drains, so a
 * version reaches Postgres at most once per 10 minutes across all replicas.
 */

const PUSH_INTERVAL_MS = 5_000;
const HOUR_KEY_TTL_SECONDS = 3 * 86_400;
const FLUSH_IDLE_SECONDS = 60;
const USAGE_LRU_ENTRIES = 50_000;
const USAGE_TTL_MS = 600_000;
const USAGE_BATCH = 1_000;
/** At most this many usage batches per flush, so one run never holds the worker for long. */
const USAGE_BATCHES_PER_FLUSH = 50;
const PACKAGE_COUNTS_DAYS = 31;
/** The pending usage set is drained every 30 s; the TTL only matters if no worker runs for a day. */
const PENDING_TTL_SECONDS = 86_400;

/** `dg:` for a default install; tests and shared Redis instances get the queue prefix in front. */
export function dgKey(name: string): string {
  const prefix = config.jobs.prefix;
  return prefix === 'depgate' ? `dg:${name}` : `${prefix}:dg:${name}`;
}

/** `2026-10-14T10` (UTC). */
export function hourBucket(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 13);
}

function hourStart(bucket: string): Date {
  return new Date(`${bucket}:00:00.000Z`);
}

type Sums = Map<string, Map<string, number>>;

let counts: Sums = new Map();
let packageCounts: Sums = new Map();
const usageSeen = new ByteLru<number>(USAGE_LRU_ENTRIES);
let redisRef: Redis | null = null;
let pushTimer: NodeJS.Timeout | null = null;

function add(sums: Sums, bucket: string, field: string, n: number): void {
  let hour = sums.get(bucket);
  if (!hour) {
    hour = new Map();
    sums.set(bucket, hour);
  }
  hour.set(field, (hour.get(field) ?? 0) + n);
}

/** One download decision in the dashboard counts. No I/O. */
export function countDecision(
  ecosystem: string,
  repository: string | null | undefined,
  packageName: string,
  decision: string,
  at: Date | number = Date.now()
): void {
  const bucket = hourBucket(at);
  add(counts, bucket, JSON.stringify([ecosystem, repository ?? null, decision]), 1);
  add(packageCounts, bucket, JSON.stringify([ecosystem, packageName, decision]), 1);
}

export type UsageKey = {
  ecosystem: string;
  packageName: string;
  version: string;
  repository: string | null;
  sourceRepository: string | null;
  sourceType: string | null;
  decision: 'ALLOW' | 'BLOCK_ENFORCE';
};

function usageField(key: UsageKey): string {
  return JSON.stringify([
    key.ecosystem,
    key.packageName,
    key.version,
    key.repository,
    key.sourceRepository,
    key.sourceType,
    key.decision,
  ]);
}

/**
 * Notes that a version is being downloaded or refused. A repeat within 10 minutes makes no call at all;
 * a miss makes one SET NX, and only a key Redis did not have either is queued for the database.
 */
export function noteUsage(key: UsageKey, now = Date.now()): void {
  const field = usageField(key);
  const until = usageSeen.get(field);
  if (until !== undefined && until > now) return;
  usageSeen.set(field, now + USAGE_TTL_MS, 1);
  const redis = redisRef;
  if (!redis || redis.status !== 'ready') {
    summaryWritesLostTotal.inc({ kind: 'usage' });
    return;
  }
  const hash = createHash('sha1').update(field).digest('hex');
  redis
    .set(dgKey(`usage:${hash}`), '1', 'EX', USAGE_TTL_MS / 1000, 'NX')
    .then((set) => (set === 'OK' ? redis.multi().sadd(dgKey('usage:pending'), field).expire(dgKey('usage:pending'), PENDING_TTL_SECONDS).exec() : null))
    .catch(() => {
      // Let the next download try again instead of waiting out the LRU entry.
      usageSeen.delete(field);
      summaryWritesLostTotal.inc({ kind: 'usage' });
    });
}

/** Sends the in-memory sums to Redis and clears them. Exported for tests and shutdown. */
export async function pushCounts(redis: Redis | null = redisRef): Promise<void> {
  const sums: Array<[string, Sums]> = [
    ['counts', counts],
    ['pkgcounts', packageCounts],
  ];
  counts = new Map();
  packageCounts = new Map();
  const total = sums.reduce((n, [, map]) => n + [...map.values()].reduce((m, hour) => m + hour.size, 0), 0);
  if (total === 0) return;
  if (!redis || redis.status !== 'ready') {
    summaryWritesLostTotal.inc({ kind: 'counts' }, total);
    return;
  }
  const pipeline = redis.pipeline();
  for (const [name, map] of sums) {
    for (const [bucket, fields] of map) {
      const key = dgKey(`${name}:${bucket}`);
      for (const [field, n] of fields) pipeline.hincrby(key, field, n);
      pipeline.expire(key, HOUR_KEY_TTL_SECONDS);
    }
  }
  try {
    const replies = await pipeline.exec();
    const failed = (replies ?? []).filter(([err]) => err).length;
    if (failed) summaryWritesLostTotal.inc({ kind: 'counts' }, failed);
  } catch {
    summaryWritesLostTotal.inc({ kind: 'counts' }, total);
  }
}

/** Every replica: the 5-second push. */
export function startSummaryPusher(redis: Redis): void {
  redisRef = redis;
  if (pushTimer) return;
  pushTimer = setInterval(() => void pushCounts(), PUSH_INTERVAL_MS);
  pushTimer.unref?.();
}

export async function stopSummaryPusher(): Promise<void> {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
  await pushCounts().catch(() => undefined);
  redisRef = null;
}

/** For tests. */
export function resetSummaryState(): void {
  counts = new Map();
  packageCounts = new Map();
  usageSeen.clear();
}

export function pendingCountsForTest(): { counts: Sums; packageCounts: Sums } {
  return { counts, packageCounts };
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

type FlushResult = { hours: number; rows: number; skipped: number; usage: number };

/** The worker's 30-second flush of counts and usage to Postgres. */
export async function flushSummaries(db: DataSource, redis: Redis): Promise<FlushResult> {
  const result: FlushResult = { hours: 0, rows: 0, skipped: 0, usage: 0 };
  for (const name of ['counts', 'pkgcounts'] as const) {
    const flushPrefix = dgKey(`${name}:flush:`);
    // Leftovers of a worker that crashed after its RENAME.
    const leftovers: string[] = [];
    for (const key of await scanKeys(redis, `${flushPrefix}*`)) {
      const idle = Number(await redis.object('IDLETIME', key).catch(() => 0));
      if (idle > FLUSH_IDLE_SECONDS) leftovers.push(key);
    }
    // Every hour key, not only the current one, so an hour that ended during a worker outage is flushed.
    const hourKeys = (await scanKeys(redis, dgKey(`${name}:*`))).filter((key) => !key.startsWith(flushPrefix));
    const taken: string[] = [];
    for (const key of hourKeys) {
      const bucket = key.slice(dgKey(`${name}:`).length);
      const flushKey = `${flushPrefix}${bucket}:${randomUUID()}`;
      try {
        await redis.rename(key, flushKey);
        taken.push(flushKey);
      } catch {
        /* another worker took it */
      }
    }
    for (const flushKey of [...leftovers, ...taken]) {
      const outcome = await flushOne(db, redis, name, flushKey);
      if (outcome === 'skipped') result.skipped += 1;
      else {
        result.hours += 1;
        result.rows += outcome;
      }
    }
  }
  result.usage = await flushUsage(db, redis);
  return result;
}

/** The bucket a flush key holds: `…:flush:2026-10-14T10:<uuid>`. */
function bucketOf(flushKey: string): string | null {
  const match = flushKey.match(/:flush:(\d{4}-\d{2}-\d{2}T\d{2}):[0-9a-f-]{36}$/);
  return match ? match[1] : null;
}

/** One flush key into Postgres, at most once (`summary_flushes`). Exported for tests. */
export async function flushOne(db: DataSource, redis: Redis, name: 'counts' | 'pkgcounts', flushKey: string): Promise<number | 'skipped'> {
  const bucket = bucketOf(flushKey);
  const fields = await redis.hgetall(flushKey);
  if (!bucket || Object.keys(fields).length === 0) {
    await redis.del(flushKey);
    return 0;
  }
  const hour = hourStart(bucket);
  const rows = Object.entries(fields)
    .map(([field, n]) => {
      try {
        return { key: JSON.parse(field) as [string, string | null, string], n: Number(n) };
      } catch {
        return null;
      }
    })
    .filter((row): row is { key: [string, string | null, string]; n: number } => !!row && row.n > 0);
  const tooOld = name === 'pkgcounts' && Date.now() - hour.getTime() > PACKAGE_COUNTS_DAYS * 86_400_000;
  const applied = await db.transaction(async (manager) => {
    const claimed: unknown[] = await manager.query(
      `INSERT INTO summary_flushes (key) VALUES ($1) ON CONFLICT (key) DO NOTHING RETURNING key`,
      [flushKey.slice(-128)]
    );
    if (claimed.length === 0) return false;
    if (rows.length === 0 || tooOld) return true;
    await upsertCounts(manager, name, hour, rows);
    return true;
  });
  await redis.del(flushKey);
  return applied ? rows.length : 'skipped';
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

const UPSERT_CHUNK = 1_000;

/** `count = count + delta`, one statement per 1,000 rows. */
export async function upsertCounts(
  manager: Queryable,
  name: 'counts' | 'pkgcounts',
  hour: Date,
  rows: Array<{ key: [string, string | null, string]; n: number }>
): Promise<void> {
  const table = name === 'counts' ? 'decision_counts_hourly' : 'package_counts_hourly';
  const middle = name === 'counts' ? 'repository' : 'package_name';
  const constraint = name === 'counts' ? 'uq_decision_counts_hourly' : 'uq_package_counts_hourly';
  // Rows with the same key in one statement would make ON CONFLICT fail; merge them first.
  const merged = new Map<string, { key: [string, string | null, string]; n: number }>();
  for (const row of rows) {
    const id = JSON.stringify(row.key);
    const seen = merged.get(id);
    if (seen) seen.n += row.n;
    else merged.set(id, { key: row.key, n: row.n });
  }
  const list = [...merged.values()];
  for (let i = 0; i < list.length; i += UPSERT_CHUNK) {
    const chunk = list.slice(i, i + UPSERT_CHUNK);
    const params: unknown[] = [];
    const values = chunk.map(({ key, n }) => {
      params.push(hour, key[0], key[1], key[2], n);
      const base = params.length - 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await manager.query(
      `INSERT INTO ${table} (hour, ecosystem, ${middle}, decision, count) VALUES ${values.join(', ')}
       ON CONFLICT ON CONSTRAINT ${constraint} DO UPDATE SET count = ${table}.count + EXCLUDED.count`,
      params
    );
  }
}

export type UsageRow = UsageKey & { seenAt?: Date; firstSeenAt?: Date };

/** Upserts usage rows: a new row, or a later `last_seen_at`. */
export async function upsertUsage(manager: Queryable, rows: UsageRow[]): Promise<void> {
  const merged = new Map<string, UsageRow>();
  for (const row of rows) {
    const id = usageField(row);
    const seen = merged.get(id);
    if (!seen) merged.set(id, row);
    else {
      const last = (row.seenAt ?? new Date()).getTime();
      if (last > (seen.seenAt ?? new Date()).getTime()) seen.seenAt = row.seenAt;
      const first = (row.firstSeenAt ?? row.seenAt ?? new Date()).getTime();
      if (first < (seen.firstSeenAt ?? seen.seenAt ?? new Date()).getTime()) seen.firstSeenAt = row.firstSeenAt ?? row.seenAt;
    }
  }
  const list = [...merged.values()];
  for (let i = 0; i < list.length; i += UPSERT_CHUNK) {
    const chunk = list.slice(i, i + UPSERT_CHUNK);
    const params: unknown[] = [];
    const values = chunk.map((row) => {
      const seen = row.seenAt ?? new Date();
      params.push(
        row.ecosystem,
        row.packageName.slice(0, 512),
        row.version.slice(0, 128),
        row.repository,
        row.sourceRepository,
        row.sourceType,
        row.decision,
        row.firstSeenAt ?? seen,
        seen
      );
      const base = params.length - 9;
      return `(${Array.from({ length: 9 }, (_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    await manager.query(
      `INSERT INTO package_usage
         (ecosystem, package_name, version, repository, source_repository, source_type, decision, first_seen_at, last_seen_at)
       VALUES ${values.join(', ')}
       ON CONFLICT ON CONSTRAINT uq_package_usage DO UPDATE SET
         last_seen_at = GREATEST(package_usage.last_seen_at, EXCLUDED.last_seen_at),
         first_seen_at = LEAST(package_usage.first_seen_at, EXCLUDED.first_seen_at)`,
      params
    );
  }
}

async function flushUsage(db: DataSource, redis: Redis): Promise<number> {
  const pendingKey = dgKey('usage:pending');
  let total = 0;
  for (let batch = 0; batch < USAGE_BATCHES_PER_FLUSH; batch += 1) {
    const fields = (await redis.spop(pendingKey, USAGE_BATCH)) as unknown as string[];
    if (!fields || fields.length === 0) break;
    const rows: UsageRow[] = [];
    for (const field of fields) {
      try {
        const [ecosystem, packageName, version, repository, sourceRepository, sourceType, decision] = JSON.parse(field);
        rows.push({ ecosystem, packageName, version, repository, sourceRepository, sourceType, decision });
      } catch {
        /* not ours */
      }
    }
    try {
      await upsertUsage(db, rows);
      total += rows.length;
    } catch (err) {
      // Put them back for the next flush rather than lose them.
      await redis.multi().sadd(pendingKey, ...fields).expire(pendingKey, PENDING_TTL_SECONDS).exec().catch(() => undefined);
      throw err;
    }
    if (fields.length < USAGE_BATCH) break;
  }
  return total;
}
