import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

vi.mock('./exception-service.js', () => ({ hasActiveException: vi.fn(async () => false) }));
vi.mock('./malicious-sync.js', () => ({ isMaliciousPackage: vi.fn(async () => ({ blocked: false })) }));

import { simulatePolicy, simulatePolicyToggle, type SimulationPackageInput } from './policy-simulation.js';

const PROD = '11111111-1111-4111-8111-111111111111';
const REPOS = [
  { id: PROD, ecosystem: 'npm', key: 'prod' },
  { id: '22222222-2222-4222-8222-222222222222', ecosystem: 'npm', key: 'default' },
];

function makeDb(policies: unknown[]): DataSource {
  return {
    getRepository: (entity: { name?: string }) =>
      entity?.name === 'PackageRepository' ? { find: async () => REPOS } : { find: async () => policies },
  } as unknown as DataSource;
}

const PACKAGES: SimulationPackageInput[] = [
  { ecosystem: 'npm', name: 'lodash', version: '4.17.20', repository: 'prod' },
  { ecosystem: 'npm', name: 'lodash', version: '4.17.20', repository: 'default' },
  { ecosystem: 'npm', name: 'lodash', version: '4.17.21' },
];

describe('policy simulation with repository scope', () => {
  it('reports only packages in the candidate scope and counts the rest as out of scope', async () => {
    const report = await simulatePolicy(
      makeDb([]),
      null,
      {
        name: 'prod only',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 1,
        repositoryIds: [PROD],
      },
      PACKAGES
    );
    expect(report.summary.outOfScope).toBe(2);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ version: '4.17.20', simulatedDecision: 'BLOCK', changed: true });
  });

  it('an unscoped candidate covers every package', async () => {
    const report = await simulatePolicy(
      makeDb([]),
      null,
      { name: 'all', decision: 'BLOCK', conditions: { packageBlockList: ['lodash'] }, priority: 1 },
      PACKAGES
    );
    expect(report.summary.outOfScope).toBe(0);
    expect(report.summary.newlyBlocked).toBe(3);
  });

  it('a scoped enabled policy does not decide packages from other repositories in the baseline', async () => {
    const scoped = {
      id: 'p1',
      name: 'prod only',
      decision: 'BLOCK',
      conditions: { packageBlockList: ['lodash'] },
      priority: 1,
      isEnabled: true,
      repositoryIds: [PROD],
    };
    const report = await simulatePolicyToggle(makeDb([scoped]), null, scoped as never, PACKAGES);
    expect(report.simulatedAction).toBe('disable');
    expect(report.summary.outOfScope).toBe(2);
    expect(report.summary.newlyAllowed).toBe(1);
  });
});
