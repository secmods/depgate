import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import artifactCachePlugin, { missingSizeMessage } from '../../plugins/artifact-cache.js';
import { artifactRef } from './layout.js';
import { CACHE_HEADER, readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from './reply.js';
import type { RemoteTarget } from '../repository-resolve.js';

const remote = (source: 'public' | 'internal'): RemoteTarget => ({
  id: `${source}-remote`,
  key: source,
  url: `https://${source}.example.org`,
  timeoutMs: 1000,
  retryCount: 0,
  authType: null,
  authEncrypted: null,
  source,
});

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.artifactCache?.idle();
    await app.close();
  }
  for (const dir of dirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

/**
 * A route shaped like the package routes: policy already allowed it, then the cache, then the upstream.
 * `?source=internal` serves from an internal remote; `?length=0` leaves out Content-Length.
 */
async function harness(enabled = true) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'depgate-acache-reply-'));
  dirs.push(dir);
  const upstreamCalls: string[] = [];
  const app = Fastify();
  apps.push(app);
  await app.register(artifactCachePlugin, {
    overrides: { enabled, dir, maxSizeBytes: 10_000_000, maxFiles: 100, maxAgeMs: 0, maxIdleMs: 0, maxFileBytes: 1_000_000 },
  });
  app.get<{ Params: { name: string }; Querystring: { source?: string; length?: string; encoded?: string } }>('/files/:name', async (request, reply) => {
    const serving = remote(request.query.source === 'internal' ? 'internal' : 'public');
    const name = request.params.name;
    const ref = artifactRef('npm', name, '1.0.0', `${name}/-/${name}-1.0.0.tgz`, serving);
    const hit = await readCachedArtifact(app, ref);
    if (hit) return sendCacheHit(reply, hit);
    upstreamCalls.push(name);
    const body = Buffer.from(`contents of ${name}`);
    const headers = new Headers({ 'content-type': 'application/x-tar' });
    if (request.query.length !== '0') headers.set('content-length', String(body.length));
    if (request.query.encoded) {
      // What fetch hands over for a gzip response: the decoded body, with the encoded length.
      headers.set('content-encoding', 'gzip');
      headers.set('content-length', String(Math.floor(body.length / 2)));
    }
    return sendUpstreamArtifact(app, reply, 'npm', ref, { body: Readable.from([body]), headers, source: serving });
  });
  await app.ready();
  return { app, upstreamCalls };
}

