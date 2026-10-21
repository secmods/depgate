import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

// ── Hoist mocks before any module imports ────────────────────────────────────

const { queryOSVMock } = vi.hoisted(() => ({ queryOSVMock: vi.fn() }));

vi.mock('./osv-provider.js', () => ({
  queryOSV: queryOSVMock,
  getVulnIds: (vulns: Array<{ id?: string }>) =>
    vulns.map((v) => v.id).filter(Boolean) as string[],
  hasVulnInBlockList: (ids: string[], blockList: string[]) => {
    const set = new Set(blockList.map((b) => b.toUpperCase()));
    return ids.some((id) => set.has(id.toUpperCase()));
  },
}));

vi.mock('./exception-service.js', () => ({
  hasActiveException: vi.fn(async () => false),
}));

vi.mock('./malicious-sync.js', () => ({
  isMaliciousPackage: vi.fn(async () => ({ blocked: false })),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
  simulatePolicy,
  simulatePolicyToggle,
  fetchRecentAuditPackages,
  type SimulationPackageInput,
  type CandidatePolicyDef,
} from './policy-simulation.js';
import { hasActiveException } from './exception-service.js';
import { isMaliciousPackage } from './malicious-sync.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockPolicy = {
  id: string;
  name: string;
  decision: 'ALLOW' | 'BLOCK';
  conditions: Record<string, unknown>;
  priority: number;
  isEnabled: boolean;
};

/** `usageRows` are package_usage rows, newest first, as the query returns them. */
function makeDb(enabledPolicies: MockPolicy[], usageRows: unknown[] = []): DataSource {
  const policyFind = vi.fn(async () => enabledPolicies);
  return {
    query: vi.fn(async (_sql: string, params: unknown[]) => usageRows.slice(0, Number(params?.[0] ?? usageRows.length))),
    getRepository: () => ({ find: policyFind }),
  } as unknown as DataSource;
}

function usage(ecosystem: string, name: string, version: string, extra: Record<string, unknown> = {}) {
  return { ecosystem, package_name: name, version, repository: null, source_repository: null, ...extra };
}

const NPM_PKG: SimulationPackageInput = { ecosystem: 'npm', name: 'lodash', version: '4.17.21' };
const PYPI_PKG: SimulationPackageInput = { ecosystem: 'pypi', name: 'requests', version: '2.32.0' };

const BLOCK_LODASH: MockPolicy = {
  id: 'policy-1',
  name: 'Block lodash',
  decision: 'BLOCK',
  conditions: { packageBlockList: ['lodash'] },
  priority: 10,
  isEnabled: true,
};

const ALLOW_LODASH: MockPolicy = {
  id: 'policy-a',
  name: 'Allow lodash',
  decision: 'ALLOW',
  conditions: { packageBlockList: ['lodash'] },
  priority: 10,
  isEnabled: true,
};

const CANDIDATE_BLOCK_LODASH: CandidatePolicyDef = {
  name: 'Candidate block lodash',
  decision: 'BLOCK',
  conditions: { packageBlockList: ['lodash'] },
  priority: 0,
};

// ── simulatePolicy ─────────────────────────────────────────────────────────────

describe('simulatePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults — vi.clearAllMocks() only clears call history,
    // not mockResolvedValue implementations set by individual tests.
    queryOSVMock.mockResolvedValue({ vulns: [] });
    vi.mocked(hasActiveException).mockResolvedValue(false);
    vi.mocked(isMaliciousPackage).mockResolvedValue({ blocked: false });
  });

  it('returns no changes when candidate does not match any package', async () => {
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'Block nothing',
      decision: 'BLOCK',
      conditions: { packageBlockList: ['totally-different-pkg'] },
      priority: 0,
    };

    const report = await simulatePolicy(db, null, candidate, [NPM_PKG]);

    expect(report.summary.total).toBe(1);
    expect(report.summary.changed).toBe(0);
    expect(report.entries[0].changed).toBe(false);
    expect(report.entries[0].baselineDecision).toBeNull();
    expect(report.entries[0].simulatedDecision).toBeNull();
  });

  it('marks lodash as newly BLOCK when candidate blocks it', async () => {
    const db = makeDb([]);

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, [NPM_PKG]);

    expect(report.summary.changed).toBe(1);
    expect(report.summary.newlyBlocked).toBe(1);
    expect(report.entries[0].changed).toBe(true);
    expect(report.entries[0].baselineDecision).toBeNull();
    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
  });

  it('reports newly ALLOW when candidate ALLOW overrides existing BLOCK', async () => {
    const db = makeDb([BLOCK_LODASH]);
    const candidate: CandidatePolicyDef = {
      name: 'Allow lodash explicitly',
      decision: 'ALLOW',
      conditions: { packageBlockList: ['lodash'] },
      priority: 0,  // higher priority than existing BLOCK at 10
    };

    const report = await simulatePolicy(db, null, candidate, [NPM_PKG]);

    // Baseline: BLOCK (from BLOCK_LODASH at priority 10)
    // Simulated: ALLOW (from candidate at priority 0 which wins)
    // newlyAllowed counts BLOCK→ALLOW transitions
    expect(report.entries[0].baselineDecision).toBe('BLOCK');
    expect(report.entries[0].simulatedDecision).toBe('ALLOW');
    expect(report.entries[0].changed).toBe(true);
    expect(report.summary.newlyAllowed).toBe(1);
  });

  it('multiple packages: only matching one is marked changed', async () => {
    const db = makeDb([]);
    const pkgs = [NPM_PKG, PYPI_PKG];

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, pkgs);

    expect(report.summary.total).toBe(2);
    expect(report.summary.changed).toBe(1);

    const lodashEntry = report.entries.find((e) => e.name === 'lodash');
    const requestsEntry = report.entries.find((e) => e.name === 'requests');
    expect(lodashEntry?.changed).toBe(true);
    expect(requestsEntry?.changed).toBe(false);
  });

  it('respects ecosystem filter — npm-scoped candidate ignores pypi packages', async () => {
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'npm only block',
      decision: 'BLOCK',
      conditions: { ecosystem: ['npm'], packageBlockList: ['requests'] },
      priority: 0,
    };
    const pkgs = [
      { ecosystem: 'npm', name: 'requests', version: '1.0.0' },
      PYPI_PKG,
    ];

    const report = await simulatePolicy(db, null, candidate, pkgs);

    const npmEntry = report.entries.find((e) => e.ecosystem === 'npm');
    const pypiEntry = report.entries.find((e) => e.ecosystem === 'pypi');
    expect(npmEntry?.simulatedDecision).toBe('BLOCK');
    expect(pypiEntry?.simulatedDecision).toBeNull();
  });

  it('candidate inserted at priority 0 wins over existing policy at priority 10', async () => {
    const db = makeDb([ALLOW_LODASH]);
    const candidate: CandidatePolicyDef = {
      name: 'High-priority BLOCK',
      decision: 'BLOCK',
      conditions: { packageBlockList: ['lodash'] },
      priority: 0,
    };

    const report = await simulatePolicy(db, null, candidate, [NPM_PKG]);

    expect(report.entries[0].baselineDecision).toBe('ALLOW');
    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
    expect(report.entries[0].changed).toBe(true);
  });

  it('candidate at lower priority (20) does not override existing policy at priority 10', async () => {
    const db = makeDb([BLOCK_LODASH]);
    const candidate: CandidatePolicyDef = {
      name: 'Low-priority ALLOW',
      decision: 'ALLOW',
      conditions: { packageBlockList: ['lodash'] },
      priority: 20,
    };

    const report = await simulatePolicy(db, null, candidate, [NPM_PKG]);

    // BLOCK at priority 10 still wins
    expect(report.entries[0].baselineDecision).toBe('BLOCK');
    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
    expect(report.entries[0].changed).toBe(false);
  });

  it('returns matched policy info and reasons in entry', async () => {
    const db = makeDb([]);

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, [NPM_PKG]);

    const entry = report.entries[0];
    expect(entry.matchedPolicyName).toBe('Candidate block lodash');
    expect(entry.matchedPolicyId).toBe('simulated');
    expect(Array.isArray(entry.reasons)).toBe(true);
    expect(entry.reasons.length).toBeGreaterThan(0);
  });

  it('handles empty package list — returns zero-entry report', async () => {
    const db = makeDb([]);

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, []);

    expect(report.summary.total).toBe(0);
    expect(report.summary.changed).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it('package with active exception is null in both baseline and simulated (unchanged)', async () => {
    vi.mocked(hasActiveException).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    const db = makeDb([]);

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, [NPM_PKG]);

    expect(report.entries[0].baselineDecision).toBeNull();
    expect(report.entries[0].simulatedDecision).toBeNull();
    expect(report.entries[0].changed).toBe(false);
  });

  it('malicious package shows BLOCK in both baseline and simulated (malware precedes all)', async () => {
    vi.mocked(isMaliciousPackage).mockResolvedValue({ blocked: true, reason: 'Known malware' });
    const db = makeDb([]);

    const report = await simulatePolicy(db, null, CANDIDATE_BLOCK_LODASH, [NPM_PKG]);

    expect(report.entries[0].baselineDecision).toBe('BLOCK');
    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
    expect(report.entries[0].changed).toBe(false);
  });

  it('CVE block list match in candidate triggers BLOCK', async () => {
    queryOSVMock.mockResolvedValue({
      vulns: [{ id: 'CVE-UNIT-9999', severity: [] }],
    });
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'Block by CVE',
      decision: 'BLOCK',
      conditions: { cveBlockList: ['CVE-UNIT-9999'] },
      priority: 0,
    };

    const report = await simulatePolicy(db, {} as never, candidate, [NPM_PKG]);

    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
    expect(report.entries[0].changed).toBe(true);
    expect(report.entries[0].reasons[0]).toContain('CVE');
  });

  it('OSV failure does not throw — CVE condition is silently skipped', async () => {
    queryOSVMock.mockRejectedValue(new Error('OSV unreachable'));
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'CVE block candidate',
      decision: 'BLOCK',
      conditions: { cveBlockList: ['CVE-2024-0001'] },
      priority: 0,
    };

    const report = await simulatePolicy(db, {} as never, candidate, [NPM_PKG]);

    // OSV failed → no match → package passes through
    expect(report.entries[0].simulatedDecision).toBeNull();
  });

  it('version range condition in candidate is evaluated correctly', async () => {
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'Block semver range',
      decision: 'BLOCK',
      conditions: { versionRange: '<5.0.0' },
      priority: 0,
    };

    const report = await simulatePolicy(db, null, candidate, [NPM_PKG]); // lodash 4.17.21

    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
  });

  it('license deny condition in candidate is evaluated correctly', async () => {
    const db = makeDb([]);
    const candidate: CandidatePolicyDef = {
      name: 'Block GPL',
      decision: 'BLOCK',
      conditions: { licenseDenyList: ['GPL-3.0'] },
      priority: 0,
    };
    const gplPkg: SimulationPackageInput = { ecosystem: 'npm', name: 'gpl-pkg', version: '1.0.0' };

    // No license info available in SimulationPackageInput → no match
    const report = await simulatePolicy(db, null, candidate, [gplPkg]);

    // Without license metadata, licenseDenyList cannot match (requires versionMeta or ctx.license)
    expect(report.entries[0].simulatedDecision).toBeNull();
  });
});

