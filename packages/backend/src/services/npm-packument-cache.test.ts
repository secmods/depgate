import { gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import { withPlainRoutes } from '../test-support/plain-route.js';

const fetchFromUpstream = vi.fn();

vi.mock('./upstream-provider.js', () => ({
  fetchFromUpstream: (...args: unknown[]) => fetchFromUpstream(...args),
}));

vi.mock('./repository-resolve.js', () => ({
  resolveRemoteTargets: vi.fn(async () => [{ id: 'npmjs' }]),
}));

vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

import { getNpmVersionInfo, getPackument, npmCacheKeys, npmDeclaredLicense, resetNpmMemoryCache } from './npm-packument.js';
import { config } from '../config.js';

const db = {} as DataSource;
const gateway = config.gateway.baseUrl.replace(/\/$/, '');

const upstreamDoc = {
  name: 'lodash',
  readme: 'long readme',
  'dist-tags': { latest: '1.0.0' },
  time: { created: '2020-01-01T00:00:00.000Z', '0.9.0': '2020-01-01T00:00:00.000Z', '1.0.0': '2021-02-20T15:42:16.891Z' },
  versions: {
    '0.9.0': {
      name: 'lodash',
      version: '0.9.0',
      license: { type: 'MIT' },
      dist: { tarball: 'https://registry.npmjs.org/lodash/-/lodash-0.9.0.tgz', integrity: 'sha512-old' },
    },
    '1.0.0': {
      name: 'lodash',
      version: '1.0.0',
      readme: 'long readme',
      license: 'MIT',
      dist: {
        tarball: 'https://registry.npmjs.org/lodash/-/lodash-1.0.0.tgz',
        integrity: 'sha512-abc',
      },
    },
  },
};

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function setup() {
  const memory = createMemoryRedis();
  return { memory, redis: memory as unknown as Redis };
}

describe('npm packument cache', () => {
  beforeEach(() => {
    resetNpmMemoryCache();
    fetchFromUpstream.mockReset();
    fetchFromUpstream.mockResolvedValue({ status: 200, body: upstreamDoc });
  });

  it('fetches once, stores rewritten JSON and gzip, and serves later hits from process memory', async () => {
    const { memory, redis } = setup();
    const first = await getPackument(db, redis, 'lodash');
    memory.calls.length = 0;
    const second = await getPackument(db, redis, 'lodash');

    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
    expect(first.body.versions?.['1.0.0'].dist?.tarball).toBe(`${gateway}/npm/lodash/-/lodash-1.0.0.tgz`);
    expect(second.json).toBe(first.json);
    expect(second.cacheId).toBe(first.cacheId);
    // Only the small metadata field crosses the wire on a hit this process has seen.
    expect(memory.calls.filter((call) => call.startsWith('hmgetBuffer'))).toHaveLength(0);

    const keys = npmCacheKeys('lodash', 'default');
    const json = gunzipSync(memory.hashField(keys.full, 'g')!).toString('utf8');
    expect(json).toBe(memory.hashField(keys.full, 'j')!.toString('utf8'));
    expect(JSON.parse(json).readme).toBe('long readme');
  });

  it('reads the stored body once when another process wrote it', async () => {
    const { memory, redis } = setup();
    await getPackument(db, redis, 'lodash');
    resetNpmMemoryCache();
    memory.calls.length = 0;
    const hit = await getPackument(db, redis, 'lodash');
    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
    expect(hit.body.versions?.['1.0.0']).toBeDefined();
    expect(memory.calls.filter((call) => call.startsWith('hmgetBuffer'))).toHaveLength(1);
  });

  it('keeps the time map in the abbreviated variant so release-age rules can filter it', async () => {
    const { redis } = setup();
    const abbreviated = await getPackument(db, redis, 'lodash', undefined, { abbreviated: true });
    await getPackument(db, redis, 'lodash', undefined, { abbreviated: true });

    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
    expect(abbreviated.body.readme).toBeUndefined();
    expect(abbreviated.body.time?.['1.0.0']).toBe(upstreamDoc.time['1.0.0']);
    expect(abbreviated.body.versions?.['1.0.0'].dist?.tarball).toBe(`${gateway}/npm/lodash/-/lodash-1.0.0.tgz`);
  });

  it('gives concurrent full and abbreviated misses their own variant from one fetch', async () => {
    const { redis } = setup();
    const upstream = gate();
    fetchFromUpstream.mockImplementation(() => upstream.promise.then(() => ({ status: 200, body: upstreamDoc })));

    const pending = Promise.all([
      getPackument(db, redis, 'lodash', undefined, { abbreviated: true }),
      getPackument(db, redis, 'lodash'),
    ]);
    await vi.waitFor(() => expect(fetchFromUpstream).toHaveBeenCalledTimes(1));
    upstream.release();
    const [abbreviated, full] = await pending;

    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
    expect(abbreviated.body.readme).toBeUndefined();
    expect(full.body.readme).toBe('long readme');
    expect(full.body.time?.['1.0.0']).toBe(upstreamDoc.time['1.0.0']);
  });

  it('shares one upstream fetch across concurrent misses', async () => {
    const { redis } = setup();
    const upstream = gate();
    fetchFromUpstream.mockImplementation(() => upstream.promise.then(() => ({ status: 200, body: upstreamDoc })));

    const pending = Promise.all([getPackument(db, redis, 'left-pad'), getPackument(db, redis, 'left-pad')]);
    await vi.waitFor(() => expect(fetchFromUpstream).toHaveBeenCalledTimes(1));
    upstream.release();
    const [a, b] = await pending;
    expect(b.json).toBe(a.json);
    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
  });

  it('serves a stale packument while one refresh replaces it', async () => {
    const { memory, redis } = setup();
    await getPackument(db, redis, 'lodash');
    const keys = npmCacheKeys('lodash', 'default');
    const meta = JSON.parse(memory.hashField(keys.full, 'm')!.toString('utf8')) as { etag: string };
    await memory.hset(keys.full, { m: JSON.stringify({ etag: meta.etag, freshUntil: Date.now() - 1000 }) });

    const upstream = gate();
    const newer = { ...upstreamDoc, 'dist-tags': { latest: '2.0.0' } };
    fetchFromUpstream.mockReset();
    fetchFromUpstream.mockImplementation(() => upstream.promise.then(() => ({ status: 200, body: newer })));

    const served = await getPackument(db, redis, 'lodash');
    expect(served.body['dist-tags']?.latest).toBe('1.0.0');
    await vi.waitFor(() => expect(fetchFromUpstream).toHaveBeenCalledTimes(1));
    upstream.release();
    await vi.waitFor(async () => {
      const next = await getPackument(db, redis, 'lodash');
      expect(next.body['dist-tags']?.latest).toBe('2.0.0');
    });
    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
  });

  it('still serves an entry written in the previous string format', async () => {
    const { memory, redis } = setup();
    await memory.set(
      'npm:packument:seeded',
      JSON.stringify({
        name: 'seeded',
        versions: {
          '1.0.0': { dist: { tarball: 'http://localhost:3050/npm/seeded/-/seeded-1.0.0.tgz', integrity: 'sha512-SEEDED' } },
        },
      })
    );
    const hit = await getPackument(db, redis, 'seeded');
    expect(fetchFromUpstream).not.toHaveBeenCalled();
    expect(hit.body.versions?.['1.0.0'].dist?.integrity).toBe('sha512-SEEDED');
  });

  it('remembers an upstream failure so the next miss does not call upstream again', async () => {
    const { redis } = setup();
    fetchFromUpstream.mockResolvedValue({ status: 503, body: {} });
    const first = await getPackument(db, redis, 'flaky');
    const second = await getPackument(db, redis, 'flaky');
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(fetchFromUpstream).toHaveBeenCalledTimes(1);
  });

  it('returns at once when the replica holding the lock records an error', async () => {
    const { memory, redis } = setup();
    const keys = npmCacheKeys('busy', 'default');
    await memory.set(keys.lock, 'other-replica', 'EX', 30);
    setTimeout(() => {
      void memory.setex(keys.error, 5, JSON.stringify({ message: 'All upstream registries failed' }));
      void memory.del(keys.lock);
    }, 60);

    const started = Date.now();
    await expect(getPackument(db, redis, 'busy')).rejects.toThrow('All upstream registries failed');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchFromUpstream).not.toHaveBeenCalled();
  });

  it('answers a tarball lookup from the per-version index without reading the packument', async () => {
    const { memory, redis } = setup();
    await getPackument(db, redis, 'lodash');
    resetNpmMemoryCache();
    memory.calls.length = 0;

    const info = await getNpmVersionInfo(db, redis, 'lodash', '0.9.0');
    expect(info.status).toBe(200);
    expect(info.versionMeta?.license).toBe('MIT');
    expect(info.versionMeta?.time).toBe(upstreamDoc.time['0.9.0']);
    expect(info.packageLastReleaseAt).toBe(upstreamDoc.time['1.0.0']);
    expect(memory.calls.some((call) => call.startsWith('hmgetBuffer') || call.startsWith('hget '))).toBe(false);
  });
});

describe('npmDeclaredLicense', () => {
  it('reads the legacy licenses array as MIT, and joins several with OR', () => {
    expect(npmDeclaredLicense({ licenses: [{ type: 'MIT', url: 'http://example' }] })).toBe('MIT');
    expect(npmDeclaredLicense({ licenses: ['MIT', { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
    expect(npmDeclaredLicense({ license: 'ISC', licenses: [{ type: 'MIT' }] })).toBe('ISC');
    expect(npmDeclaredLicense({})).toBeUndefined();
  });
});
