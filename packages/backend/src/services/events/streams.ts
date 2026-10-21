import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { config } from '../../config.js';
import { StreamDestination } from '../../db/entities/StreamDestination.js';
import { readReference } from '../reference-cache.js';
import { scrubError } from '../jobs/ids.js';
import type { WebhookPayload } from '../webhook-service.js';
import { eventKey, HIGH_VOLUME_TYPES, selectedKeys, selects, type EventSelection } from './catalog.js';
import type { EventEnvelope } from './envelope.js';
import { jsonLine } from './destinations/formatters.js';
import { streamDroppedTotal } from './metrics.js';
import { bindPublisher } from './record.js';
import { dgKey } from './summary.js';
import { resolveDestination, type ResolvedDestination } from './destinations/config.js';

/**
 * The producer side of Log Streaming (requirements_event_streaming.md §7, §8.1, §9.6).
 *
 *   dg:events       every event except ALLOW and BLOCK_MONITOR; always written (webhooks read it)
 *   dg:events:bulk  ALLOW and BLOCK_MONITOR, only while an enabled HTTP or Syslog destination selects them
 *
 * Entries carry `t` (the selection key: the type, or `JOB_*:<job>`), `f` (feature), `e` (the envelope JSON)
 * and, on webhook events, `w` (today's webhook payload). The producer has its own connection with no offline
 * queue, so an XADD while Redis is down fails at once (R-D16) and webhooks fall back to inline delivery (W6).
 * JSON lines is written to standard output by every replica, without Redis.
 */

export const MAIN_STREAM_MAX_LEN = 100_000;
const SELECTION_REFRESH_MS = 3_000;
/** Above this much unwritten output, JSON lines drops events instead of growing memory. */
const STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;

export function streamKey(stream: 'main' | 'bulk'): string {
  return stream === 'main' ? dgKey('events') : dgKey('events:bulk');
}

export type Log = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type Snapshot = {
  /** ALLOW / BLOCK_MONITOR keys some enabled HTTP or Syslog destination selects. */
  bulk: Set<string>;
  /** The JSON lines destination's selection, if one is enabled. */
  jsonl: EventSelection | null;
};

let producer: Redis | null = null;
let dbRef: DataSource | null = null;
let logRef: Log | null = null;
let snapshot: Snapshot = { bulk: new Set(), jsonl: null };
let refreshTimer: NodeJS.Timeout | null = null;
let inlineFallback: ((db: DataSource, payload: WebhookPayload) => Promise<void>) | null = null;
let lastFailureLogAt = 0;

/** Every destination, decrypted, cached like policies and invalidated through `depgate:reference`. */
export function loadDestinations(db: DataSource): Promise<ResolvedDestination[]> {
  return readReference('stream_destinations', async () =>
    (await db.getRepository(StreamDestination).find({ order: { createdAt: 'ASC' } })).map(resolveDestination)
  );
}

/** Which streams a selection needs a consumer group on. */
export function streamsFor(selection: EventSelection): Array<'main' | 'bulk'> {
  const keys = selectedKeys(selection);
  const out: Array<'main' | 'bulk'> = [];
  if ([...keys].some((key) => !HIGH_VOLUME_TYPES.has(key))) out.push('main');
  if ([...keys].some((key) => HIGH_VOLUME_TYPES.has(key))) out.push('bulk');
  return out;
}

export function computeSnapshot(destinations: ResolvedDestination[]): Snapshot {
  const bulk = new Set<string>();
  let jsonl: EventSelection | null = null;
  for (const dest of destinations) {
    if (!dest.enabled) continue;
    if (dest.type === 'jsonl') {
      jsonl = dest.selection;
      continue;
    }
    for (const key of HIGH_VOLUME_TYPES) {
      const feature = key === 'ALLOW' ? 'decisions' : 'monitoring';
      if (selects(dest.selection, feature, key)) bulk.add(key);
    }
  }
  return { bulk, jsonl };
}

/** Re-reads the selection now; called after a destination is saved, and every few seconds. */
export async function refreshSelection(): Promise<void> {
  if (!dbRef) return;
  try {
    snapshot = computeSnapshot(await loadDestinations(dbRef));
  } catch (err) {
    logRef?.warn({ err: scrubError(String((err as Error)?.message ?? err)) }, 'Could not read Log Streaming destinations');
  }
}

/** For tests. */
export function setSnapshotForTest(next: Snapshot): void {
  snapshot = next;
}

function writeJsonLine(json: string): void {
  if (process.stdout.writableLength > STDOUT_LIMIT_BYTES) {
    streamDroppedTotal.inc({ destination: 'jsonl', reason: 'local_write' });
    return;
  }
  process.stdout.write(jsonLine(json));
}

function withActor(payload: WebhookPayload, envelope: EventEnvelope): WebhookPayload {
  const actor = envelope.actor;
  if (!actor || actor.kind === 'system' || payload.event === 'namespace_collision') return payload;
  const view: Record<string, unknown> = {};
  if (actor.name) view.name = actor.name;
  if (actor.ip) view.ip = actor.ip;
  if (actor.userAgent) view.userAgent = actor.userAgent;
  if (actor.metadata && Object.keys(actor.metadata).length) view.metadata = actor.metadata;
  return Object.keys(view).length ? { ...payload, actor: view } : payload;
}

