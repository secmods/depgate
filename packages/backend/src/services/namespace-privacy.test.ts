import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import type { PackageRoute } from './namespace-protection.js';

const fetchFromUpstream = vi.hoisted(() => vi.fn());
const fetchStreamFromUpstream = vi.hoisted(() => vi.fn());
const queryOSVBatch = vi.hoisted(() => vi.fn());
const lookupDepsBackup = vi.hoisted(() => vi.fn());

vi.mock('./upstream-provider.js', () => ({
  fetchFromUpstream: (...args: unknown[]) => fetchFromUpstream(...args),
  fetchStreamFromUpstream: (...args: unknown[]) => fetchStreamFromUpstream(...args),
}));
vi.mock('./osv-provider.js', () => ({ queryOSVBatch: (...args: unknown[]) => queryOSVBatch(...args) }));
vi.mock('./deps-dev.js', async (orig) => ({
  ...(await orig<object>()),
  lookupDepsBackup: (...args: unknown[]) => lookupDepsBackup(...args),
}));

import { factsKey, loadVersionFacts } from './package-facts.js';

const db = {} as DataSource;
const INTERNAL = {
  id: 'i1',
  key: 'acme-pypi',
  url: 'https://pypi.acme.test',
  timeoutMs: 1000,
  retryCount: 0,
  authType: null,
  authEncrypted: null,
  source: 'internal' as const,
};

function route(overrides: Partial<PackageRoute>): PackageRoute {
  return {
    ecosystem: 'pypi',
    repoKey: 'all',
    packageName: 'acme-auth',
    targets: [INTERNAL],
    cacheScope: 'all',
    reserved: null,
    monitored: [],
    skipped: [],
    block: null,
    ...overrides,
  };
}

const reserved = { policyId: 'p', policyName: 'acme', mode: 'enforce' as const, pattern: 'acme-*' };

describe('data-service privacy for reserved names (§6.3)', () => {
  beforeEach(() => {
    fetchFromUpstream.mockReset();
    fetchStreamFromUpstream.mockReset();
    queryOSVBatch.mockReset();
    lookupDepsBackup.mockReset();
    // The internal index has no license or date, which would normally make deps.dev fill them in.
    fetchFromUpstream.mockResolvedValue({
      status: 200,
      fromUrl: 'https://pypi.acme.test/pypi/acme-auth/json',
      body: { info: {}, releases: { '1.0.0': [{}] } },
    });
    queryOSVBatch.mockResolvedValue(new Map());
    lookupDepsBackup.mockResolvedValue(null);
  });

  for (const [label, r] of [
    ['enforce', route({ reserved, cacheScope: 'all~ns-abc' })],
    ['monitor', route({ monitored: [{ ...reserved, mode: 'monitor' as const }] })],
  ] as const) {
    it(`${label}: no OSV query and no deps.dev lookup; CVE facts are known and empty`, async () => {
      const facts = await loadVersionFacts(db, createMemoryRedis() as never, 'pypi', 'acme-auth', ['1.0.0'], { license: true, publishedAt: true, cve: true }, 'all', undefined, r);
      expect(queryOSVBatch).not.toHaveBeenCalled();
      expect(lookupDepsBackup).not.toHaveBeenCalled();
      expect(facts.get('1.0.0')).toMatchObject({ cveKnown: true, vulns: [], licenseKnown: true });
      expect(facts.get('1.0.0')?.cveUnavailable).toBeFalsy();
      expect(fetchFromUpstream).toHaveBeenCalledWith(db, 'pypi', 'pypi/acme-auth/json', { route: r });
    });
  }

  it('a reserved name served by a public remote is still not sent to deps.dev or OSV', async () => {
    const r = route({ reserved, cacheScope: 'all~ns-abc', targets: [{ ...INTERNAL, id: 'p1', key: 'jfrog', source: 'public' }] });
    await loadVersionFacts(db, createMemoryRedis() as never, 'pypi', 'acme-auth', ['1.0.0'], { license: true, publishedAt: true, cve: true }, 'all', undefined, r);
    expect(lookupDepsBackup).not.toHaveBeenCalled();
    expect(queryOSVBatch).not.toHaveBeenCalled();
  });

  it('a non-reserved name still asks OSV and deps.dev', async () => {
    await loadVersionFacts(db, createMemoryRedis() as never, 'pypi', 'requests', ['1.0.0'], { license: true, publishedAt: true, cve: true }, 'all', undefined, route({ packageName: 'requests' }));
    expect(queryOSVBatch).toHaveBeenCalledTimes(1);
    expect(lookupDepsBackup).toHaveBeenCalledTimes(1);
  });

  it('facts of an enforced reserved name are cached under the epoch scope, apart from a public copy', async () => {
    const redis = createMemoryRedis();
    await loadVersionFacts(db, redis as never, 'pypi', 'acme-auth', ['1.0.0'], { license: true, publishedAt: true, cve: false }, 'all', undefined, route({ reserved, cacheScope: 'all~ns-abc' }));
    expect(await redis.get(factsKey('pypi', 'all~ns-abc', 'acme-auth', '1.0.0'))).not.toBeNull();
    expect(await redis.get(factsKey('pypi', 'all', 'acme-auth', '1.0.0'))).toBeNull();
  });
});
