import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { getCachedDocument } from './metadata-cache.js';

describe('metadata cache', () => {
  it('stores a positive document and a negative 404', async () => {
    const data = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
    } as unknown as Redis;
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { status: 200, fromUrl: 'https://example.test/pkg', bodyText: '{"name":"pkg"}' };
    };

    const first = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/pkg/', load);
    const second = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/pkg/', load);
    expect(first.bodyText).toBe('{"name":"pkg"}');
    expect(second.bodyText).toBe('{"name":"pkg"}');
    expect(loads).toBe(1);

    const missing = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/missing/', async () => ({
      status: 404,
      fromUrl: '',
      bodyText: '',
    }));
    const missingAgain = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/missing/', async () => {
      throw new Error('should not load');
    });
    expect(missing.status).toBe(404);
    expect(missingAgain.status).toBe(404);
  });

  it('fetches a cold key once when two callers miss together', async () => {
    const data = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      setex: vi.fn(async (key: string, _ttl: number, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    } as unknown as Redis;
    let loads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = () => {
      loads += 1;
      return gate.then(() => ({ status: 200, fromUrl: 'https://example.test/pkg', bodyText: '{"name":"pkg"}' }));
    };
    const pending = Promise.all([
      getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/hot/', load),
      getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/hot/', load),
    ]);
    await vi.waitFor(() => expect(loads).toBe(1));
    release();
    const [a, b] = await pending;
    expect(a.bodyText).toBe('{"name":"pkg"}');
    expect(b.bodyText).toBe(a.bodyText);
    expect(loads).toBe(1);
  });

  it('serves a stale document while one refresh replaces it', async () => {
    const data = new Map<string, string>();
    const key = 'meta:v1:pypi:default:simple/pkg/';
    data.set(key, JSON.stringify({ fromUrl: 'https://example.test/pkg', bodyText: 'old', freshUntil: Date.now() - 1000 }));
    const redis = {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      setex: vi.fn(async (k: string, _ttl: number, value: string) => {
        data.set(k, value);
        return 'OK';
      }),
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
    } as unknown as Redis;
    let loads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = () => {
      loads += 1;
      return gate.then(() => ({ status: 200, fromUrl: 'https://example.test/pkg', bodyText: 'new' }));
    };

    const served = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/pkg/', load);
    expect(served.bodyText).toBe('old');
    await vi.waitFor(() => expect(loads).toBe(1));
    const again = await getCachedDocument(redis, {} as never, 'pypi', 'default', 'simple/pkg/', load);
    expect(again.bodyText).toBe('old');
    expect(loads).toBe(1);
    release();
    await vi.waitFor(() => expect(data.get(key)).toContain('new'));
  });
});
