/**
 * §12 crash test: a pod killed with SIGKILL during fills. After a restart no partial file is served and tmp/
 * is empty. The fills run in a child process, so the kill is real.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactCache } from './store.js';
import type { ArtifactRef } from './layout.js';

const CHILD = path.join(__dirname, '..', '..', 'test-support', 'artifact-cache-crash-child.ts');

function findTsx(): string | null {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function ref(name: string): ArtifactRef {
  return {
    ecosystem: 'npm',
    packageName: name,
    version: '1.0.0',
    path: `${name}/-/${name}-1.0.0.tgz`,
    remote: { id: 'crash-remote', key: 'default', url: 'https://registry.example.org', source: 'public' },
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

const tsx = findTsx();

describe.skipIf(!tsx)('artifact cache after kill -9 during fills', () => {
  it('serves no partial file and leaves tmp/ empty after a restart', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-crash-'));
    dirs.push(dir);
    const child = spawn(tsx!, [CHILD, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child not ready: ${stderr}`)), 20_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${stderr}`)));
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    const leftovers = (await fsp.readdir(path.join(dir, 'tmp'))).filter((name) => !name.startsWith('.'));
    expect(leftovers.length, 'the kill left partial temp files to clean up').toBeGreaterThanOrEqual(5);

    const cache = new ArtifactCache({
      enabled: true,
      dir,
      maxSizeBytes: 1_000_000_000,
      maxFiles: 1000,
      maxAgeMs: 0,
      maxIdleMs: 0,
      maxFileBytes: 100_000_000,
    });
    await cache.start();
    try {
      for (let i = 0; i < 5; i++) expect(await cache.lookup(ref(`partial${i}`))).toBeNull();
      await cache.idle();
      expect((await fsp.readdir(path.join(dir, 'tmp'))).filter((name) => !name.startsWith('.'))).toEqual([]);
      const hit = await cache.lookup(ref('complete'));
      expect(hit?.size).toBe(4096);
      hit?.stream.destroy();
      expect(cache.stats()).toMatchObject({ files: 1, sizeBytes: 4096 });
    } finally {
      await cache.close();
    }
  }, 30_000);
});