describe('artifact responses (F5)', () => {
  it('MISS then HIT, with the stored Content-Type and an exact Content-Length; upstream asked once', async () => {
    const { app, upstreamCalls } = await harness();
    const miss = await app.inject({ method: 'GET', url: '/files/lodash' });
    expect(miss.statusCode).toBe(200);
    expect(miss.headers[CACHE_HEADER.toLowerCase()]).toBe('MISS');
    expect(miss.body).toBe('contents of lodash');
    await app.artifactCache.idle();

    const hit = await app.inject({ method: 'GET', url: '/files/lodash' });
    expect(hit.statusCode).toBe(200);
    expect(hit.headers[CACHE_HEADER.toLowerCase()]).toBe('HIT');
    expect(hit.headers['content-type']).toBe('application/x-tar');
    expect(hit.headers['content-length']).toBe(String('contents of lodash'.length));
    expect(hit.body).toBe('contents of lodash');
    expect(upstreamCalls).toEqual(['lodash']);
  });

  it('a hit has an exact Content-Length even when upstream sent none', async () => {
    const { app } = await harness();
    const miss = await app.inject({ method: 'GET', url: '/files/chunked?length=0' });
    expect(miss.headers[CACHE_HEADER.toLowerCase()]).toBe('MISS');
    await app.artifactCache.idle();
    const hit = await app.inject({ method: 'GET', url: '/files/chunked' });
    expect(hit.headers['content-length']).toBe(String('contents of chunked'.length));
  });

  it('a body fetch decoded (gzip) is neither sent nor stored with the encoded length', async () => {
    const { app } = await harness();
    const miss = await app.inject({ method: 'GET', url: '/files/gzipped?encoded=1' });
    expect(miss.statusCode).toBe(200);
    expect(miss.headers[CACHE_HEADER.toLowerCase()]).toBe('MISS');
    expect(miss.headers['content-length']).not.toBe(String(Math.floor('contents of gzipped'.length / 2)));
    expect(miss.body).toBe('contents of gzipped');
    await app.artifactCache.idle();
    const hit = await app.inject({ method: 'GET', url: '/files/gzipped' });
    expect(hit.headers[CACHE_HEADER.toLowerCase()]).toBe('HIT');
    expect(hit.headers['content-length']).toBe(String('contents of gzipped'.length));
    expect(hit.body).toBe('contents of gzipped');
  });

  it('BYPASS for an internal remote, every time', async () => {
    const { app, upstreamCalls } = await harness();
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/files/corp-lib?source=internal' });
      expect(res.headers[CACHE_HEADER.toLowerCase()]).toBe('BYPASS');
      await app.artifactCache.idle();
    }
    expect(upstreamCalls).toEqual(['corp-lib', 'corp-lib']);
  });

  it('BYPASS when the cache is off', async () => {
    const { app, upstreamCalls } = await harness(false);
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/files/lodash' });
      expect(res.headers[CACHE_HEADER.toLowerCase()]).toBe('BYPASS');
      expect(res.body).toBe('contents of lodash');
    }
    expect(upstreamCalls).toHaveLength(2);
  });
});

describe('artifact cache plugin', () => {
  it('stops start-up with a clear message when enabled without MAX_SIZE_GB', async () => {
    const app = Fastify();
    apps.push(app);
    await expect(
      app.register(artifactCachePlugin, { overrides: { enabled: true, dir: os.tmpdir(), maxSizeBytes: 0 } }).ready()
    ).rejects.toThrow(/ARTIFACT_CACHE_MAX_SIZE_GB is not set/);
  });

  it('names the value when MAX_SIZE_GB is set to something that is not a size', () => {
    expect(missingSizeMessage('50GB')).toMatch(/ARTIFACT_CACHE_MAX_SIZE_GB is "50GB", which is not a number of gigabytes above 0/);
    expect(missingSizeMessage('0')).toMatch(/is "0", which is not/);
    expect(missingSizeMessage('')).toMatch(/is not set\./);
  });

  it('K2: stops starting fills as soon as shutdown begins; hits keep working', async () => {
    const { app } = await harness();
    await app.inject({ method: 'GET', url: '/files/before' });
    await app.artifactCache.idle();
    // preClose hooks run at the start of app.close(), before in-flight requests drain.
    const closing = app.close();
    await new Promise((resolve) => setImmediate(resolve));
    const cache = app.artifactCache;
    const fill = await cache.fill(
      artifactRef('npm', 'after', '1.0.0', 'after/-/after-1.0.0.tgz', remote('public'))!,
      Readable.from([Buffer.from('x')]),
      { contentType: 'x', contentLength: 1 }
    );
    expect(fill.result).toBe('BYPASS');
    fill.body.resume();
    const hit = await cache.lookup(artifactRef('npm', 'before', '1.0.0', 'before/-/before-1.0.0.tgz', remote('public'))!);
    expect(hit).not.toBeNull();
    hit!.stream.destroy();
    await closing;
    apps.splice(apps.indexOf(app), 1);
  });

  it('starts with the cache off, not failing, when the directory is unusable (K1)', async () => {
    const app = Fastify();
    apps.push(app);
    await app.register(artifactCachePlugin, {
      overrides: { enabled: true, dir: path.join(os.tmpdir(), `depgate-missing-${Date.now()}`), maxSizeBytes: 1000 },
    });
    await app.ready();
    expect(app.artifactCache.state).toBe('error');
  });
});
