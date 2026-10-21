/**
 * Child process for the artifact cache crash test: stores one complete file, then starts fills that never
 * finish and waits to be killed with SIGKILL. Prints READY once every fill has bytes in its temp file.
 */
import { PassThrough, Readable } from 'node:stream';
import { ArtifactCache } from '../services/artifact-cache/store.js';
import type { ArtifactRef } from '../services/artifact-cache/layout.js';

const PARTIAL_FILLS = 5;

function ref(name: string): ArtifactRef {
  return {
    ecosystem: 'npm',
    packageName: name,
    version: '1.0.0',
    path: `${name}/-/${name}-1.0.0.tgz`,
    remote: { id: 'crash-remote', key: 'default', url: 'https://registry.example.org', source: 'public' },
  };
}

async function main(): Promise<void> {
  const cache = new ArtifactCache({
    enabled: true,
    dir: process.argv[2],
    maxSizeBytes: 1_000_000_000,
    maxFiles: 1000,
    maxAgeMs: 0,
    maxIdleMs: 0,
    maxFileBytes: 100_000_000,
  });
  await cache.start();
  await cache.idle();

  const complete = await cache.fill(ref('complete'), Readable.from([Buffer.alloc(4096, 1)]), { contentType: 'x', contentLength: 4096 });
  complete.body.resume();
  await new Promise((resolve) => complete.body.once('end', resolve));
  await cache.idle();

  for (let i = 0; i < PARTIAL_FILLS; i++) {
    const upstream = new PassThrough();
    const res = await cache.fill(ref(`partial${i}`), upstream, { contentType: 'x', contentLength: 1_000_000 });
    res.body.resume();
    upstream.write(Buffer.alloc(256 * 1024, i));
  }
  // Give the writes time to reach the temp files.
  setTimeout(() => process.stdout.write('READY\n'), 200);
  setInterval(() => undefined, 1000);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
