import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCache, type ArtifactCacheOptions, type EntryMeta } from './store.js';
import { locate, packageHash, type ArtifactRef } from './layout.js';
import { artifactCacheEvictedTotal, artifactCacheRequestsTotal } from './metrics.js';
import type { RemoteTarget } from '../repository-resolve.js';

const PUBLIC: RemoteTarget = {
  id: 'pub-1',
  key: 'default',
  url: 'https://registry.example.org',
  timeoutMs: 1000,
  retryCount: 0,
  authType: null,
  authEncrypted: null,
  source: 'public',
};
const INTERNAL: RemoteTarget = { ...PUBLIC, id: 'int-1', key: 'corp', url: 'https://corp.example.org', source: 'internal' };
const MB = 1024 * 1024;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs: string[] = [];
const caches: ArtifactCache[] = [];

afterEach(async () => {
  for (const cache of caches.splice(0)) {
    await cache.idle();
    await cache.close();
  }
  for (const dir of dirs.splice(0)) {
    await fsp.chmod(dir, 0o700).catch(() => undefined);
    await fsp.chmod(path.join(dir, 'tmp'), 0o700).catch(() => undefined);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-'));
  dirs.push(dir);
  return dir;
}

async function makeCache(over: Partial<ArtifactCacheOptions> = {}): Promise<ArtifactCache> {
  const cache = new ArtifactCache({
    enabled: true,
    dir: over.dir ?? (await tempDir()),
    maxSizeBytes: 100 * MB,
    maxFiles: 1000,
    maxAgeMs: 0,
    maxIdleMs: 0,
    maxFileBytes: 10 * MB,
    ...over,
  });
  caches.push(cache);
  await cache.start();
  await cache.idle();
  return cache;
}

function ref(name = 'pkg', version = '1.0.0', over: Partial<ArtifactRef> = {}): ArtifactRef {
  return { ecosystem: 'npm', packageName: name, version, path: `${name}/-/${name}-${version}.tgz`, remote: PUBLIC, ...over };
}

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function store(cache: ArtifactCache, r: ArtifactRef, bytes: Buffer, contentLength: number | null = bytes.length) {
  const res = await cache.fill(r, Readable.from([bytes]), { contentType: 'application/x-test', contentLength });
  const served = await read(res.body);
  await cache.idle();
  return { result: res.result, served };
}

async function hitBytes(cache: ArtifactCache, r: ArtifactRef): Promise<Buffer | null> {
  const hit = await cache.lookup(r);
  return hit ? read(hit.stream) : null;
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false
  );
}

async function tmpFiles(cache: ArtifactCache): Promise<string[]> {
  return (await fsp.readdir(path.join(cache.root, 'tmp'))).filter((name) => !name.startsWith('.'));
}

function counter(metric: typeof artifactCacheEvictedTotal | typeof artifactCacheRequestsTotal, labels: Record<string, string>) {
  return async () => {
    const values = (await metric.get()).values;
    return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;
  };
}

/** A body that sends one chunk and then fails, like an upstream that drops the connection. */
function droppingBody(first: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
      } else {
        this.destroy(new Error('terminated'));
      }
    },
  });
}

describe('ArtifactCache start-up', () => {
  it('is off when disabled, and never stores', async () => {
    const cache = await makeCache({ enabled: false });
    expect(cache.state).toBe('off');
    const { result } = await store(cache, ref(), Buffer.from('x'));
    expect(result).toBe('BYPASS');
    expect(await cache.lookup(ref())).toBeNull();
  });

  it('turns itself off with an error when the directory is missing, and still serves', async () => {
    const parent = await tempDir();
    const cache = await makeCache({ dir: path.join(parent, 'missing') });
    expect(cache.state).toBe('error');
    expect(cache.lastError).toMatch(/does not exist/);
    const { result, served } = await store(cache, ref(), Buffer.from('payload'));
    expect(result).toBe('BYPASS');
    expect(served.toString()).toBe('payload');
    expect(await exists(path.join(parent, 'missing'))).toBe(false);
  });

  it.skipIf(isRoot)('turns itself off when the directory is not writable', async () => {
    const dir = await tempDir();
    await fsp.chmod(dir, 0o500);
    const cache = await makeCache({ dir });
    expect(cache.state).toBe('error');
    expect(cache.lastError).toMatch(/cannot be used/);
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('BYPASS');
  });

  it('L5: empties tmp/, deletes unpaired files and recounts, while serving at once', async () => {
    const dir = await tempDir();
    const first = await makeCache({ dir });
    await store(first, ref('kept'), Buffer.alloc(300, 1));
    await store(first, ref('lost-json'), Buffer.alloc(50, 2));
    await store(first, ref('lost-data'), Buffer.alloc(70, 3));
    await first.close();
    const lostJson = locate(first.root, ref('lost-json'));
    const lostData = locate(first.root, ref('lost-data'));
    await fsp.unlink(lostJson.metaPath);
    await fsp.unlink(lostData.dataPath);
    // Left over from an earlier run: old enough that they cannot be a commit in progress.
    const earlier = new Date(Date.now() - 120_000);
    await fsp.utimes(lostJson.dataPath, earlier, earlier);
    await fsp.utimes(lostData.metaPath, earlier, earlier);
    await fsp.writeFile(path.join(dir, 'tmp', 'partial-fill'), 'half');
    await fsp.mkdir(path.join(dir, 'tmp', 'purge-old', 'v1'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'tmp', 'purge-old', 'v1', 'x'), 'x');

    const cache = new ArtifactCache({ ...first.opts, dir });
    caches.push(cache);
    await cache.start();
    expect(cache.state).toBe('ok');
    await cache.idle();

    expect(await tmpFiles(cache)).toEqual([]);
    expect(await exists(lostJson.dataPath)).toBe(false);
    expect(await exists(lostData.metaPath)).toBe(false);
    expect((await hitBytes(cache, ref('kept')))?.length).toBe(300);
    expect(cache.stats()).toMatchObject({ files: 1, sizeBytes: 300 });
  });
});