function fallback(envelope: EventEnvelope, payload: WebhookPayload | undefined): void {
  if (!payload || !dbRef || !inlineFallback) return;
  void inlineFallback(dbRef, withActor(payload, envelope)).catch(() => undefined);
}

function logFailure(err: unknown): void {
  const now = Date.now();
  if (now - lastFailureLogAt < 60_000) return;
  lastFailureLogAt = now;
  logRef?.warn({ err: scrubError(String((err as Error)?.message ?? err)) }, 'Event stream unavailable; streaming events are lost and counted, webhooks are sent inline');
}

/** The publisher bound into recordEvent. Fixed work per event, nothing awaited (L1–L3). */
export function publish(envelope: EventEnvelope, json: string, webhookPayload?: WebhookPayload): void {
  const job = envelope.category === 'job' ? (envelope.target?.name ?? undefined) : undefined;
  const key = eventKey(envelope.type, job);
  if (snapshot.jsonl && selects(snapshot.jsonl, envelope.feature, key)) writeJsonLine(json);

  const highVolume = HIGH_VOLUME_TYPES.has(envelope.type);
  if (highVolume && !snapshot.bulk.has(envelope.type)) return;
  const redis = producer;
  if (!redis || redis.status !== 'ready') {
    if (redis) streamDroppedTotal.inc({ destination: '*', reason: 'redis_unavailable' });
    fallback(envelope, webhookPayload);
    return;
  }
  const args: string[] = highVolume
    ? [streamKey('bulk'), 'MAXLEN', '~', String(config.events.streamMaxLen), '*', 't', key, 'f', envelope.feature, 'e', json]
    : [streamKey('main'), 'MAXLEN', '~', String(MAIN_STREAM_MAX_LEN), '*', 't', key, 'f', envelope.feature, 'e', json];
  if (!highVolume && webhookPayload) args.push('w', JSON.stringify(withActor(webhookPayload, envelope)));
  (redis.xadd as (...a: string[]) => Promise<string | null>)(...args).catch((err) => {
    streamDroppedTotal.inc({ destination: '*', reason: 'redis_unavailable' });
    logFailure(err);
    fallback(envelope, webhookPayload);
  });
}

export function eventsProducer(): Redis | null {
  return producer;
}

/** Starts the producer on every replica (API and worker). */
export async function startEventProducer(opts: {
  db: DataSource;
  log: Log;
  url?: string;
  inlineWebhooks: (db: DataSource, payload: WebhookPayload) => Promise<void>;
}): Promise<void> {
  dbRef = opts.db;
  logRef = opts.log;
  inlineFallback = opts.inlineWebhooks;
  producer = new Redis(opts.url ?? config.jobs.redisUrl, {
    protocol: 2,
    enableOfflineQueue: false,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 1,
    // Reconnect forever, at most every 5 s.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  producer.on('error', (err) => logFailure(err));
  await new Promise<void>((resolve) => {
    if (producer!.status === 'ready') return resolve();
    const done = () => resolve();
    producer!.once('ready', done);
    setTimeout(done, 3_000).unref?.();
  });
  bindPublisher(publish);
  await refreshSelection();
  refreshTimer = setInterval(() => void refreshSelection(), SELECTION_REFRESH_MS);
  refreshTimer.unref?.();
}

export async function stopEventProducer(): Promise<void> {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  bindPublisher(null);
  const current = producer;
  producer = null;
  if (current) {
    await current.quit().catch(() => current.disconnect());
  }
  dbRef = null;
}

/** Binds only the inline webhook path and JSON lines (no Redis): tests and `skipInfra` runs. */
export function bindPublisherWithoutRedis(db: DataSource, inlineWebhooks: (db: DataSource, payload: WebhookPayload) => Promise<void>): void {
  dbRef = db;
  inlineFallback = inlineWebhooks;
  bindPublisher(publish);
}

/** Redis 7.0 or later (D17): stream lag and loss counting need XINFO's entries-added and entries-read. */
export async function checkRedisVersion(redis: Pick<Redis, 'info'>): Promise<string> {
  const info = await redis.info('server');
  const version = info.match(/^redis_version:([\d.]+)/m)?.[1] ?? '0';
  const major = Number(version.split('.')[0]);
  if (!(major >= 7)) {
    throw new Error(`Redis ${version} is not supported: DepGate needs Redis 7.0 or later (Log Streaming loss counting uses Redis 7 stream counters)`);
  }
  return version;
}

/** For tests: a stand-in producer connection, database and inline webhook path. */
export function useProducerForTest(
  redis: Pick<Redis, 'status' | 'xadd'> | null,
  db: DataSource | null = null,
  inlineWebhooks: ((db: DataSource, payload: WebhookPayload) => Promise<void>) | null = null
): void {
  producer = redis as Redis | null;
  dbRef = db;
  inlineFallback = inlineWebhooks;
  bindPublisher(publish);
}
