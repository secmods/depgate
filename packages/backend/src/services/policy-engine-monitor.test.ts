import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactNeed, VersionFacts } from './package-facts.js';

/** Facts every version gets: GPL-3.0, published two hours ago, one HIGH and one listed CVE. */
let facts: Partial<VersionFacts> = {};
const loadVersionFacts = vi.fn(
  async (_db: unknown, _redis: unknown, _eco: string, _pkg: string, versions: string[], need: FactNeed) => {
    const out = new Map<string, VersionFacts>();
    for (const version of versions) {
      out.set(version, {
        license: 'GPL-3.0',
        publishedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        vulns: need.cve
          ? [
              { id: 'GHSA-high', database_specific: { severity: 'HIGH' } },
              { id: 'CVE-2099-0001', database_specific: { severity: 'LOW' } },
            ]
          : [],
        licenseKnown: need.license,
        publishedKnown: need.publishedAt,
        cveKnown: need.cve,
        ...facts,
      });
    }
    return out;
  }
);

vi.mock('./package-facts.js', () => ({
  loadVersionFacts: (...args: Parameters<typeof loadVersionFacts>) => loadVersionFacts(...args),
}));

import { evaluateDownloadVersion, evaluatePackageVersions, evaluatePackageVersionsDetailed } from './policy-engine.js';

type TestPolicy = { id: string; decision?: string; mode?: string; conditions: Record<string, unknown> };
type TestException = { policyId?: string | null; version?: string };

function dbWith(
  policies: TestPolicy[],
  options: { exceptions?: TestException[]; malicious?: boolean } = {}
) {
  const exceptions = (options.exceptions ?? []).map((row) => ({
    policyId: row.policyId ?? null,
    version: row.version ?? '*',
    ecosystem: 'npm',
    packageName: 'acme',
  }));
  const qb = { where: () => qb, andWhere: () => qb, getMany: async () => exceptions };
  return {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
      if (entity?.name === 'MaliciousPackage') {
        return {
          findOne: async () =>
            options.malicious ? { name: 'acme', ecosystem: 'npm', overrideStatus: null, versionRange: null, reason: 'bad' } : null,
        };
      }
      return {
        find: async () =>
          policies.map((p, i) => ({
            decision: 'BLOCK',
            mode: 'enforce',
            modeChangedAt: null,
            ...p,
            name: p.id,
            priority: i,
            isEnabled: true,
          })),
      };
    },
  } as never;
}

const fromDb = { policiesFromDatabase: true };
const download = (db: never, version = '1.0.0', pkg = 'acme') =>
  evaluateDownloadVersion(db, 'npm', pkg, version, undefined, null, undefined, fromDb);

const LICENSE_MONITOR: TestPolicy = { id: 'license', mode: 'monitor', conditions: { licenseAllowList: ['MIT'] } };

beforeEach(() => {
  facts = {};
  loadVersionFacts.mockClear();
});

