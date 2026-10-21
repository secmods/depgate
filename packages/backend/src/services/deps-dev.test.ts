import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createMemoryRedis } from '../test-support/memory-redis.js';

const resolveRemoteTargets = vi.hoisted(() => vi.fn());

vi.mock('./repository-resolve.js', () => ({
  resolveRemoteTargets: (...args: unknown[]) => resolveRemoteTargets(...args),
}));

import { hostIsPublicRegistry, lookupDepsBackup, spdxLicense } from './deps-dev.js';

const db = {} as DataSource;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('deps.dev backup', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resolveRemoteTargets.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('keeps SPDX ids and drops non-standard', () => {
    expect(spdxLicense(undefined)).toBeUndefined();
    expect(spdxLicense(['non-standard'])).toBeUndefined();
    expect(spdxLicense(['Apache-2.0'])).toBe('Apache-2.0');
    expect(spdxLicense(['MIT', 'Apache-2.0'])).toBe('MIT AND Apache-2.0');
    expect(spdxLicense(['MIT OR Apache-2.0', 'Unicode-3.0'])).toBe('(MIT OR Apache-2.0) AND Unicode-3.0');
  });

  it('recognizes the public registries deps.dev indexes', () => {
    expect(hostIsPublicRegistry('maven', 'https://repo1.maven.org/maven2')).toBe(true);
    expect(hostIsPublicRegistry('go', 'https://proxy.golang.org')).toBe(true);
    expect(hostIsPublicRegistry('maven', 'https://nexus.example/maven')).toBe(false);
    expect(hostIsPublicRegistry('composer', 'https://repo.packagist.org')).toBe(false);
  });

  it('does not call deps.dev for an internal upstream', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://nexus.example/maven', source: 'internal' }]);
    const backup = await lookupDepsBackup(db, null, 'maven', 'internal', 'junit:junit', {
      dates: true,
      licenseVersions: ['4.13.2'],
    });
    expect(backup).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls deps.dev for a remote marked public on any host, such as a JFrog remote', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://acme.jfrog.io/artifactory/api/npm/npm-remote', source: 'public' }]);
    fetchMock.mockResolvedValue(jsonResponse(200, { versions: [{ versionKey: { version: '1.0.0' }, publishedAt: '2025-01-01T00:00:00Z' }] }));
    const backup = await lookupDepsBackup(db, null, 'npm', 'jfrog', 'left-pad', { dates: true, licenseVersions: [] });
    expect(backup?.publishedAt.get('1.0.0')).toBe('2025-01-01T00:00:00.000Z');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls deps.dev for a known public host even when it is marked internal', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://registry.npmjs.org', source: 'internal' }]);
    fetchMock.mockResolvedValue(jsonResponse(200, { versions: [] }));
    expect(await lookupDepsBackup(db, null, 'npm', 'npmjs', 'left-pad', { dates: true, licenseVersions: [] })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call deps.dev when one remote of the repository is internal on a private host', async () => {
    resolveRemoteTargets.mockResolvedValue([
      { url: 'https://registry.npmjs.org', source: 'public' },
      { url: 'https://acme.jfrog.io/artifactory/api/npm/npm-local', source: 'internal' },
    ]);
    expect(await lookupDepsBackup(db, null, 'npm', 'all', 'left-pad', { dates: true, licenseVersions: [] })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call deps.dev for composer, even from a public remote', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://repo.packagist.org', source: 'public' }]);
    expect(await lookupDepsBackup(db, null, 'composer', 'default', 'monolog/monolog', { dates: true, licenseVersions: [] })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads publish times once and a license only for the requested version', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://repo1.maven.org/maven2', source: 'public' }]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/versions/1.5.0')) {
        return jsonResponse(200, { publishedAt: '2025-07-17T17:29:53Z', licenses: ['Apache-2.0'] });
      }
      return jsonResponse(200, {
        versions: [
          { versionKey: { version: '1.5.0' }, publishedAt: '2025-07-17T17:29:53Z' },
          { versionKey: { version: '1.7.11' }, publishedAt: '2026-09-20T02:03:49Z' },
        ],
      });
    });

    const redis = createMemoryRedis() as unknown as Redis;
    const first = await lookupDepsBackup(db, redis, 'maven', 'default', 'aws.smithy.kotlin:runtime-core-jvm', {
      dates: true,
      licenseVersions: ['1.5.0'],
    });
    expect(first?.publishedAt.get('1.5.0')).toBe('2025-07-17T17:29:53.000Z');
    expect(first?.packageLastReleaseAt).toBe('2026-09-20T02:03:49.000Z');
    expect(first?.licenses.get('1.5.0')).toBe('Apache-2.0');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    const second = await lookupDepsBackup(db, redis, 'maven', 'default', 'aws.smithy.kotlin:runtime-core-jvm', {
      dates: true,
      licenseVersions: ['1.5.0'],
    });
    expect(second?.licenses.get('1.5.0')).toBe('Apache-2.0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remembers a miss briefly and does not throw', async () => {
    resolveRemoteTargets.mockResolvedValue([{ url: 'https://proxy.golang.org', source: 'public' }]);
    fetchMock.mockResolvedValue(jsonResponse(404, null));
    const redis = createMemoryRedis() as unknown as Redis;

    const missed = await lookupDepsBackup(db, redis, 'go', 'default', 'rsc.io/quote', {
      dates: true,
      licenseVersions: [],
    });
    expect(missed?.publishedAt.size).toBe(0);
    expect(missed?.packageLastReleaseAt).toBeUndefined();

    fetchMock.mockClear();
    await lookupDepsBackup(db, redis, 'go', 'default', 'rsc.io/quote', {
      dates: true,
      licenseVersions: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