describe('ArtifactCache switched on and off at runtime', () => {
  it('a pod with disk but switched off can be switched on, and then stores and serves', async () => {
    const cache = await makeCache({ enabled: false });
    expect(cache.state).toBe('off');
    expect(cache.available).toBe(true);
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('BYPASS');
    await cache.setEnabled(true);
    expect(cache.state).toBe('ok');
    expect((await store(cache, ref(), Buffer.from('stored'))).result).toBe('MISS');
    expect((await hitBytes(cache, ref()))?.toString()).toBe('stored');
  });

  it('switched off: no hits and no fills; files stay, expire, can be purged, and serve again when switched back on', async () => {
    let clock = Date.now();
    const cache = await makeCache({ maxAgeMs: 30 * 86_400_000, now: () => clock });
    await store(cache, ref('kept'), Buffer.from('kept'));
    await store(cache, ref('purged'), Buffer.from('purged'));
    await cache.setEnabled(false);
    expect(cache.state).toBe('off');
    expect(cache.stats()).toMatchObject({ enabled: false, available: true, files: 2 });
    expect(await cache.lookup(ref('kept'))).toBeNull();
    expect((await store(cache, ref('new'), Buffer.from('n'))).result).toBe('BYPASS');
    expect(await cache.purge({ ecosystem: 'npm', packageName: 'purged' })).toEqual({ files: 1, bytes: 6 });

    await cache.setEnabled(true);
    expect((await hitBytes(cache, ref('kept')))?.toString()).toBe('kept');

    await cache.setEnabled(false);
    clock += 31 * 86_400_000;
    const old = new Date(Date.now() - 31 * 86_400_000);
    await fsp.utimes(locate(cache.root, ref('kept')).dataPath, old, old);
    expect((await cache.evict()).expired).toBe(1);
  });

  it('cannot be switched on without a size per pod, and says why', async () => {
    const cache = await makeCache({ enabled: false, maxSizeBytes: 0 });
    expect(cache.available).toBe(false);
    await cache.setEnabled(true);
    expect(cache.state).toBe('off');
    expect(cache.enabled).toBe(true);
    expect(cache.lastError).toMatch(/no size per pod is set/);
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('BYPASS');
    await cache.setEnabled(false);
    expect(cache.lastError).toBeNull();
  });

  it('switching on again retries a directory that could not be used', async () => {
    const parent = await tempDir();
    const dir = path.join(parent, 'later');
    const cache = await makeCache({ dir });
    expect(cache.state).toBe('error');
    await fsp.mkdir(dir);
    await cache.setEnabled(true);
    expect(cache.state).toBe('ok');
    expect(cache.lastError).toBeNull();
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('MISS');
  });
});

