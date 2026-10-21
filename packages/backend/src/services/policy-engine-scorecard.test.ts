import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactNeed, SeededFacts, VersionFacts } from './package-facts.js';
import type { ScorecardLookup } from './scorecard-rule.js';

let lookup: ScorecardLookup = { status: 'unavailable' };

/** Returns only the fact types asked for, and the current `lookup` for Scorecard. */
const loadVersionFacts = vi.fn(
  async (_db: unknown, _redis: unknown, _eco: string, _pkg: string, versions: string[], need: FactNeed, _repo?: string, _seeded?: Map<string, SeededFacts>) => {
    const out = new Map<string, VersionFacts>();
    for (const version of versions) {
      out.set(version, {
        license: need.license ? 'MIT' : undefined,
        vulns: [],
        licenseKnown: need.license,
        publishedKnown: need.publishedAt,
        cveKnown: need.cve,
        scorecard: need.scorecard ? lookup : undefined,
      });
    }
    return out;
  }
);

vi.mock('./package-facts.js', () => ({
  loadVersionFacts: (...args: Parameters<typeof loadVersionFacts>) => loadVersionFacts(...args),
}));

import { evaluateDownloadVersion, evaluatePackageVersions, evaluatePackageVersionsDetailed } from './policy-engine.js';

type Row = { id: string; decision: string; conditions: Record<string, unknown>; mode?: string };

function dbWith(policies: Row[]) {
  const qb = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
  return {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
      if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
      return { find: async () => policies.map((p, i) => ({ ...p, name: p.id, priority: i, isEnabled: true })) };
    },
  } as never;
}

const fromDb = { policiesFromDatabase: true };
const found = (overall: number, checks: Record<string, number> = {}): ScorecardLookup => ({
  status: 'found',
  result: { project: 'github.com/x/y', via: 'registry', scoreVia: 'scorecard', date: '2026-10-06T00:00:00Z', overall, checks },
});

describe('Scorecard rule in the engine', () => {
  beforeEach(() => {
    loadVersionFacts.mockClear();
  });

  it('blocks a package whose repository scores below the minimum and serves one above it', async () => {
    const db = dbWith([{ id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5 } }]);
    lookup = found(3.4);
    const low = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(low.get('1.0')).toMatchObject({ decision: 'BLOCK', policyId: 'health' });
    expect(low.get('1.0')?.reasons[0]).toMatch(/^Scorecard 3\.4 is below 5 \(github\.com\/x\/y/);

    lookup = found(8.9);
    const high = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(high.get('1.0')).toBeNull();
    expect(loadVersionFacts.mock.calls[0][5]).toMatchObject({ scorecard: true, license: false, cve: false });
  });

  it('a failed lookup lets the version through and marks it incomplete, unless the policy blocks on it', async () => {
    lookup = { status: 'unavailable' };
    const open = dbWith([{ id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5 } }]);
    const allowed = await evaluatePackageVersionsDetailed(open, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(allowed.results.get('1.0.0')).toBeNull();
    expect(allowed.details.get('1.0.0')?.incomplete).toEqual(['scorecard']);

    const closed = dbWith([{ id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5, scorecardUnavailable: 'block' } }]);
    const blocked = await evaluatePackageVersionsDetailed(closed, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(blocked.results.get('1.0.0')?.reasons).toEqual(['OpenSSF Scorecard could not be checked for acme']);
    expect(blocked.details.get('1.0.0')?.incomplete).toEqual(['scorecard']);
  });

  it('never blocks where the rule does not apply, even with both options on block', async () => {
    const db = dbWith([
      { id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5, scorecardUnknown: 'block', scorecardUnavailable: 'block' } },
    ]);
    for (const reason of ['internal-remote', 'private-name'] as const) {
      lookup = { status: 'not-applicable', reason };
      const out = await evaluatePackageVersionsDetailed(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
      expect(out.results.get('1.0.0')).toBeNull();
      expect(out.details.get('1.0.0')?.incomplete).toEqual([]);
    }
  });

  it('a monitoring policy records the reason key for Monitoring', async () => {
    lookup = found(8, { 'Dangerous-Workflow': 0 });
    const db = dbWith([
      { id: 'health', decision: 'BLOCK', mode: 'monitor', conditions: { scorecardChecks: [{ name: 'Dangerous-Workflow', minScore: 10 }] } },
    ]);
    const out = await evaluateDownloadVersion(db, 'npm', 'acme', '1.0.0', undefined, null, undefined, fromDb);
    expect(out.result).toBeNull();
    expect(out.monitorMatches).toEqual([
      expect.objectContaining({ policyId: 'health', reasonKey: 'scorecard:Dangerous-Workflow' }),
    ]);
  });

  it('passes the npm version document repository as a seed, and nothing when it has none', async () => {
    lookup = found(9);
    const db = dbWith([{ id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5 } }]);
    await evaluatePackageVersions(
      db,
      'npm',
      'express',
      [
        { version: '4.21.2', versionMeta: { repository: { type: 'git', url: 'git+https://github.com/expressjs/express.git' } } },
        { version: '4.21.1', versionMeta: { dist: {} } },
      ],
      null,
      undefined,
      fromDb
    );
    const seeded = loadVersionFacts.mock.calls[0][7] as Map<string, SeededFacts>;
    expect(seeded.get('4.21.2')?.repository).toBe('git+https://github.com/expressjs/express.git');
    expect(seeded.get('4.21.1') && 'repository' in seeded.get('4.21.1')!).toBe(false);
  });

  it('settles a license, release age, vulnerability and Scorecard policy list without hitting the round guard', async () => {
    lookup = found(1);
    const db = dbWith([
      { id: 'license', decision: 'BLOCK', conditions: { licenseDenyList: ['GPL-*'] } },
      { id: 'age', decision: 'BLOCK', conditions: { releaseAgeMaxHours: 1 } },
      { id: 'cve', decision: 'BLOCK', conditions: { cveBlockList: ['CVE-2099-0001'] } },
      { id: 'health', decision: 'BLOCK', conditions: { scorecardMinScore: 5 } },
    ]);
    const out = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(out.get('1.0')?.policyId).toBe('health');
    expect(loadVersionFacts).toHaveBeenCalledTimes(4);
  });
});
