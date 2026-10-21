import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Redis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCache } from './store.js';
import {
  CONTROL_CHANNEL,
  PODS_KEY,
  PURGE_CHANNEL,
  STATUS_PREFIX,
  listPodStatuses,
  parsePurgeTarget,
  publishControl,
  publishPurge,
  startArtifactCacheSync,
  writeStatus,
} from './sync.js';
import type { ArtifactRef } from './layout.js';

/** Redis for two or more pods in one process: keys with TTLs, sets, and a shared pub/sub bus. */
function fakeRedisCluster() {
  const data = new Map<string, { value: string; ttl: number | null }>();
  const sets = new Map<string, Set<string>>();
  const setTtls = new Map<string, number>();
  const bus = new EventEmitter();
  const make = (): Redis => {
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const channels = new Set<string>();
    const deliver = (channel: string, message: string) => {
      if (channels.has(channel)) client.emit('message', channel, message);
    };
    Object.assign(client, {
      async set(key: string, value: string, ...args: Array<string | number>) {
        const ex = args.indexOf('EX');
        data.set(key, { value, ttl: ex >= 0 ? Number(args[ex + 1]) : null });
        return 'OK';
      },
      async del(key: string) {
        return data.delete(key) ? 1 : 0;
      },
      async sadd(key: string, ...members: string[]) {
        const set = sets.get(key) ?? new Set<string>();
        sets.set(key, set);
        const before = set.size;
        for (const member of members) set.add(member);
        return set.size - before;
      },
      async smembers(key: string) {
        return [...(sets.get(key) ?? [])];
      },
      async expire(key: string, seconds: number) {
        setTtls.set(key, seconds);
        return sets.has(key) || data.has(key) ? 1 : 0;
      },
      async srem(key: string, ...members: string[]) {
        const set = sets.get(key);
        if (!set) return 0;
        return members.filter((member) => set.delete(member)).length;
      },
      async mget(...keys: string[]) {
        return keys.map((key) => data.get(key)?.value ?? null);
      },
      async publish(channel: string, message: string) {
        const receivers = bus.listenerCount(channel);
        bus.emit(channel, message);
        return receivers;
      },
      async subscribe(...names: string[]) {
        for (const channel of names) {
          channels.add(channel);
          bus.on(channel, (message: string) => deliver(channel, message));
        }
        return names.length;
      },
      duplicate: () => make(),
      disconnect() {
        bus.removeAllListeners(PURGE_CHANNEL);
        bus.removeAllListeners(CONTROL_CHANNEL);
      },
    });
    return client as unknown as Redis;
  };
  return { data, sets, setTtls, make };
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

async function pod(name: string): Promise<ArtifactCache> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `depgate-acache-${name}-`));
  dirs.push(dir);
  const cache = new ArtifactCache({
    enabled: true,
    dir,
    maxSizeBytes: 10_000_000,
    maxFiles: 100,
    maxAgeMs: 0,
    maxIdleMs: 0,
    maxFileBytes: 1_000_000,
    podName: name,
  });
  await cache.start();
  await cache.idle();
  return cache;
}

const REF: ArtifactRef = {
  ecosystem: 'npm',
  packageName: 'left-pad',
  version: '1.3.0',
  path: 'left-pad/-/left-pad-1.3.0.tgz',
  remote: { id: 'pub', key: 'default', url: 'https://registry.npmjs.org', source: 'public' },
};

async function storeOn(cache: ArtifactCache): Promise<void> {
  const res = await cache.fill(REF, Readable.from([Buffer.from('pad')]), { contentType: 'x', contentLength: 3 });
  for await (const _chunk of res.body) void _chunk;
  await cache.idle();
}

describe('parsePurgeTarget', () => {
  it.each([
    [{ all: true }, { all: true }],
    [{ ecosystem: 'npm', package: 'lodash' }, { ecosystem: 'npm', packageName: 'lodash' }],
    [{ ecosystem: 'pypi', package: ' requests ', version: ' 2.0 ' }, { ecosystem: 'pypi', packageName: 'requests', version: '2.0' }],
    [{ ecosystem: 'npm', package: 'x', version: '' }, { ecosystem: 'npm', packageName: 'x' }],
  ])('accepts %j', (body, expected) => {
    expect(parsePurgeTarget(body)).toEqual(expected);
  });

  it.each([null, 'all', {}, { all: 'yes' }, { ecosystem: 'apt', package: 'x' }, { ecosystem: 'npm' }, { ecosystem: 'npm', package: '  ' }, { ecosystem: 'npm', package: 'x'.repeat(600) }])(
    'refuses %j',
    (body) => {
      expect(parsePurgeTarget(body)).toBeNull();
    }
  );
});

