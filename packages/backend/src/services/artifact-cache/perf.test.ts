/**
 * §12 targets for the cache itself, opt-in (RUN_PERF=1): memory stays flat while a 1 GB file is stored and
 * served, and a hit adds at most 5 ms p95. Needs about 2 GB of free disk in the temp directory.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtifactCache } from './store.js';
import type { ArtifactRef } from './layout.js';

const GB = 1024 ** 3;
const CHUNK = 64 * 1024;
const MEMORY_BUDGET = 64 * 1024 * 1024;

function ref(name: string): ArtifactRef {
  return {
    ecosystem: 'maven',
    packageName: `org.example:${name}`,
    version: '1.0.0',
    path: `org/example/${name}/1.0.0/${name}-1.0.0.jar`,
    remote: { id: 'perf', key: 'default', url: 'https://repo1.maven.org/maven2', source: 'public' },
  };
}

/** `total` bytes in 64 KB chunks, all views of one buffer, so the source itself holds no memory. */
function generated(total: number): Readable {
  const block = Buffer.alloc(CHUNK, 7);
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) return void this.push(null);
      const size = Math.min(CHUNK, total - sent);
      sent += size;
      this.push(size === CHUNK ? block : block.subarray(0, size));
    },
  });
}

/** Peak of heap plus array buffers above the starting level while `run` executes. */
async function peakMemory(run: () => Promise<void>): Promise<number> {
  global.gc?.();
  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const base = used();
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, used())), 20);
  try {
    await run();
  } finally {
    clearInterval(timer);
  }
  return Math.max(peak, used()) - base;
}

async function drain(stream: Readable): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  return bytes;
}

describe.skipIf(!process.env.RUN_PERF)('artifact cache performance targets', () => {
  let dir = '';
  let cache: ArtifactCache;

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-perf-'));
    cache = new ArtifactCache({
      enabled: true,
      dir,
      maxSizeBytes: 4 * GB,
      maxFiles: 100_000,
      maxAgeMs: 0,
      maxIdleMs: 0,
      maxFileBytes: 2 * GB,
    });
    await cache.start();
    await cache.idle();
  });

  afterAll(async () => {
    await cache?.idle();
    await cache?.close();
    if (dir) await fsp.rm(dir, { recursive: true, force: true });
  });

  it('memory stays flat while a 1 GB file is stored, and while it is served from the cache', async () => {
    let served = 0;
    const filling = await peakMemory(async () => {
      const res = await cache.fill(ref('big'), generated(GB), { contentType: 'application/java-archive', contentLength: GB });
      expect(res.result).toBe('MISS');
      served = await drain(res.body);
      await cache.idle();
    });
    expect(served).toBe(GB);
    console.info(`1 GB fill: peak memory growth ${(filling / 1024 / 1024).toFixed(1)} MB`);
    expect(filling, `peak growth while filling: ${(filling / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(MEMORY_BUDGET);

    let hitBytes = 0;
    const hitting = await peakMemory(async () => {
      const hit = await cache.lookup(ref('big'));
      expect(hit?.size).toBe(GB);
      hitBytes = await drain(hit!.stream);
    });
    expect(hitBytes).toBe(GB);
    console.info(`1 GB hit: peak memory growth ${(hitting / 1024 / 1024).toFixed(1)} MB`);
    expect(hitting, `peak growth while serving: ${(hitting / 1024 / 1024).toFixed(1)} MB`).toBeLessThan(MEMORY_BUDGET);
  }, 300_000);

  it('a hit (lookup, open, first byte) takes at most 5 ms p95', async () => {
    const files = 200;
    for (let i = 0; i < files; i++) {
      const res = await cache.fill(ref(`small${i}`), generated(256 * 1024), { contentType: 'x', contentLength: 256 * 1024 });
      await drain(res.body);
    }
    await cache.idle();
    const samples: number[] = [];
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < files; i++) {
        const started = process.hrtime.bigint();
        const hit = await cache.lookup(ref(`small${i}`));
        const iterator = hit!.stream[Symbol.asyncIterator]();
        await iterator.next();
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
        hit!.stream.destroy();
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.info(`hit to first byte: p50 ${samples[Math.floor(samples.length / 2)].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
    expect(p95, `p95 ${p95.toFixed(2)} ms over ${samples.length} hits`).toBeLessThanOrEqual(5);
  }, 120_000);
});