describe('monitor mode evaluation', () => {
  it('records a monitor match and lets the version through', async () => {
    const { result, monitorMatches } = await download(dbWith([LICENSE_MONITOR]));
    expect(result).toBeNull();
    expect(monitorMatches).toEqual([
      expect.objectContaining({
        policyId: 'license',
        policyName: 'license',
        reasonKey: 'GPL-3.0',
        reasons: ['License "GPL-3.0" is not in the approved list'],
      }),
    ]);
  });

  it('continues past a monitor match to a lower enforced policy, and records nothing when that one blocks', async () => {
    const block = { id: 'pkg', conditions: { packageBlockList: ['acme'] } };
    const { result, monitorMatches } = await download(dbWith([LICENSE_MONITOR, block]));
    expect(result?.policyId).toBe('pkg');
    expect(result?.decision).toBe('BLOCK');
    expect(monitorMatches).toEqual([]);
  });

  it('records once the lower enforced Block is gone (disabled policies are not loaded)', async () => {
    const { monitorMatches } = await download(dbWith([LICENSE_MONITOR]));
    expect(monitorMatches).toHaveLength(1);
  });

  it('records when a lower enforced Allow decides, since enforcing would block first', async () => {
    const allow = { id: 'allow', decision: 'ALLOW', conditions: { packageBlockList: ['acme'] } };
    const { result, monitorMatches } = await download(dbWith([LICENSE_MONITOR, allow]));
    expect(result?.decision).toBe('ALLOW');
    expect(monitorMatches.map((m) => m.policyId)).toEqual(['license']);
  });

  it('records nothing when a higher enforced Allow decides first', async () => {
    const allow = { id: 'allow', decision: 'ALLOW', conditions: { packageBlockList: ['acme'] } };
    const { result, monitorMatches } = await download(dbWith([allow, LICENSE_MONITOR]));
    expect(result?.decision).toBe('ALLOW');
    expect(monitorMatches).toEqual([]);
  });

  it('collects every monitoring policy that matches', async () => {
    const age = { id: 'age', mode: 'monitor', conditions: { releaseAgeMaxHours: 72 } };
    const { monitorMatches } = await download(dbWith([LICENSE_MONITOR, age]));
    expect(monitorMatches.map((m) => [m.policyId, m.reasonKey])).toEqual([
      ['license', 'GPL-3.0'],
      ['age', 'too_new'],
    ]);
  });

  it('no match under an all-policy exception', async () => {
    const { monitorMatches } = await download(dbWith([LICENSE_MONITOR], { exceptions: [{ policyId: null }] }));
    expect(monitorMatches).toEqual([]);
  });

  it('no match under an exception scoped to the policy', async () => {
    const { monitorMatches } = await download(dbWith([LICENSE_MONITOR], { exceptions: [{ policyId: 'license' }] }));
    expect(monitorMatches).toEqual([]);
  });

  it('still matches under an exception scoped to another policy', async () => {
    const { monitorMatches } = await download(dbWith([LICENSE_MONITOR], { exceptions: [{ policyId: 'other' }] }));
    expect(monitorMatches).toHaveLength(1);
  });

  it('a scoped exception covers only the versions it lists', async () => {
    const db = dbWith([LICENSE_MONITOR], { exceptions: [{ policyId: 'license', version: '=1.0.0 || =1.1.0' }] });
    expect((await download(db, '1.1.0')).monitorMatches).toEqual([]);
    expect((await download(db, '1.2.0')).monitorMatches).toHaveLength(1);
  });

  it('no match for a malicious package, and scoped exceptions do not lift the malware block', async () => {
    const { result, monitorMatches } = await download(
      dbWith([LICENSE_MONITOR], { malicious: true, exceptions: [{ policyId: 'license' }] })
    );
    expect(result?.policyId).toBe('malicious');
    expect(monitorMatches).toEqual([]);
  });

  it('a License-scoped approval does not bypass an enforced vulnerability policy', async () => {
    const license = { id: 'license', conditions: { licenseAllowList: ['MIT'] } };
    const cve = { id: 'cve', conditions: { cvssMin: 7 } };
    const db = dbWith([license, cve], { exceptions: [{ policyId: 'license' }] });
    const { result } = await download(db);
    expect(result?.policyId).toBe('cve');
  });

  it('an enforced policy skipped by its own scoped exception lets the version through', async () => {
    const license = { id: 'license', conditions: { licenseAllowList: ['MIT'] } };
    const { result } = await download(dbWith([license], { exceptions: [{ policyId: 'license' }] }));
    expect(result).toBeNull();
  });

  it('an Allow policy never monitors, whatever its mode column says', async () => {
    const allow = { id: 'allow', decision: 'ALLOW', mode: 'monitor', conditions: { packageBlockList: ['acme'] } };
    const block = { id: 'block', conditions: { packageBlockList: ['acme'] } };
    const { result } = await download(dbWith([allow, block]));
    expect(result?.decision).toBe('ALLOW');
  });
});

describe('metadata requests', () => {
  it('ignore monitoring policies and load no facts for them', async () => {
    const results = await evaluatePackageVersions(dbWith([LICENSE_MONITOR]), 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(results.get('1.0.0')).toBeNull();
    expect(loadVersionFacts).not.toHaveBeenCalled();
  });

  it('Package check sees monitor matches without anything being recorded', async () => {
    const { results, monitor } = await evaluatePackageVersionsDetailed(
      dbWith([LICENSE_MONITOR]),
      'npm',
      'acme',
      [{ version: '1.0.0' }],
      null,
      undefined,
      { ...fromDb, monitor: true }
    );
    expect(results.get('1.0.0')).toBeNull();
    expect(monitor.get('1.0.0')?.[0]?.policyName).toBe('license');
  });
});

describe('reason keys', () => {
  const keyFor = async (conditions: Record<string, unknown>, version = '1.0.0', pkg = 'acme') =>
    (await download(dbWith([{ id: 'm', mode: 'monitor', conditions }]), version, pkg)).monitorMatches[0]?.reasonKey;

  it('Packages: the pattern that matched', async () => {
    expect(await keyFor({ packageBlockList: ['other', 'ac*'] })).toBe('ac*');
  });

  it('Release type: the type', async () => {
    expect(await keyFor({ releaseTypes: ['prerelease'] }, '2.0.0-rc.1')).toBe('prerelease');
  });

  it('Release age: too_new or unmaintained', async () => {
    expect(await keyFor({ releaseAgeMaxHours: 72 })).toBe('too_new');
    facts = { publishedAt: new Date(Date.now() - 800 * 86_400_000).toISOString() };
    expect(await keyFor({ releaseAgeMinDays: 365 })).toBe('unmaintained');
  });

  it('Vulnerability: the listed CVE, else the advisory that met the CVSS minimum', async () => {
    expect(await keyFor({ cveBlockList: ['CVE-2099-0001'], cvssMin: 7 })).toBe('cve:CVE-2099-0001');
    expect(await keyFor({ cvssMin: 0.1 })).toBe('cvss:GHSA-high');
  });

  it('License: the normalized expression, or UNKNOWN', async () => {
    facts = { license: '(MIT or GPL-3.0)' };
    expect(await keyFor({ licenseDenyList: ['MIT', 'GPL-3.0'] })).toBe('MIT OR GPL-3.0');
    facts = { license: undefined };
    expect(await keyFor({ licenseAllowList: ['MIT'] })).toBe('UNKNOWN');
  });
});
