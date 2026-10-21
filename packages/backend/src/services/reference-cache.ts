import type Redis from 'ioredis';
import {
  EntitySubscriberInterface,
  EventSubscriber,
  type InsertEvent,
  type RemoveEvent,
  type TransactionCommitEvent,
  type TransactionRollbackEvent,
  type UpdateEvent,
} from 'typeorm';
import { config } from '../config.js';
import { ECOSYSTEMS } from './repo-keys.js';

/** Writers bump a generation and publish here. Readers reload when it changes. */
export const REFERENCE_CHANNEL = 'depgate:reference';

const REFRESH_MS = 5000;

type Slot = {
  generation: string;
  checkedAt: number;
  /** A slot older than referenceMaxAgeMs reloads even when its generation still matches. */
  loadedAt: number;
  stale: boolean;
  value: unknown;
};

type ReferenceRedis = {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  duplicate(): Redis;
  on(event: string, listener: (...args: never[]) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  disconnect(): void;
};

const slots = new Map<string, Slot>();
const inflight = new Map<string, Promise<unknown>>();
let publisher: ReferenceRedis | null = null;

export function bindReferencePublisher(redis: ReferenceRedis | null): void {
  publisher = redis;
  slots.clear();
  inflight.clear();
}

export function resetReferenceCache(): void {
  slots.clear();
  inflight.clear();
}

function genKey(kind: string): string {
  return `depgate:gen:${kind}`;
}

export async function bumpReference(kind: string): Promise<void> {
  const mark = () => {
    const slot = slots.get(kind);
    if (slot) slot.stale = true;
  };
  mark();
  const redis = publisher;
  if (!redis) return;
  try {
    const gen = await redis.incr(genKey(kind));
    mark();
    await redis.publish(REFERENCE_CHANNEL, JSON.stringify({ kind, generation: String(gen) }));
  } catch {
    mark();
  }
}

export async function bumpRepositories(ecosystem?: string): Promise<void> {
  if (ecosystem) {
    await bumpReference(`repos:${ecosystem}`);
    return;
  }
  await Promise.all(ECOSYSTEMS.map((eco) => bumpReference(`repos:${eco}`)));
}

function withinMaxAge(slot: Slot, now: number): boolean {
  return now - slot.loadedAt < Math.max(REFRESH_MS, config.gateway.referenceMaxAgeMs);
}

/**
 * Return the in-process value when the Redis generation still matches.
 * A generation check every 5s covers a lost pub/sub message, and a hard maximum
 * age reloads the value even if a bump was never seen.
 * Without a bound Redis client, every call reads the loader (unit tests).
 *
 * `verify` always reads the generation, so a write that has returned is seen at once on
 * every replica, even if its pub/sub message is late or lost. It costs one Redis GET, so
 * it suits interactive reads such as Package check, not every download.
 */
export async function readReference<T>(
  kind: string,
  load: () => Promise<T>,
  opts?: { verify?: boolean }
): Promise<T> {
  const redis = publisher;
  if (!redis || typeof redis.get !== 'function') return load();

  const now = Date.now();
  const slot = slots.get(kind);
  if (!opts?.verify && slot && !slot.stale && now - slot.checkedAt < REFRESH_MS && withinMaxAge(slot, now)) {
    return slot.value as T;
  }

  let gen: string | null;
  try {
    gen = await redis.get(genKey(kind));
  } catch {
    return load();
  }
  const generation = gen ?? '0';
  if (slot && !slot.stale && slot.generation === generation && withinMaxAge(slot, now)) {
    slot.checkedAt = now;
    return slot.value as T;
  }

  const pending = inflight.get(kind);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    const value = await load();
    let current: string;
    try {
      current = (await redis.get(genKey(kind))) ?? '0';
    } catch {
      current = generation;
    }
    const loadedAt = Date.now();
    slots.set(kind, {
      generation: current,
      checkedAt: loadedAt,
      loadedAt,
      stale: current !== generation,
      value,
    });
    return value;
  })();
  inflight.set(kind, promise);
  try {
    return (await promise) as T;
  } finally {
    if (inflight.get(kind) === promise) inflight.delete(kind);
  }
}

/** Keys one kind keeps per generation; the least recently read is dropped first. */
const MAX_ENTRIES = 50_000;

/**
 * One lookup per key, kept until the `kind` generation changes or the reference max age passes.
 * Concurrent misses for a key share one load, and a failed load is not kept. A kept value that
 * `isValid` rejects (one that went out of date by itself, such as an expiry) is loaded again.
 * Kept values are shared by every caller: do not mutate them.
 */
export async function readReferenceEntry<T>(
  kind: string,
  key: string,
  load: () => Promise<T>,
  opts?: { verify?: boolean; isValid?: (value: T) => boolean }
): Promise<T> {
  const entries = await readReference(kind, async () => new Map<string, Promise<unknown>>(), { verify: opts?.verify });
  const kept = entries.get(key) as Promise<T> | undefined;
  if (kept) {
    const value = await kept;
    if (!opts?.isValid || opts.isValid(value)) {
      if (entries.get(key) === kept) {
        entries.delete(key);
        entries.set(key, kept);
      }
      return value;
    }
  }
  const pending = load();
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(key, pending);
  pending.catch(() => {
    if (entries.get(key) === pending) entries.delete(key);
  });
  return pending;
}

