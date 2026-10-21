import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import { withPlainRoutes } from '../test-support/plain-route.js';

const fetchFromUpstream = vi.hoisted(() => vi.fn());
const fetchStreamFromUpstream = vi.hoisted(() => vi.fn());
const resolveRemoteTargets = vi.hoisted(() => vi.fn());

vi.mock('./upstream-provider.js', () => ({
  fetchFromUpstream: (...args: unknown[]) => fetchFromUpstream(...args),
  fetchStreamFromUpstream: (...args: unknown[]) => fetchStreamFromUpstream(...args),
}));

vi.mock('./repository-resolve.js', () => ({
  resolveRemoteTargets: (...args: unknown[]) => resolveRemoteTargets(...args),
}));

vi.mock('./osv-provider.js', () => ({
  queryOSVBatch: vi.fn(),
}));

vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

import { loadVersionFacts } from './package-facts.js';

const db = {} as DataSource;
const need = { license: true, publishedAt: true, cve: false };

function streamResponse(status: number, text: string, headers: Record<string, string> = {}) {
  return {
    status,
    fromUrl: 'https://upstream.test/x',
    headers: new Headers(headers),
    body: Readable.from([Buffer.from(text)]),
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('deps.dev fact backup', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchFromUpstream.mockReset();
    fetchStreamFromUpstream.mockReset();
    resolveRemoteTargets.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://repo1.maven.org/maven2' }]);
  });

  it('fills a missing Maven publish time and license without replacing a registry value', async () => {
    fetchStreamFromUpstream.mockImplementation(async (_db: unknown, _eco: string, path: string) => {
      if (path.endsWith('maven-metadata.xml')) {
        return streamResponse(200, '<metadata><versioning><lastUpdated>20240601000000</lastUpdated></versioning></metadata>');
      }
      if (path.endsWith('junit-4.12.pom')) {
        return streamResponse(200, '<project><licenses><license><name>EPL-1.0</name></license></licenses></project>', {
          'last-modified': 'Thu, 04 Dec 2014 16:17:43 GMT',
        });
      }
      if (path.endsWith('junit-4.13.2.pom')) return streamResponse(200, '<project/>');
      return streamResponse(404, '');
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/versions/')) {
        return jsonResponse(200, { licenses: ['Apache-2.0'], publishedAt: '2021-02-13T16:31:54Z' });
      }
      return jsonResponse(200, {
        versions: [
          { versionKey: { version: '4.12' }, publishedAt: '2014-12-04T16:17:43Z' },
          { versionKey: { version: '4.13.2' }, publishedAt: '2021-02-13T16:31:54Z' },
        ],
      });
    });

    const facts = await loadVersionFacts(db, createMemoryRedis() as unknown as Redis, 'maven', 'junit:junit', ['4.12', '4.13.2'], need, 'default');
    expect(facts.get('4.12')?.license).toBe('EPL-1.0');
    expect(facts.get('4.12')?.publishedAt).toBe('2014-12-04T16:17:43.000Z');
    expect(facts.get('4.12')?.packageLastReleaseAt).toBe('2024-06-01T00:00:00.000Z');
    expect(facts.get('4.13.2')?.license).toBe('Apache-2.0');
    expect(facts.get('4.13.2')?.publishedAt).toBe('2021-02-13T16:31:54.000Z');
    const called = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(called.some((url) => url.includes('/versions/4.12'))).toBe(false);
    expect(called.some((url) => url.includes('/versions/4.13.2'))).toBe(true);
  });

  it('does not consult deps.dev for a private repository', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://nexus.example/maven' }]);
    fetchStreamFromUpstream.mockResolvedValue(streamResponse(200, '<project/>'));
    const facts = await loadVersionFacts(db, null, 'maven', 'junit:junit', ['4.13.2'], need, 'internal');
    expect(facts.get('4.13.2')?.license).toBeUndefined();
    expect(facts.get('4.13.2')?.publishedAt).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the Go proxy time and deps.dev for the license and newest release', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://proxy.golang.org' }]);
    fetchStreamFromUpstream.mockResolvedValue(streamResponse(200, JSON.stringify({ Time: '2018-02-14T15:44:20Z' })));
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/versions/')) {
        return jsonResponse(200, { licenses: ['BSD-3-Clause'], publishedAt: '2018-02-14T15:44:20Z' });
      }
      return jsonResponse(200, {
        versions: [
          { versionKey: { version: 'v1.5.2' }, publishedAt: '2018-02-14T15:44:20Z' },
          { versionKey: { version: 'v1.5.3' }, publishedAt: '2018-08-14T00:00:00Z' },
        ],
      });
    });

    const facts = await loadVersionFacts(db, null, 'go', 'rsc.io/quote', ['v1.5.2'], need, 'default');
    expect(facts.get('v1.5.2')?.publishedAt).toBe('2018-02-14T15:44:20.000Z');
    expect(facts.get('v1.5.2')?.license).toBe('BSD-3-Clause');
    expect(facts.get('v1.5.2')?.packageLastReleaseAt).toBe('2018-08-14T00:00:00.000Z');
  });
});
