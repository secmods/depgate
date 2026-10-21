import type Redis from 'ioredis';
import { isCacheEcosystem } from './layout.js';
import type { ArtifactCache, CacheLog, CacheStats, PurgeTarget } from './store.js';

/** P2: every pod applies a purge published here to its own disk. */
export const PURGE_CHANNEL = 'acache:purge';
/** The switch in Settings changed: every pod reads it again. */
export const CONTROL_CHANNEL = 'acache:control';
/** S1: one key per live pod, and a set of the pod names that wrote one, so listing them needs no SCAN. */
export const STATUS_PREFIX = 'acache:pod:';
export const PODS_KEY = 'acache:pods';
const STATUS_INTERVAL_MS = 15_000;
const STATUS_TTL_SECONDS = 60;
const MAX_NAME_LENGTH = 512;
const MAX_VERSION_LENGTH = 256;

export type PodStatus = CacheStats & { updatedAt: string };

/** `target` is in the API shape, read back with parsePurgeTarget. */
type PurgeMessage = { origin: string; target: Record<string, unknown> };

/** A purge request from the API or the channel, or null when it is not one. */
export function parsePurgeTarget(raw: unknown): PurgeTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (body.all === true) return { all: true };
  if (!isCacheEcosystem(body.ecosystem)) return null;
  const packageName = typeof body.package === 'string' ? body.package.trim() : '';
  if (!packageName || packageName.length > MAX_NAME_LENGTH) return null;
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  if (version.length > MAX_VERSION_LENGTH) return null;
  return { ecosystem: body.ecosystem, packageName, ...(version ? { version } : {}) };
}

/** The API shape of a target: `{ all: true }` or `{ ecosystem, package, version? }`. */
export function purgeTargetBody(target: PurgeTarget): Record<string, unknown> {
  if ('all' in target) return { all: true };
  return { ecosystem: target.ecosystem, package: target.packageName, ...(target.version ? { version: target.version } : {}) };
}

export function podStatus(cache: ArtifactCache): PodStatus {
  return { ...cache.stats(), updatedAt: new Date().toISOString() };
}

export async function writeStatus(redis: Pick<Redis, 'set' | 'sadd' | 'expire'>, cache: ArtifactCache): Promise<void> {
  await redis.set(`${STATUS_PREFIX}${cache.podName}`, JSON.stringify(podStatus(cache)), 'EX', STATUS_TTL_SECONDS);
  await redis.sadd(PODS_KEY, cache.podName);
  // Every live pod renews it with each report; with no pod left, the set expires like their statuses.
  await redis.expire(PODS_KEY, STATUS_TTL_SECONDS * 2);
}

/**
 * S2: the status every live pod wrote in the last minute, by pod name. A pod in the set whose status has expired
 * (it stopped without a chance to leave) is dropped from the set on the way.
 */
export async function listPodStatuses(redis: Pick<Redis, 'smembers' | 'mget' | 'srem'>): Promise<PodStatus[]> {
  const names = await redis.smembers(PODS_KEY);
  if (names.length === 0) return [];
  const values = await redis.mget(...names.map((name) => `${STATUS_PREFIX}${name}`));
  const pods: PodStatus[] = [];
  const gone: string[] = [];
  values.forEach((value, i) => {
    if (!value) {
      gone.push(names[i]);
      return;
    }
    try {
      pods.push(JSON.parse(value) as PodStatus);
    } catch {
      gone.push(names[i]);
    }
  });
  if (gone.length > 0) await redis.srem(PODS_KEY, ...gone).catch(() => undefined);
  return pods.sort((a, b) => a.pod.localeCompare(b.pod));
}

/** Tells every pod to read the switch in Settings again. Returns how many subscribers received it. */
export async function publishControl(redis: Pick<Redis, 'publish'>): Promise<number> {
  return redis.publish(CONTROL_CHANNEL, '{}');
}

/** Publishes a purge for the other pods. Returns how many subscribers received it. */
export async function publishPurge(redis: Pick<Redis, 'publish'>, cache: ArtifactCache, target: PurgeTarget): Promise<number> {
  const message: PurgeMessage = { origin: cache.instanceId, target: purgeTargetBody(target) };
  return redis.publish(PURGE_CHANNEL, JSON.stringify(message));
}

function describe(target: PurgeTarget): string {
  if ('all' in target) return 'everything';
  return `${target.ecosystem} ${target.packageName}${target.version ? `@${target.version}` : ''}`;
}

/**
 * Status every 15 s (S1), purges published by any pod (P2), and the switch in Settings: `reconcile` applies it
 * when a pod announces a change and before every status write, which covers a missed message. Redis is only a
 * messenger: while it is down the cache keeps serving from disk, and purges published meanwhile do not reach this pod.
 */
export function startArtifactCacheSync(
  cache: ArtifactCache,
  redis: Redis,
  log: CacheLog,
  opts: { statusIntervalMs?: number; reconcile?: () => Promise<void> } = {}
): () => Promise<void> {
  const reconcile = () =>
    (opts.reconcile?.() ?? Promise.resolve()).catch((err: unknown) =>
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Artifact cache could not read its switch')
    );
  const subscriber = redis.duplicate();
  subscriber.on('error', (err) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Artifact cache subscriber error'));
  subscriber
    .subscribe(PURGE_CHANNEL, CONTROL_CHANNEL)
    .catch((err: unknown) => log.warn({ err: String(err) }, 'Artifact cache subscribe failed'));
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel === CONTROL_CHANNEL) {
      void reconcile().then(() => writeStatus(redis, cache).catch(() => undefined));
      return;
    }
    if (channel !== PURGE_CHANNEL) return;
    let message: PurgeMessage | null;
    try {
      message = JSON.parse(raw) as PurgeMessage | null;
    } catch {
      return;
    }
    if (!message || message.origin === cache.instanceId) return;
    const target = parsePurgeTarget(message.target);
    if (!target) return;
    cache.purge(target).then(
      (result) => log.info({ target: describe(target), ...result }, 'Artifact cache purge applied'),
      (err: unknown) => log.warn({ target: describe(target), err: String(err) }, 'Artifact cache purge failed')
    );
  });

  const report = () => reconcile().then(() => writeStatus(redis, cache).catch(() => undefined));
  void report();
  const timer = setInterval(report, opts.statusIntervalMs ?? STATUS_INTERVAL_MS);
  timer.unref();

  return async () => {
    clearInterval(timer);
    subscriber.disconnect();
    await redis.del(`${STATUS_PREFIX}${cache.podName}`).catch(() => undefined);
    await redis.srem(PODS_KEY, cache.podName).catch(() => undefined);
  };
}