describe('artifact cache sync over Redis', () => {
  it('S1: writes each pod\'s status with a 60 s TTL, and lists live pods', async () => {
    const { data, sets, setTtls, make } = fakeRedisCluster();
    const redis = make();
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    await writeStatus(redis, b);
    await writeStatus(redis, a);
    expect(data.get(`${STATUS_PREFIX}pod-a`)?.ttl).toBe(60);
    expect(setTtls.get(PODS_KEY), 'the pod set expires once no pod renews it').toBe(120);
    // A pod that died without leaving: in the set, its status expired.
    await redis.sadd(PODS_KEY, 'pod-gone');
    const pods = await listPodStatuses(redis);
    expect(pods.map((p) => p.pod)).toEqual(['pod-a', 'pod-b']);
    expect(pods[0]).toMatchObject({ state: 'ok', files: 0, maxFiles: 100, hits24h: 0, misses24h: 0 });
    expect([...sets.get(PODS_KEY)!].sort()).toEqual(['pod-a', 'pod-b']);
  });

  it('P2: a purge published by one pod is applied by every other pod, and not twice by the sender', async () => {
    const { make } = fakeRedisCluster();
    const a = await pod('pod-a');
    const b = await pod('pod-b');
    const stopA = startArtifactCacheSync(a, make(), log, { statusIntervalMs: 60_000 });
    const stopB = startArtifactCacheSync(b, make(), log, { statusIntervalMs: 60_000 });
    try {
      await storeOn(a);
      await storeOn(b);
      const purgeA = vi.spyOn(a, 'purge');
      const target = { ecosystem: 'npm' as const, packageName: 'left-pad' };
      await a.purge(target);
      const receivers = await publishPurge(make(), a, target);
      expect(receivers).toBe(2);
      await vi.waitFor(async () => expect(await b.lookup(REF)).toBeNull());
      expect(await a.lookup(REF)).toBeNull();
      expect(purgeA).toHaveBeenCalledTimes(1);
    } finally {
      await stopA();
      await stopB();
    }
  });

  it('a switch announced by one pod is applied by the others, and reported in their status', async () => {
    const { data, make } = fakeRedisCluster();
    const b = await pod('pod-b');
    let saved: boolean | null = null;
    const reconcile = vi.fn(async () => {
      const wanted = saved ?? true;
      if (wanted !== b.enabled) await b.setEnabled(wanted);
    });
    const stop = startArtifactCacheSync(b, make(), log, { statusIntervalMs: 60_000, reconcile });
    try {
      await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
      expect(b.state).toBe('ok');
      saved = false;
      expect(await publishControl(make())).toBe(1);
      await vi.waitFor(() => expect(b.state).toBe('off'));
      await vi.waitFor(() => expect(JSON.parse(data.get(`${STATUS_PREFIX}pod-b`)!.value)).toMatchObject({ state: 'off', enabled: false }));
    } finally {
      await stop();
    }
  });

  it('ignores a malformed message', async () => {
    const { make } = fakeRedisCluster();
    const b = await pod('pod-b');
    const stop = startArtifactCacheSync(b, make(), log, { statusIntervalMs: 60_000 });
    try {
      await storeOn(b);
      const purge = vi.spyOn(b, 'purge');
      const sender = make();
      await sender.publish(PURGE_CHANNEL, 'not json');
      await sender.publish(PURGE_CHANNEL, JSON.stringify({ origin: 'x', target: { ecosystem: '../etc', package: 'p' } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(purge).not.toHaveBeenCalled();
      expect(await b.lookup(REF)).not.toBeNull();
    } finally {
      await stop();
    }
  });

  it('removes the pod\'s status when it stops', async () => {
    const { data, sets, make } = fakeRedisCluster();
    const a = await pod('pod-a');
    const stop = startArtifactCacheSync(a, make(), log, { statusIntervalMs: 60_000 });
    await vi.waitFor(() => expect(data.has(`${STATUS_PREFIX}pod-a`)).toBe(true));
    expect(sets.get(PODS_KEY)?.has('pod-a')).toBe(true);
    await stop();
    expect(data.has(`${STATUS_PREFIX}pod-a`)).toBe(false);
    expect(sets.get(PODS_KEY)?.has('pod-a')).toBe(false);
  });
});