describe('ArtifactCache limits changed at runtime', () => {
  it('a size set later lets a cache switched on without one start working', async () => {
    const cache = await makeCache({ maxSizeBytes: 0 });
    expect(cache.state).toBe('off');
    await cache.setLimits({ ...cache.currentLimits, maxSizeBytes: 10 * MB });
    expect(cache.state).toBe('ok');
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('MISS');
  });

  it('a lower size limit evicts down to 90 % of it at once', async () => {
    const cache = await makeCache();
    for (let i = 0; i < 10; i++) await store(cache, ref(`p${i}`), Buffer.alloc(100));
    expect(cache.stats().sizeBytes).toBe(1000);
    await cache.setLimits({ ...cache.currentLimits, maxSizeBytes: 500 });
    await cache.idle();
    expect(cache.stats()).toMatchObject({ maxSizeBytes: 500, sizeBytes: 400 });
  });

  it('a shorter expiry and a smaller largest file apply to the next request', async () => {
    let clock = Date.now();
    const cache = await makeCache({ now: () => clock });
    await store(cache, ref('old'), Buffer.from('old'));
    clock += 2 * 86_400_000;
    await cache.setLimits({ ...cache.currentLimits, maxAgeMs: 86_400_000, maxFileBytes: 10 });
    expect(await cache.lookup(ref('old'))).toBeNull();
    expect((await store(cache, ref('big'), Buffer.alloc(20))).result).toBe('BYPASS');
    expect((await store(cache, ref('small'), Buffer.alloc(5))).result).toBe('MISS');
  });

  it('never uses more than the disk has free above its reserve, and says so', async () => {
    const GB = 1024 ** 3;
    // A 100 GB file system with 3 GB free; the reserve is 5 %, at most 10 GB: 5 GB.
    let free = 3 * GB;
    const statfs = async () => ({ bsize: 4096, blocks: (100 * GB) / 4096, bavail: free / 4096 });
    const cache = await makeCache({ maxSizeBytes: 50 * GB, statfs });
    expect(cache.stats()).toMatchObject({ maxSizeBytes: 0, limitedByDisk: true });
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('BYPASS');

    free = 25 * GB;
    await cache.evict();
    expect(cache.stats()).toMatchObject({ maxSizeBytes: 20 * GB, limitedByDisk: true });
    expect((await store(cache, ref(), Buffer.from('x'))).result).toBe('MISS');

    free = 500 * GB;
    await cache.evict();
    expect(cache.stats()).toMatchObject({ maxSizeBytes: 50 * GB, limitedByDisk: false });
  });
});