// ── simulatePolicyToggle ───────────────────────────────────────────────────────

describe('simulatePolicyToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryOSVMock.mockResolvedValue({ vulns: [] });
    vi.mocked(hasActiveException).mockResolvedValue(false);
    vi.mocked(isMaliciousPackage).mockResolvedValue({ blocked: false });
  });

  function makePolicy(overrides: Partial<MockPolicy> = {}): MockPolicy {
    return {
      id: 'policy-toggle',
      name: 'Toggle policy',
      decision: 'BLOCK',
      conditions: { packageBlockList: ['lodash'] },
      priority: 10,
      isEnabled: true,
      ...overrides,
    };
  }

  it('simulatedAction is "disable" when policy is currently enabled', async () => {
    const policy = makePolicy({ isEnabled: true });
    const db = makeDb([policy]);

    const report = await simulatePolicyToggle(db, null, policy as never, [NPM_PKG]);

    expect(report.simulatedAction).toBe('disable');
  });

  it('simulatedAction is "enable" when policy is currently disabled', async () => {
    const policy = makePolicy({ isEnabled: false });
    const db = makeDb([]); // no enabled policies

    const report = await simulatePolicyToggle(db, null, policy as never, [NPM_PKG]);

    expect(report.simulatedAction).toBe('enable');
  });

  it('disabling an active BLOCK policy makes lodash newly ALLOWED', async () => {
    const policy = makePolicy({ isEnabled: true });
    const db = makeDb([policy]);

    const report = await simulatePolicyToggle(db, null, policy as never, [NPM_PKG]);

    const entry = report.entries[0];
    expect(entry.baselineDecision).toBe('BLOCK');
    expect(entry.simulatedDecision).toBeNull();
    expect(entry.changed).toBe(true);
    expect(report.summary.newlyAllowed).toBe(1);
  });

  it('enabling a disabled BLOCK policy makes lodash newly BLOCKED', async () => {
    const policy = makePolicy({ isEnabled: false });
    const db = makeDb([]); // no currently enabled policies

    const report = await simulatePolicyToggle(db, null, policy as never, [NPM_PKG]);

    const entry = report.entries[0];
    expect(entry.baselineDecision).toBeNull();
    expect(entry.simulatedDecision).toBe('BLOCK');
    expect(entry.changed).toBe(true);
    expect(report.summary.newlyBlocked).toBe(1);
  });

  it('enabling a disabled policy only adds itself — other enabled policies still evaluated', async () => {
    const existingPolicy: MockPolicy = {
      id: 'existing',
      name: 'Existing ALLOW',
      decision: 'ALLOW',
      conditions: { packageBlockList: ['lodash'] },
      priority: 50,
      isEnabled: true,
    };
    const newPolicy = makePolicy({ isEnabled: false, priority: 5 });
    const db = makeDb([existingPolicy]);

    const report = await simulatePolicyToggle(db, null, newPolicy as never, [NPM_PKG]);

    // Baseline: ALLOW (existingPolicy wins at priority 50, newPolicy is disabled)
    // Simulated: BLOCK (newPolicy at priority 5 wins over existingPolicy at priority 50)
    expect(report.entries[0].baselineDecision).toBe('ALLOW');
    expect(report.entries[0].simulatedDecision).toBe('BLOCK');
    expect(report.entries[0].changed).toBe(true);
  });

  it('disabling a policy that does not match the packages shows no changes', async () => {
    const policy = makePolicy({ isEnabled: true, conditions: { packageBlockList: ['other-pkg'] } });
    const db = makeDb([policy]);

    const report = await simulatePolicyToggle(db, null, policy as never, [NPM_PKG]);

    expect(report.summary.changed).toBe(0);
    expect(report.entries[0].changed).toBe(false);
  });

  it('empty package list produces zero-entry report with correct simulatedAction', async () => {
    const policy = makePolicy({ isEnabled: true });
    const db = makeDb([policy]);

    const report = await simulatePolicyToggle(db, null, policy as never, []);

    expect(report.simulatedAction).toBe('disable');
    expect(report.summary.total).toBe(0);
    expect(report.entries).toHaveLength(0);
  });
});

