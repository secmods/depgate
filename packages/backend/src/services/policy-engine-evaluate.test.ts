import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOSVMock } = vi.hoisted(() => ({
  queryOSVMock: vi.fn(),
}));

vi.mock('./osv-provider.js', () => ({
  queryOSV: queryOSVMock,
  queryOSVBatch: async (
    redis: unknown,
    ecosystem: string,
    pkg: string,
    versions: string[]
  ) => {
    const out = new Map<string, Array<{ id?: string }>>();
    for (const version of versions) {
      const resp = (await queryOSVMock(redis, ecosystem, pkg, version)) as { vulns?: Array<{ id?: string }> };
      out.set(version, resp?.vulns ?? []);
    }
    return out;
  },
  getVulnIds: (vulns: Array<{ id?: string }>) => vulns.map((v) => v.id).filter(Boolean),
  hasVulnInBlockList: (ids: string[], blockList: string[]) => {
    const blockSet = new Set(blockList.map((b) => b.toUpperCase()));
    return ids.some((id) => blockSet.has(id.toUpperCase()));
  },
}));

vi.mock('./exception-service.js', () => ({
  hasActiveException: vi.fn(async () => false),
  matchesAnyException: () => false,
  matchingException: () => undefined,
}));

vi.mock('./malicious-sync.js', () => ({
  isMaliciousPackage: vi.fn(async () => ({ blocked: false })),
  findMaliciousEntry: async () => null,
  findMaliciousEntryCached: async () => null,
  maliciousMatch: () => ({ blocked: false }),
  malwareListed: () => null,
}));

import { evaluatePackageVersion } from './policy-engine.js';

describe('policy-engine evaluatePackageVersion CVE logic', () => {
  beforeEach(() => {
    queryOSVMock.mockReset();
  });

  function makeDb(policies: Array<Record<string, unknown>>) {
    const qb = {
      where: () => qb,
      andWhere: () => qb,
      getMany: async () => [],
    };
    return {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
        if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
        return { find: async () => policies };
      },
    } as unknown as Parameters<typeof evaluatePackageVersion>[0];
  }

  it('returns BLOCK when cveBlockList matches OSV vuln IDs', async () => {
    queryOSVMock.mockResolvedValue({
      vulns: [{ id: 'CVE-UNIT-2026-0001', severity: [] }],
    });

    const db = makeDb([
      {
        id: '00000000-0000-0000-0000-000000000111',
        name: 'Block CVE IDs',
        decision: 'BLOCK',
        isEnabled: true,
        priority: 0,
        conditions: { ecosystem: ['npm'], cveBlockList: ['CVE-UNIT-2026-0001'] },
      },
    ]);

    const result = await evaluatePackageVersion(
      db,
      'npm',
      'lodash',
      '4.17.5',
      undefined,
      {} as never
    );

    expect(result).not.toBeNull();
    expect(result?.decision).toBe('BLOCK');
    expect(result?.policyName).toBe('Block CVE IDs');
    expect((result?.reasons ?? []).join(' ')).toContain('CVE');
  });

  it('returns null when cveBlockList does not match', async () => {
    queryOSVMock.mockResolvedValue({
      vulns: [{ id: 'CVE-UNIT-2026-9999', severity: [] }],
    });

    const db = makeDb([
      {
        id: '00000000-0000-0000-0000-000000000222',
        name: 'Block known CVEs only',
        decision: 'BLOCK',
        isEnabled: true,
        priority: 0,
        conditions: { ecosystem: ['npm'], cveBlockList: ['CVE-UNIT-2026-0001'] },
      },
    ]);

    const result = await evaluatePackageVersion(
      db,
      'npm',
      'lodash',
      '4.17.5',
      undefined,
      {} as never
    );

    expect(result).toBeNull();
  });

  it('blocks only versions inside the package version range', async () => {
    const db = makeDb([
      {
        id: '00000000-0000-0000-0000-000000000333',
        name: 'express',
        decision: 'BLOCK',
        isEnabled: true,
        priority: 0,
        conditions: {
          ecosystem: ['npm'],
          packageBlockList: ['express'],
          versionRange: '5.0.0 - 5.2.1',
        },
      },
    ]);
    const options = { policiesFromDatabase: true };

    const inside = await evaluatePackageVersion(db, 'npm', 'express', '5.1.0', undefined, null, undefined, options);
    const below = await evaluatePackageVersion(db, 'npm', 'express', '4.21.2', undefined, null, undefined, options);
    const above = await evaluatePackageVersion(db, 'npm', 'express', '5.2.2', undefined, null, undefined, options);
    const other = await evaluatePackageVersion(db, 'npm', 'lodash', '5.1.0', undefined, null, undefined, options);

    expect(inside?.decision).toBe('BLOCK');
    expect(inside?.reasons.join(' ')).toContain('5.0.0 - 5.2.1');
    expect(below).toBeNull();
    expect(above).toBeNull();
    expect(other).toBeNull();
  });
});
