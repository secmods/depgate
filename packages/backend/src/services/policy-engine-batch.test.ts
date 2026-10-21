import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluatePackageVersions, filterPackumentVersions } from './policy-engine.js';
import { abbreviatePackument } from './npm-packument.js';
import { bindReferencePublisher, bumpReference, resetReferenceCache } from './reference-cache.js';

function dbWithPolicies(policies: Array<Record<string, unknown>>) {
  const qb = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
  return {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
      if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
      return { find: async () => policies };
    },
  };
}

describe('filterPackumentVersions on an abbreviated npm document', () => {
  it('filters versions that are too new, using the kept time map', async () => {
    const now = Date.now();
    const full = {
      name: 'fresh-pkg',
      time: {
        '1.0.0': new Date(now - 30 * 24 * 3600 * 1000).toISOString(),
        '1.1.0': new Date(now - 3600 * 1000).toISOString(),
      },
      versions: {
        '1.0.0': { version: '1.0.0', dist: { tarball: 'https://x/fresh-pkg-1.0.0.tgz' } },
        '1.1.0': { version: '1.1.0', dist: { tarball: 'https://x/fresh-pkg-1.1.0.tgz' } },
      },
    };
    const db = dbWithPolicies([
      {
        id: 'p-age',
        name: 'Too new',
        decision: 'BLOCK',
        priority: 0,
        isEnabled: true,
        conditions: { releaseAgeMaxHours: 72 },
      },
    ]);

    const { filtered, blockedVersions } = await filterPackumentVersions(db as never, 'npm', abbreviatePackument(full), null);
    expect(Object.keys(filtered)).toEqual(['1.0.0']);
    expect(Object.keys(blockedVersions)).toEqual(['1.1.0']);
  });
});

vi.mock('./osv-provider.js', () => ({
  queryOSVBatch: vi.fn(async () => new Map()),
  getVulnIds: () => [],
  hasVulnInBlockList: () => false,
}));

describe('evaluatePackageVersions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses one exceptions and malicious query for many versions', async () => {
    let exceptions = 0;
    let malicious = 0;
    let policies = 0;
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      getMany: async () => {
        exceptions += 1;
        return [];
      },
    };
    const db = {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
        if (entity?.name === 'MaliciousPackage') {
          return {
            findOne: async () => {
              malicious += 1;
              return null;
            },
          };
        }
        return {
          find: async () => {
            policies += 1;
            return [
              {
                id: 'p1',
                name: 'block other',
                decision: 'BLOCK',
                priority: 0,
                isEnabled: true,
                conditions: { packageBlockList: ['not-this-package'] },
              },
            ];
          },
        };
      },
    };

    const versions = Array.from({ length: 300 }, (_, index) => ({ version: `1.0.${index}` }));
    const decided = await evaluatePackageVersions(
      db as never,
      'npm',
      'left-pad',
      versions,
      null
    );

    expect(decided.size).toBe(300);
    expect(exceptions).toBe(1);
    expect(malicious).toBe(1);
    expect(policies).toBe(1);
    expect([...decided.values()].every((result) => result === null)).toBe(true);
  });
});

describe('evaluatePackageVersions with the reference cache', () => {
  afterEach(() => {
    vi.useRealTimers();
    bindReferencePublisher(null);
    resetReferenceCache();
  });

  function countingDb(exceptionRows: () => Array<Record<string, unknown>>, policies: Array<Record<string, unknown>> = []) {
    const calls = { exceptions: 0, malicious: 0 };
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      getMany: async () => {
        calls.exceptions += 1;
        return exceptionRows();
      },
    };
    const db = {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
        if (entity?.name === 'MaliciousPackage') {
          return {
            findOne: async () => {
              calls.malicious += 1;
              return null;
            },
          };
        }
        return { find: async () => policies };
      },
    };
    return { db, calls };
  }

  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      get: async (key: string) => store.get(key) ?? null,
      incr: async (key: string) => {
        const next = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(next));
        return next;
      },
      publish: async () => 1,
    };
  }

  it('queries exceptions and the malware list once per package until either changes', async () => {
    bindReferencePublisher(fakeRedis() as never);
    const { db, calls } = countingDb(() => []);
    const evaluate = () => evaluatePackageVersions(db as never, 'npm', 'left-pad', [{ version: '1.0.0' }], null);

    await evaluate();
    await evaluate();
    expect(calls).toEqual({ exceptions: 1, malicious: 1 });

    await bumpReference('malicious');
    await evaluate();
    expect(calls).toEqual({ exceptions: 1, malicious: 2 });

    await bumpReference('exceptions');
    await evaluate();
    expect(calls).toEqual({ exceptions: 2, malicious: 2 });
  });

  it('stops using a kept exception the moment it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
    bindReferencePublisher(fakeRedis() as never);
    const expiresAt = new Date('2026-10-18T10:00:30Z');
    const { db, calls } = countingDb(
      () =>
        Date.now() < expiresAt.getTime()
          ? [{ id: 'e1', policyId: null, version: '*', repositoryIds: null, expiresAt, reason: 'approved' }]
          : [],
      [{ id: 'p1', name: 'block left-pad', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { packageBlockList: ['left-pad'] } }]
    );
    const evaluate = async () =>
      (await evaluatePackageVersions(db as never, 'npm', 'left-pad', [{ version: '1.0.0' }], null)).get('1.0.0');

    expect(await evaluate()).toBeNull();
    expect(await evaluate()).toBeNull();
    expect(calls.exceptions).toBe(1);

    vi.setSystemTime(new Date('2026-10-18T10:00:31Z'));
    expect((await evaluate())?.decision).toBe('BLOCK');
    expect(calls.exceptions).toBe(2);
  });
});