type SyncLog = { warn: (err: unknown, msg: string) => void };

/** Mark the local slot stale when another process publishes a new generation. */
export function startReferenceReplication(redis: Redis, log: SyncLog): () => void {
  const sub = redis.duplicate();
  sub.on('error', (err) => log.warn(err, 'Reference cache subscriber error'));
  sub.subscribe(REFERENCE_CHANNEL).catch((err) => log.warn(err, 'Reference cache subscribe failed'));
  sub.on('message', (channel: string, message: string) => {
    if (channel !== REFERENCE_CHANNEL) return;
    try {
      const parsed = JSON.parse(message) as { kind?: string };
      if (!parsed.kind) return;
      const slot = slots.get(parsed.kind);
      if (slot) slot.stale = true;
    } catch {
      /* ignore malformed messages */
    }
  });
  return () => {
    sub.disconnect();
  };
}

type ChangeEvent = {
  metadata: { tableName: string };
  entity?: unknown;
  queryRunner?: { isTransactionActive?: boolean } | null;
};

function ecosystemOf(entity: unknown): string | undefined {
  if (!entity || typeof entity !== 'object') return undefined;
  const eco = (entity as { ecosystem?: unknown }).ecosystem;
  return typeof eco === 'string' ? eco : undefined;
}

export function referenceKindsFor(table: string, entity?: unknown): string[] {
  // Deleting a policy deletes its exceptions through the foreign key.
  if (table === 'policies') return ['policies', 'exceptions'];
  if (table === 'exceptions') return ['exceptions'];
  if (table === 'malicious_packages') return ['malicious'];
  if (table === 'gateway_settings') return ['gateway'];
  if (table === 'users') return ['users'];
  if (table === 'webhook_targets') return ['webhooks'];
  if (table === 'stream_destinations') return ['stream_destinations'];
  if (table === 'package_repositories' || table === 'upstream_registries') {
    const eco = ecosystemOf(entity);
    return eco ? [`repos:${eco}`] : ECOSYSTEMS.map((e) => `repos:${e}`);
  }
  if (table === 'package_repository_members') return ECOSYSTEMS.map((e) => `repos:${e}`);
  return [];
}

/** Bumps waiting for their transaction to commit, keyed by the query runner that owns it. */
const pendingByRunner = new WeakMap<object, Set<string>>();

/**
 * Inside a transaction the new rows are not visible to other connections yet.
 * Bumping now would let another replica reload the old rows under the new
 * generation and keep them, so the bump waits for the commit.
 */
export function noteReferenceWrite(event: ChangeEvent): Promise<void> {
  const kinds = referenceKindsFor(event.metadata.tableName, event.entity);
  if (kinds.length === 0) return Promise.resolve();
  const runner = event.queryRunner;
  if (runner && runner.isTransactionActive) {
    let pending = pendingByRunner.get(runner);
    if (!pending) {
      pending = new Set();
      pendingByRunner.set(runner, pending);
    }
    for (const kind of kinds) pending.add(kind);
    return Promise.resolve();
  }
  return Promise.all(kinds.map((kind) => bumpReference(kind))).then(() => undefined);
}

export function flushReferenceWrites(runner: { isTransactionActive?: boolean } | null | undefined): Promise<void> {
  if (!runner || runner.isTransactionActive) return Promise.resolve();
  const pending = pendingByRunner.get(runner);
  if (!pending) return Promise.resolve();
  pendingByRunner.delete(runner);
  return Promise.all([...pending].map((kind) => bumpReference(kind))).then(() => undefined);
}

export function discardReferenceWrites(runner: { isTransactionActive?: boolean } | null | undefined): void {
  if (!runner || runner.isTransactionActive) return;
  pendingByRunner.delete(runner);
}

/**
 * repository.save/remove notify this. QueryBuilder update/delete does not, so those call bumpReference themselves.
 * TypeORM ignores a class in `subscribers` unless it carries @EventSubscriber().
 */
@EventSubscriber()
export class ReferenceCacheSubscriber implements EntitySubscriberInterface {
  afterInsert(event: InsertEvent<unknown>): Promise<void> {
    return noteReferenceWrite(event);
  }

  afterUpdate(event: UpdateEvent<unknown>): Promise<void> {
    return noteReferenceWrite(event);
  }

  afterRemove(event: RemoveEvent<unknown>): Promise<void> {
    return noteReferenceWrite(event);
  }

  /** Also fires when a savepoint is released; flush only once the outer transaction has committed. */
  afterTransactionCommit(event: TransactionCommitEvent): Promise<void> {
    return flushReferenceWrites(event.queryRunner);
  }

  afterTransactionRollback(event: TransactionRollbackEvent): void {
    discardReferenceWrites(event.queryRunner);
  }
}
