import { describe, it, expect, afterEach } from 'vitest';
import {
  buildAuthHeaders,
  describeFetchError,
  encodeAuth,
  fetchFromUpstream,
  fetchStreamFromUpstream,
  fetchUpstreamResponse,
  parseAuth,
} from './upstream-provider.js';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { DataSource } from 'typeorm';

describe('upstream-provider', () => {
  describe('buildAuthHeaders', () => {
    it('returns empty for null', () => {
      expect(buildAuthHeaders(null)).toEqual({});
    });

    it('builds Bearer header for bearer auth', () => {
      expect(buildAuthHeaders({ type: 'bearer', token: 'abc123' })).toEqual({
        Authorization: 'Bearer abc123',
      });
    });

    it('builds Basic header for basic auth', () => {
      const headers = buildAuthHeaders({
        type: 'basic',
        username: 'user',
        password: 'pass',
      });
      expect(headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    });

    it('builds custom header for header auth', () => {
      expect(
        buildAuthHeaders({
          type: 'header',
          headerName: 'X-API-Key',
          value: 'secret',
        })
      ).toEqual({ 'X-API-Key': 'secret' });
    });
  });

  describe('parseAuth', () => {
    it('returns null when no auth', () => {
      const reg = { authEncrypted: null, authType: null } as UpstreamRegistry;
      expect(parseAuth(reg)).toBeNull();
    });

    it('reads what encodeAuth stored', () => {
      const reg = { authEncrypted: encodeAuth({ username: 'ci', password: 's3cret' }), authType: 'basic' } as UpstreamRegistry;
      expect(parseAuth(reg)).toEqual({ type: 'basic', username: 'ci', password: 's3cret' });
    });

    it('stores credentials encrypted, not readable', () => {
      const enc = encodeAuth({ token: 'xyz-token' });
      expect(enc.startsWith('v1:')).toBe(true);
      expect(enc).not.toContain('xyz-token');
      expect(Buffer.from(enc, 'base64').toString('utf8')).not.toContain('xyz-token');
      expect(encodeAuth({ token: 'xyz-token' })).not.toBe(enc);
    });

    it('ignores the old base64 form', () => {
      const enc = Buffer.from(JSON.stringify({ token: 'xyz' })).toString('base64');
      expect(parseAuth({ authEncrypted: enc, authType: 'bearer' })).toBeNull();
    });

    it('returns null when the value was tampered with', () => {
      const [version, iv, tag, body] = encodeAuth({ token: 'xyz' }).split(':');
      const flipped = Buffer.from(body, 'base64');
      flipped[0] ^= 1;
      expect(parseAuth({ authEncrypted: [version, iv, tag, flipped.toString('base64')].join(':'), authType: 'bearer' })).toBeNull();
    });
  });

  describe('registry fallback', () => {
    it('tries next registry when first returns 404', async () => {
      const originalFetch = global.fetch;
      global.fetch = (async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes('bad-registry')) {
          return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const db = {
        getRepository: () => ({
          find: async () => ([
            { id: 'r1', ecosystem: 'npm', url: 'https://bad-registry.example', isEnabled: true, priority: 0, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
            { id: 'r2', ecosystem: 'npm', url: 'https://good-registry.example', isEnabled: true, priority: 1, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
          ] as UpstreamRegistry[]),
        }),
      } as unknown as DataSource;

      try {
        const result = await fetchFromUpstream(db, 'npm', 'lodash');
        expect(result.status).toBe(200);
        expect(result.fromUrl).toContain('good-registry.example');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns 404 when all registries return 404', async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;

      const db = {
        getRepository: () => ({
          find: async () => ([
            { id: 'r1', ecosystem: 'npm', url: 'https://bad1.example', isEnabled: true, priority: 0, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
            { id: 'r2', ecosystem: 'npm', url: 'https://bad2.example', isEnabled: true, priority: 1, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
          ] as UpstreamRegistry[]),
        }),
      } as unknown as DataSource;

      try {
        const result = await fetchFromUpstream(db, 'npm', 'lodash');
        expect(result.status).toBe(404);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('stream fetch falls back to next registry when first returns 404', async () => {
      const originalFetch = global.fetch;
      global.fetch = (async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes('bad-registry')) {
          return new Response('', { status: 404 });
        }
        return new Response('tarball-bytes', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }) as typeof fetch;

      const db = {
        getRepository: () => ({
          find: async () => ([
            { id: 'r1', ecosystem: 'npm', url: 'https://bad-registry.example', isEnabled: true, priority: 0, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
            { id: 'r2', ecosystem: 'npm', url: 'https://good-registry.example', isEnabled: true, priority: 1, timeoutMs: 30000, retryCount: 0, authType: null, authEncrypted: null },
          ] as UpstreamRegistry[]),
        }),
      } as unknown as DataSource;

      try {
        const result = await fetchStreamFromUpstream(db, 'npm', 'lodash/-/lodash-1.0.0.tgz');
        expect(result.status).toBe(200);
        expect(result.fromUrl).toContain('good-registry.example');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});

describe('fetchUpstreamResponse', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function connectError(code: string): Error {
    return new TypeError('fetch failed', { cause: Object.assign(new Error(''), { code }) });
  }

  it('retries a transport error and returns the answer that follows', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      if (calls < 3) throw connectError('ETIMEDOUT');
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const res = await fetchUpstreamResponse('https://registry.test/x', { retryCount: 3, timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });

  it('does not retry an HTTP answer', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return new Response('busy', { status: 503 });
    }) as typeof fetch;
    const res = await fetchUpstreamResponse('https://registry.test/x', { retryCount: 3 });
    expect(res.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('gives up after retryCount and names the cause', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      throw connectError('ECONNRESET');
    }) as typeof fetch;
    await expect(fetchUpstreamResponse('https://registry.test/x', { retryCount: 1, timeoutMs: 5000 })).rejects.toThrow(
      'fetch failed: ECONNRESET'
    );
    expect(calls).toBe(2);
  });

  it('stops at the deadline instead of retrying a timeout', async () => {
    let calls = 0;
    global.fetch = ((_url: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    await expect(fetchUpstreamResponse('https://registry.test/x', { retryCount: 3, timeoutMs: 50 })).rejects.toThrow(
      'timed out after 50 ms'
    );
    expect(calls).toBe(1);
  });

  it('describeFetchError prefers the cause message over its code', () => {
    const err = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo EAI_AGAIN codeload.github.com'), { code: 'EAI_AGAIN' }),
    });
    expect(describeFetchError(err)).toBe('fetch failed: getaddrinfo EAI_AGAIN codeload.github.com');
  });
});