describe('ArtifactCache fill and lookup', () => {
  it('a miss streams the file and stores it; the next request is a hit with the same bytes', async () => {
    const cache = await makeCache();
    const bytes = Buffer.from('tarball-contents'.repeat(1000));
    const first = await store(cache, ref(), bytes);
    expect(first.result).toBe('MISS');
    expect(first.served.equals(bytes)).toBe(true);

    const hit = await cache.lookup(ref());
    expect(hit).not.toBeNull();
    expect(hit!.size).toBe(bytes.length);
    expect(hit!.contentType).toBe('application/x-test');
    expect((await read(hit!.stream)).equals(bytes)).toBe(true);
    expect(cache.stats()).toMatchObject({ files: 1, sizeBytes: bytes.length, hits24h: 1, misses24h: 1 });
  });

  it('L2: commits through tmp/; the .json describes a complete data file', async () => {
    const cache = await makeCache();
    const bytes = Buffer.from('abc'.repeat(5000));
    await store(cache, ref(), bytes);
    const loc = locate(cache.root, ref());
    const meta = JSON.parse(await fsp.readFile(loc.metaPath, 'utf8')) as EntryMeta;
    expect(meta).toMatchObject({
      ecosystem: 'npm',
      remoteId: PUBLIC.id,
      remoteKey: 'default',
      package: 'pkg',
      version: '1.0.0',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: 'application/x-test',
    });
    expect(Number.isNaN(Date.parse(meta.storedAt))).toBe(false);
    expect((await fsp.readFile(loc.dataPath)).equals(bytes)).toBe(true);
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('streams several chunks in order and stores all of them', async () => {
    const cache = await makeCache();
    const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(64 * 1024, i));
    const res = await cache.fill(ref(), Readable.from(chunks), { contentType: 'x', contentLength: null });
    expect((await read(res.body)).equals(Buffer.concat(chunks))).toBe(true);
    await cache.idle();
    expect((await hitBytes(cache, ref()))!.equals(Buffer.concat(chunks))).toBe(true);
  });

  it('never stores or serves a file from an internal remote', async () => {
    const cache = await makeCache();
    const internal = ref('corp-lib', '1.0.0', { remote: INTERNAL });
    const { result, served } = await store(cache, internal, Buffer.from('secret'));
    expect(result).toBe('BYPASS');
    expect(served.toString()).toBe('secret');
    expect(await cache.lookup(internal)).toBeNull();
    expect(cache.stats().files).toBe(0);
  });

  it('keys by remote URL: a changed URL is a miss', async () => {
    const cache = await makeCache();
    await store(cache, ref(), Buffer.from('old'));
    expect(await cache.lookup(ref('pkg', '1.0.0', { remote: { ...PUBLIC, url: 'https://mirror.example.org' } }))).toBeNull();
  });
});

describe('ArtifactCache commit rules (W2)', () => {
  it('does not store a body shorter than its Content-Length', async () => {
    const cache = await makeCache();
    const { result, served } = await store(cache, ref(), Buffer.from('short'), 100);
    expect(result).toBe('MISS');
    expect(served.toString()).toBe('short');
    expect(await cache.lookup(ref())).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('does not store a download the upstream cut off', async () => {
    const cache = await makeCache();
    const res = await cache.fill(ref(), droppingBody(Buffer.from('first-half')), { contentType: 'x', contentLength: null });
    await expect(read(res.body)).rejects.toThrow(/terminated/);
    await cache.idle();
    expect(await cache.lookup(ref())).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('an upstream body that fails while the temp file opens is passed on, not thrown', async () => {
    const cache = await makeCache();
    const body = new PassThrough();
    const pending = cache.fill(ref(), body, { contentType: 'x', contentLength: 10 });
    body.destroy(new Error('terminated'));
    const res = await pending;
    expect(res.result).toBe('BYPASS');
    expect(res.body.destroyed).toBe(true);
    await cache.idle();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('stops the fill and stores nothing when the client disconnects', async () => {
    const cache = await makeCache();
    const upstream = new PassThrough();
    const res = await cache.fill(ref(), upstream, { contentType: 'x', contentLength: null });
    upstream.write(Buffer.alloc(1024, 7));
    const iterator = res.body[Symbol.asyncIterator]();
    await iterator.next();
    res.body.destroy();
    await cache.idle();
    expect(upstream.destroyed).toBe(true);
    expect(await cache.lookup(ref())).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('stores nothing when the client disconnects before every announced byte arrived', async () => {
    const cache = await makeCache();
    const upstream = new PassThrough();
    const res = await cache.fill(ref(), upstream, { contentType: 'x', contentLength: 2048 });
    upstream.write(Buffer.alloc(1024, 7));
    await res.body[Symbol.asyncIterator]().next();
    res.body.destroy();
    await cache.idle();
    expect(await cache.lookup(ref())).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it('stores the file when the client closes after the last announced byte, before the upstream end', async () => {
    const cache = await makeCache();
    const upstream = new PassThrough();
    const bytes = Buffer.alloc(4096, 9);
    const res = await cache.fill(ref(), upstream, { contentType: 'x', contentLength: bytes.length });
    upstream.write(bytes);
    let received = 0;
    for await (const chunk of res.body) {
      received += (chunk as Buffer).length;
      if (received >= bytes.length) break;
    }
    await cache.idle();
    expect((await hitBytes(cache, ref()))?.equals(bytes)).toBe(true);
  });

  it('serves but does not store a file over MAX_FILE_MB, announced or not', async () => {
    const cache = await makeCache({ maxFileBytes: 1000 });
    const announced = await store(cache, ref('a'), Buffer.alloc(2000), 2000);
    expect(announced.result).toBe('BYPASS');
    expect(announced.served.length).toBe(2000);

    const unannounced = await store(cache, ref('b'), Buffer.alloc(2000), null);
    expect(unannounced.result).toBe('MISS');
    expect(unannounced.served.length).toBe(2000);
    expect(await cache.lookup(ref('b'))).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
  });

  it.skipIf(isRoot)('X4: serves the file when the temp file cannot be written', async () => {
    const cache = await makeCache();
    await fsp.chmod(path.join(cache.root, 'tmp'), 0o500);
    const evict = vi.spyOn(cache, 'evict');
    const { result, served } = await store(cache, ref(), Buffer.from('still served'));
    expect(result).toBe('BYPASS');
    expect(served.toString()).toBe('still served');
    expect(cache.lastError).toMatch(/Write failed/);
    expect(evict).not.toHaveBeenCalled();
  });

  it('W3: one fill per key; a second request for the same file streams without storing', async () => {
    const cache = await makeCache();
    const slow = new PassThrough();
    const first = await cache.fill(ref(), slow, { contentType: 'x', contentLength: null });
    expect(first.result).toBe('MISS');

    const second = await cache.fill(ref(), Readable.from([Buffer.from('dup')]), { contentType: 'x', contentLength: 3 });
    expect(second.result).toBe('BYPASS');
    expect((await read(second.body)).toString()).toBe('dup');

    const other = await cache.fill(ref('other'), Readable.from([Buffer.from('o')]), { contentType: 'x', contentLength: 1 });
    expect(other.result).toBe('MISS');
    await read(other.body);

    slow.end(Buffer.from('the-file'));
    expect((await read(first.body)).toString()).toBe('the-file');
    await cache.idle();
    expect((await hitBytes(cache, ref()))?.toString()).toBe('the-file');
  });
});

describe('ArtifactCache self-heal (L3)', () => {
  it('a missing data file is a miss and its .json is removed', async () => {
    const cache = await makeCache();
    await store(cache, ref(), Buffer.from('abc'));
    const loc = locate(cache.root, ref());
    await fsp.unlink(loc.dataPath);
    expect(await cache.lookup(ref())).toBeNull();
    expect(await exists(loc.metaPath)).toBe(false);
    expect(cache.stats().files).toBe(0);
  });

  it('a data file of the wrong size is a miss and both files are removed', async () => {
    const cache = await makeCache();
    await store(cache, ref(), Buffer.from('abcdef'));
    const loc = locate(cache.root, ref());
    await fsp.truncate(loc.dataPath, 2);
    expect(await cache.lookup(ref())).toBeNull();
    expect(await exists(loc.metaPath)).toBe(false);
    expect(await exists(loc.dataPath)).toBe(false);
  });

  it('an unreadable .json is a miss and the entry is removed', async () => {
    const cache = await makeCache();
    await store(cache, ref(), Buffer.from('abc'));
    const loc = locate(cache.root, ref());
    await fsp.writeFile(loc.metaPath, '{not json');
    expect(await cache.lookup(ref())).toBeNull();
    expect(await exists(loc.metaPath)).toBe(false);
    expect(await exists(loc.dataPath)).toBe(false);
  });

  it('a file stored again replaces the old one without counting it twice', async () => {
    const cache = await makeCache();
    await store(cache, ref(), Buffer.from('first'));
    // Fill without a lookup in between, as after a read error.
    await store(cache, ref(), Buffer.from('second!'));
    expect(cache.stats()).toMatchObject({ files: 1, sizeBytes: 7 });
    expect((await hitBytes(cache, ref()))?.toString()).toBe('second!');
  });
});

describe('ArtifactCache expiry (X1)', () => {
  it('expires by age on lookup, even between eviction runs', async () => {
    let clock = Date.now();
    const cache = await makeCache({ maxAgeMs: 30 * 86_400_000, now: () => clock });
    const evicted = counter(artifactCacheEvictedTotal, { reason: 'age' });
    const before = await evicted();
    await store(cache, ref(), Buffer.from('abc'));
    clock += 30 * 86_400_000 - 1000;
    expect(await hitBytes(cache, ref())).not.toBeNull();
    clock += 1000;
    expect(await cache.lookup(ref())).toBeNull();
    expect(await exists(locate(cache.root, ref()).dataPath)).toBe(false);
    expect((await evicted()) - before).toBe(1);
  });

  it('expires by idle time; a hit keeps the file alive', async () => {
    let clock = Date.now();
    const day = 86_400_000;
    const cache = await makeCache({ maxIdleMs: 7 * day, touchIntervalMs: 0, now: () => clock });
    const evicted = counter(artifactCacheEvictedTotal, { reason: 'idle' });
    const before = await evicted();
    await store(cache, ref(), Buffer.from('abc'));
    clock += 6 * day;
    expect(await hitBytes(cache, ref())).not.toBeNull();
    await vi.waitFor(async () => {
      const stat = await fsp.stat(locate(cache.root, ref()).metaPath);
      expect(Math.abs(stat.mtimeMs - clock)).toBeLessThan(1000);
    });
    clock += 6 * day;
    expect(await hitBytes(cache, ref())).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    clock += 7 * day;
    expect(await cache.lookup(ref())).toBeNull();
    expect((await evicted()) - before).toBe(1);
  });

  it('L4: a hit moves last access at most once per hour', async () => {
    let clock = Date.now();
    const cache = await makeCache({ now: () => clock });
    await store(cache, ref(), Buffer.from('abc'));
    const metaPath = locate(cache.root, ref()).metaPath;
    const stored = (await fsp.stat(metaPath)).mtimeMs;
    clock += 30 * 60_000;
    await hitBytes(cache, ref());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fsp.stat(metaPath)).mtimeMs).toBe(stored);
    clock += 31 * 60_000;
    await hitBytes(cache, ref());
    await vi.waitFor(async () => expect((await fsp.stat(metaPath)).mtimeMs).toBeGreaterThan(stored + 3_600_000));
  });

  it('0 turns both expiries off', async () => {
    let clock = Date.now();
    const cache = await makeCache({ maxAgeMs: 0, maxIdleMs: 0, now: () => clock });
    await store(cache, ref(), Buffer.from('abc'));
    clock += 3650 * 86_400_000;
    expect(await hitBytes(cache, ref())).not.toBeNull();
    expect(await cache.evict()).toMatchObject({ expired: 0 });
  });
});

describe('ArtifactCache eviction (X2, X3)', () => {
  const FILES = 10;
  const SIZE = 100;
  /** Last access order: index 0 is the least recently used. */
  const ACCESS_ORDER = [3, 7, 1, 9, 0, 5, 2, 8, 4, 6];

  /** Ten 100-byte files whose last access follows ACCESS_ORDER; returns the directory. */
  async function seeded(): Promise<{ dir: string; base: number }> {
    const dir = await tempDir();
    const seed = await makeCache({ dir });
    for (let i = 0; i < FILES; i++) await store(seed, ref(`p${i}`), Buffer.alloc(SIZE, i));
    await seed.close();
    const base = Date.now() - 3_600_000;
    for (const [rank, i] of ACCESS_ORDER.entries()) {
      const at = new Date(base + rank * 60_000);
      await fsp.utimes(locate(seed.root, ref(`p${i}`)).metaPath, at, at);
    }
    return { dir, base };
  }

  async function present(cache: ArtifactCache): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < FILES; i++) if (await exists(locate(cache.root, ref(`p${i}`)).metaPath)) out.push(i);
    return out;
  }

  it('size limit alone: deletes the least recently used until the size is at 90 %', async () => {
    const { dir } = await seeded();
    const evicted = counter(artifactCacheEvictedTotal, { reason: 'size' });
    const before = await evicted();
    const cache = await makeCache({ dir, maxSizeBytes: 800, maxFiles: 1_000_000 });
    // 1000 of 800 bytes: free down to 720, the three least recently used.
    expect(await present(cache)).toEqual([0, 2, 4, 5, 6, 8, 9]);
    expect(cache.stats()).toMatchObject({ files: 7, sizeBytes: 700 });
    expect((await evicted()) - before).toBe(3);
  });

  it('file limit alone: deletes the least recently used until the count is at 90 %', async () => {
    const { dir } = await seeded();
    const evicted = counter(artifactCacheEvictedTotal, { reason: 'files' });
    const before = await evicted();
    const cache = await makeCache({ dir, maxSizeBytes: 100 * MB, maxFiles: 8 });
    // 10 of 8 files: down to 7.
    expect(await present(cache)).toEqual([0, 2, 4, 5, 6, 8, 9]);
    expect((await evicted()) - before).toBe(3);
  });

  it('does nothing below 95 % of both limits', async () => {
    const { dir } = await seeded();
    const cache = await makeCache({ dir, maxSizeBytes: 1060, maxFiles: 11 });
    expect(await present(cache)).toHaveLength(FILES);
  });

  it('deletes expired files first, then only what is still over the limit', async () => {
    const { dir } = await seeded();
    const old = new Date(Date.now() - 40 * 86_400_000);
    // Stored 40 days ago: p9 and p6 (p6 is the most recently used).
    for (const i of [9, 6]) {
      const loc = locate(path.resolve(dir), ref(`p${i}`));
      await fsp.utimes(loc.dataPath, old, old);
    }
    const age = counter(artifactCacheEvictedTotal, { reason: 'age' });
    const size = counter(artifactCacheEvictedTotal, { reason: 'size' });
    const [ageBefore, sizeBefore] = [await age(), await size()];
    const cache = await makeCache({ dir, maxSizeBytes: 800, maxFiles: 1000, maxAgeMs: 30 * 86_400_000 });
    // 800 of 800 bytes left after expiry: still at 100 %, so down to 720 means one more, the least recently used (p3).
    expect(await present(cache)).toEqual([0, 1, 2, 4, 5, 7, 8]);
    expect((await age()) - ageBefore).toBe(2);
    expect((await size()) - sizeBefore).toBe(1);
  });

  it('deletes files unused for longer than MAX_IDLE_DAYS', async () => {
    const { dir } = await seeded();
    const stale = new Date(Date.now() - 8 * 86_400_000);
    await fsp.utimes(locate(path.resolve(dir), ref('p5')).metaPath, stale, stale);
    const cache = await makeCache({ dir, maxIdleMs: 7 * 86_400_000 });
    expect(await present(cache)).not.toContain(5);
    expect(await present(cache)).toHaveLength(FILES - 1);
  });

  it('runs one eviction at a time', async () => {
    const cache = await makeCache();
    const a = cache.evict();
    const b = cache.evict();
    expect(a).toBe(b);
    await a;
  });

  it('W4: skips a fill that would pass 100 % and starts an eviction; a fill up to 100 % is stored', async () => {
    const cache = await makeCache({ maxSizeBytes: 1000, maxFiles: 1000 });
    for (let i = 0; i < 9; i++) await store(cache, ref(`f${i}`), Buffer.alloc(100));
    expect(cache.stats().sizeBytes).toBe(900);
    const evict = vi.spyOn(cache, 'evict');
    const tooBig = await store(cache, ref('big'), Buffer.alloc(200));
    expect(tooBig.result).toBe('BYPASS');
    expect(tooBig.served.length).toBe(200);
    expect(evict).toHaveBeenCalled();

    const fits = await store(cache, ref('fits'), Buffer.alloc(100));
    expect(fits.result).toBe('MISS');
    await cache.idle();
    // Reaching 95 % started an eviction down to 90 %.
    expect(cache.stats().sizeBytes).toBeLessThanOrEqual(900);
  });

  it('W4: the file limit is checked before a fill too', async () => {
    const cache = await makeCache({ maxFiles: 3 });
    // Eviction falling behind: the cache stays at its limit.
    const evict = vi.spyOn(cache, 'evict').mockResolvedValue({ expired: 0, leastRecentlyUsed: 0, orphans: 0 });
    for (let i = 0; i < 3; i++) await store(cache, ref(`f${i}`), Buffer.alloc(10));
    evict.mockClear();
    const extra = await cache.fill(ref('extra'), Readable.from([Buffer.alloc(10)]), { contentType: 'x', contentLength: 10 });
    expect(extra.result).toBe('BYPASS');
    expect((await read(extra.body)).length).toBe(10);
    expect(evict).toHaveBeenCalled();
  });
});

describe('ArtifactCache purge (P1)', () => {
  it('purges every version of one package, and nothing else', async () => {
    const cache = await makeCache();
    await store(cache, ref('a', '1.0.0'), Buffer.alloc(10));
    await store(cache, ref('a', '2.0.0'), Buffer.alloc(20));
    await store(cache, ref('b', '1.0.0'), Buffer.alloc(30));
    const result = await cache.purge({ ecosystem: 'npm', packageName: 'a' });
    expect(result).toEqual({ files: 2, bytes: 30 });
    expect(await cache.lookup(ref('a', '1.0.0'))).toBeNull();
    expect(await cache.lookup(ref('a', '2.0.0'))).toBeNull();
    expect(await hitBytes(cache, ref('b', '1.0.0'))).not.toBeNull();
    expect(cache.stats()).toMatchObject({ files: 1, sizeBytes: 30 });
    expect(await exists(locate(cache.root, ref('a')).packageDir)).toBe(false);
  });

  it('purges one version', async () => {
    const cache = await makeCache();
    await store(cache, ref('a', '1.0.0'), Buffer.alloc(10));
    await store(cache, ref('a', '2.0.0'), Buffer.alloc(20));
    expect(await cache.purge({ ecosystem: 'npm', packageName: 'a', version: '2.0.0' })).toEqual({ files: 1, bytes: 20 });
    expect(await hitBytes(cache, ref('a', '1.0.0'))).not.toBeNull();
    expect(await cache.lookup(ref('a', '2.0.0'))).toBeNull();
  });

  it('matches the package the way the ecosystem spells it', async () => {
    const cache = await makeCache();
    const pypi = (name: string): ArtifactRef => ({ ecosystem: 'pypi', packageName: name, version: '1.0', path: 'Foo_Bar-1.0.tar.gz', remote: PUBLIC });
    await store(cache, pypi('Foo_Bar'), Buffer.alloc(5));
    expect((await cache.purge({ ecosystem: 'pypi', packageName: 'foo-bar' })).files).toBe(1);
  });

  it('clears everything', async () => {
    const cache = await makeCache();
    for (let i = 0; i < 5; i++) await store(cache, ref(`p${i}`), Buffer.alloc(10));
    const evicted = counter(artifactCacheEvictedTotal, { reason: 'purge' });
    const before = await evicted();
    expect(await cache.purge({ all: true })).toEqual({ files: 5, bytes: 50 });
    await cache.idle();
    expect(cache.stats()).toMatchObject({ files: 0, sizeBytes: 0 });
    for (let i = 0; i < 5; i++) expect(await cache.lookup(ref(`p${i}`))).toBeNull();
    expect(await tmpFiles(cache)).toEqual([]);
    expect((await evicted()) - before).toBe(5);
    // Still usable afterwards.
    expect((await store(cache, ref('again'), Buffer.from('x'))).result).toBe('MISS');
    expect(await hitBytes(cache, ref('again'))).not.toBeNull();
  });

  it('an unknown package purges nothing', async () => {
    const cache = await makeCache();
    expect(await cache.purge({ ecosystem: 'npm', packageName: 'nope' })).toEqual({ files: 0, bytes: 0 });
  });
});

describe('ArtifactCache metrics (S5)', () => {
  it('counts hit, miss and bypass per ecosystem', async () => {
    const cache = await makeCache();
    const hit = counter(artifactCacheRequestsTotal, { ecosystem: 'npm', result: 'hit' });
    const miss = counter(artifactCacheRequestsTotal, { ecosystem: 'npm', result: 'miss' });
    const bypass = counter(artifactCacheRequestsTotal, { ecosystem: 'npm', result: 'bypass' });
    const [h, m, b] = [await hit(), await miss(), await bypass()];
    await store(cache, ref(), Buffer.from('a'));
    await hitBytes(cache, ref());
    await store(cache, ref('corp', '1', { remote: INTERNAL }), Buffer.from('b'));
    cache.countBypass('npm');
    expect((await hit()) - h).toBe(1);
    expect((await miss()) - m).toBe(1);
    expect((await bypass()) - b).toBe(2);
  });
});

describe('ArtifactCache eviction while the cache is in use', () => {
  type Held = { reached: Promise<void>; release: () => void };

  /** Holds the walk the first time it calls `method` with arguments `when` accepts, until released. */
  function hold(cache: ArtifactCache, method: 'statPair' | 'removeOrphan', when: (args: unknown[]) => boolean = () => true): Held {
    const target = cache as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = target[method].bind(cache);
    let release!: () => void;
    let onReached!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (onReached = resolve));
    let held = false;
    target[method] = async (...args: unknown[]) => {
      if (!held && when(args)) {
        held = true;
        onReached();
        await released;
      }
      return original(...args);
    };
    return { reached, release };
  }

  /** Stores without waiting for the cache to be idle, which it never is while a walk is held. */
  async function storeWhileHeld(cache: ArtifactCache, r: ArtifactRef, bytes: Buffer): Promise<void> {
    const res = await cache.fill(r, Readable.from([bytes]), { contentType: 'application/x-test', contentLength: bytes.length });
    expect(res.result).toBe('MISS');
    await read(res.body);
    await vi.waitFor(async () => expect(await exists(locate(cache.root, r).metaPath)).toBe(true));
  }

  /** npm package names in the order a walk reads their directories, each under its own prefix directory. */
  function namesInWalkOrder(count: number): string[] {
    const prefixes = new Set<string>();
    const picked: Array<{ name: string; hash: string }> = [];
    for (let i = 0; picked.length < count; i++) {
      const name = `walk${i}`;
      const hash = packageHash('npm', name);
      if (prefixes.has(hash.slice(0, 2))) continue;
      prefixes.add(hash.slice(0, 2));
      picked.push({ name, hash });
    }
    return picked.sort((a, b) => a.hash.localeCompare(b.hash)).map((p) => p.name);
  }

  it('X3: the recount keeps what was stored and removed behind the walk', async () => {
    const cache = await makeCache();
    const [late, first, second] = namesInWalkOrder(3);
    await store(cache, ref(first), Buffer.alloc(100, 1));
    await store(cache, ref(second), Buffer.alloc(100, 2));
    const { reached, release } = hold(cache, 'statPair');
    const walk = cache.evict();
    await reached;
    // The walk has listed `first` and is looking at it. It will not see: a package under a prefix it listed
    // without it (late), a second version in the directory it is reading, and `first` itself leaving.
    await storeWhileHeld(cache, ref(late), Buffer.alloc(100, 3));
    await storeWhileHeld(cache, ref(first, '2.0.0'), Buffer.alloc(100, 4));
    await cache.purge({ ecosystem: 'npm', packageName: first, version: '1.0.0' });
    release();
    await walk;
    await cache.idle();
    expect(cache.stats()).toMatchObject({ files: 3, sizeBytes: 300 });
    expect(await hitBytes(cache, ref(late))).not.toBeNull();
    expect(await hitBytes(cache, ref(first, '2.0.0'))).not.toBeNull();
    expect(await hitBytes(cache, ref(second))).not.toBeNull();
    expect(cache.stats()).toMatchObject({ files: 3, sizeBytes: 300 });
  });

  it('deletes an unpaired file once it is old enough, and keeps one whose pair appears', async () => {
    const cache = await makeCache();
    await store(cache, ref('kept'), Buffer.alloc(10, 1));
    await store(cache, ref('paired-late'), Buffer.alloc(10, 2));
    const earlier = new Date(Date.now() - 120_000);
    const young = locate(cache.root, ref('young'));
    const old = locate(cache.root, ref('old'));
    for (const loc of [young, old]) {
      await fsp.mkdir(loc.packageDir, { recursive: true });
      await fsp.writeFile(loc.dataPath, 'x');
    }
    await fsp.utimes(old.dataPath, earlier, earlier);
    // A commit the walk lists between its data rename and its .json rename.
    const late = locate(cache.root, ref('paired-late'));
    const lateMeta = await fsp.readFile(late.metaPath);
    await fsp.unlink(late.metaPath);
    await fsp.utimes(late.dataPath, earlier, earlier);

    const { reached, release } = hold(cache, 'removeOrphan', (args) => (args[0] as { key: string }).key === late.key);
    const walk = cache.evict();
    await reached;
    await fsp.writeFile(late.metaPath, lateMeta);
    release();
    expect(await walk).toMatchObject({ orphans: 1 });
    await cache.idle();

    expect(await exists(old.dataPath)).toBe(false);
    expect(await exists(young.dataPath)).toBe(true);
    expect((await hitBytes(cache, ref('paired-late')))?.length).toBe(10);
    expect(cache.stats()).toMatchObject({ files: 2, sizeBytes: 20 });
  });

  it.skipIf(isRoot)('forgets a write error once a later file is stored', async () => {
    const cache = await makeCache();
    const tmp = path.join(cache.root, 'tmp');
    await fsp.chmod(tmp, 0o500);
    expect((await store(cache, ref('a'), Buffer.alloc(10, 1))).result).toBe('BYPASS');
    expect(cache.lastError).toMatch(/Write failed/);
    expect(cache.state).toBe('ok');
    await fsp.chmod(tmp, 0o700);
    expect((await store(cache, ref('b'), Buffer.alloc(10, 2))).result).toBe('MISS');
    expect(cache.lastError).toBeNull();
    expect(cache.stats()).toMatchObject({ state: 'ok', lastError: null, files: 1 });
  });
});