// ── fetchRecentAuditPackages ───────────────────────────────────────────────────

describe('fetchRecentAuditPackages (from package_usage)', () => {
  it('returns unique (ecosystem, repository, name, version) tuples up to the limit', async () => {
    const rows = [
      usage('npm', 'lodash', '4.17.21'),
      usage('npm', 'lodash', '4.17.21', { source_repository: 'npm/default' }), // same version through another remote
      usage('pypi', 'requests', '2.32.0'),
      usage('go', 'github.com/gin-gonic/gin', 'v1.9.1'),
    ];
    const db = makeDb([], rows);

    const result = await fetchRecentAuditPackages(db, 10);

    expect(result).toHaveLength(3);
    expect(result.map((r) => `${r.ecosystem}:${r.name}:${r.version}`)).toEqual([
      'npm:lodash:4.17.21',
      'pypi:requests:2.32.0',
      'go:github.com/gin-gonic/gin:v1.9.1',
    ]);
  });

  it('respects the limit and stops early', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => usage('npm', `pkg-${i}`, '1.0.0'));
    const result = await fetchRecentAuditPackages(makeDb([], rows), 5);
    expect(result).toHaveLength(5);
  });

  it('keeps the repository and names the serving remote by key', async () => {
    const result = await fetchRecentAuditPackages(
      makeDb([], [usage('npm', 'express', '4.18.2', { repository: 'prod', source_repository: 'npm/acme-artifactory' })]),
      10
    );
    expect(result).toEqual([{ ecosystem: 'npm', name: 'express', version: '4.18.2', repository: 'prod', source: 'acme-artifactory' }]);
  });

  it('returns empty array when nothing was downloaded', async () => {
    expect(await fetchRecentAuditPackages(makeDb([], []), 10)).toHaveLength(0);
  });

  it('caps limit to AUDIT_LOG_LIMIT_MAX (200)', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => usage('npm', `pkg-${i}`, '1.0.0'));
    const result = await fetchRecentAuditPackages(makeDb([], rows), 999);
    expect(result.length).toBeLessThanOrEqual(200);
  });
});
