import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactNeed, VersionFacts } from './package-facts.js';
import type { OSVVuln } from './osv-provider.js';
import type { EpssValue } from './epss-feed.js';
import { V31_7_5 } from '../test-support/cvss-vectors.js';

let vulns: OSVVuln[] = [];
let epss = new Map<string, EpssValue>();

/** CVE data when asked, and EPSS only when the engine asks for it too. */
const loadVersionFacts = vi.fn(async (_db: unknown, _redis: unknown, _eco: string, _pkg: string, versions: string[], need: FactNeed) => {
  const out = new Map<string, VersionFacts>();
  for (const version of versions) {
    out.set(version, {
      vulns: need.cve ? vulns : [],
      license: need.license ? 'MIT' : undefined,
      licenseKnown: need.license,
      publishedKnown: need.publishedAt,
      cveKnown: need.cve,
      ...(need.epss ? { epss, epssKnown: true, epssDate: '2026-10-11' } : {}),
    });
  }
  return out;
});

vi.mock('./package-facts.js', () => ({
  loadVersionFacts: (...args: Parameters<typeof loadVersionFacts>) => loadVersionFacts(...args),
}));

import { evaluateDownloadVersion, evaluatePackageVersions } from './policy-engine.js';

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
const high = (cve: string): OSVVuln => ({ id: `GHSA-${cve}`, aliases: [cve], severity: [{ type: 'CVSS_V3', score: V31_7_5 }] });

describe('EPSS in the Vulnerability rule', () => {
  beforeEach(() => {
    loadVersionFacts.mockClear();
  });

  it('"CVSS ≥ 7 + EPSS ≥ 10 %" blocks a CVSS 7.5 vulnerability at 42 % and serves one at 2 %', async () => {
    const db = dbWith([{ id: 'exploitable', decision: 'BLOCK', conditions: { cvssMin: 7, epssMin: 0.1 } }]);
    vulns = [high('CVE-2024-0001')];
    epss = new Map([['CVE-2024-0001', { score: 0.42, percentile: 0.97 }]]);
    const blocked = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(blocked.get('1.0.0')?.reasons).toEqual(['GHSA-CVE-2024-0001 (CVE-2024-0001): CVSS 3.1 7.5, EPSS 42 % (97th percentile, 2026-10-11)']);
    expect(loadVersionFacts.mock.calls[0][5]).toMatchObject({ cve: true, epss: true });
    expect(loadVersionFacts).toHaveBeenCalledTimes(1);

    epss = new Map([['CVE-2024-0001', { score: 0.02, percentile: 0.6 }]]);
    const served = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(served.get('1.0.0')).toBeNull();
  });

  it('never synced: "match" behaves like CVSS only, "ignore" blocks nothing by EPSS', async () => {
    vulns = [high('CVE-2024-0001')];
    epss = new Map();
    const matchUnknown = dbWith([{ id: 'p', decision: 'BLOCK', conditions: { cvssMin: 7, epssMin: 0.1 } }]);
    expect((await evaluatePackageVersions(matchUnknown, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb)).get('1.0.0')?.decision).toBe('BLOCK');
    const ignoreUnknown = dbWith([{ id: 'p', decision: 'BLOCK', conditions: { cvssMin: 7, epssMin: 0.1, epssUnknown: 'ignore' } }]);
    expect((await evaluatePackageVersions(ignoreUnknown, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb)).get('1.0.0')).toBeNull();
  });

  it('a policy without EPSS fields does not ask for EPSS', async () => {
    vulns = [high('CVE-2024-0001')];
    const db = dbWith([{ id: 'cvss', decision: 'BLOCK', conditions: { cvssMin: 7 } }]);
    const out = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(out.get('1.0.0')?.reasons).toEqual(['GHSA-CVE-2024-0001 (CVE-2024-0001): CVSS 3.1 7.5']);
    expect(loadVersionFacts.mock.calls[0][5].epss).toBe(false);
  });

  it('a policy saved with a severity threshold still blocks, as a CVSS minimum', async () => {
    vulns = [high('CVE-2024-0001')];
    const high7 = dbWith([{ id: 'sev', decision: 'BLOCK', conditions: { cveSeverityThreshold: 'HIGH' } }]);
    expect((await evaluatePackageVersions(high7, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb)).get('1.0.0')?.decision).toBe('BLOCK');
    const critical9 = dbWith([{ id: 'sev', decision: 'BLOCK', conditions: { cveSeverityThreshold: 'CRITICAL' } }]);
    expect((await evaluatePackageVersions(critical9, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb)).get('1.0.0')).toBeNull();
  });

  it('a CVSS-only policy first, then an EPSS policy: EPSS is loaded in a later round and both decide correctly', async () => {
    vulns = [{ id: 'GHSA-low', aliases: ['CVE-2024-0002'], database_specific: { severity: 'LOW' } }];
    epss = new Map([['CVE-2024-0002', { score: 0.9, percentile: 0.99 }]]);
    const db = dbWith([
      { id: 'critical-only', decision: 'BLOCK', conditions: { cvssMin: 9 } },
      { id: 'likely', decision: 'BLOCK', conditions: { epssMin: 0.5 } },
    ]);
    const out = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(out.get('1.0')?.policyId).toBe('likely');
  });

  it('a monitoring EPSS policy groups by the CVE that drove the match', async () => {
    vulns = [high('CVE-2024-0003')];
    epss = new Map([['CVE-2024-0003', { score: 0.6, percentile: 0.99 }]]);
    const db = dbWith([{ id: 'p', decision: 'BLOCK', mode: 'monitor', conditions: { epssPercentileMin: 0.95 } }]);
    const out = await evaluateDownloadVersion(db, 'npm', 'acme', '1.0.0', undefined, null, undefined, fromDb);
    expect(out.monitorMatches).toEqual([expect.objectContaining({ reasonKey: 'epss:CVE-2024-0003' })]);
  });
});
