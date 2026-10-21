import { beforeEach, describe, expect, it, vi } from 'vitest';

const { repositoryIdForMock, loadVersionFactsMock } = vi.hoisted(() => ({
  repositoryIdForMock: vi.fn(),
  loadVersionFactsMock: vi.fn(),
}));

vi.mock('./repository-resolve.js', () => ({ repositoryIdFor: repositoryIdForMock }));
vi.mock('./package-facts.js', () => ({ loadVersionFacts: loadVersionFactsMock }));
vi.mock('./malicious-sync.js', () => ({
  findMaliciousEntry: async () => null,
  findMaliciousEntryCached: async () => null,
  maliciousMatch: () => ({ blocked: false }),
}));

import { evaluatePackageVersions } from './policy-engine.js';

const PROD = '11111111-1111-4111-8111-111111111111';
const SANDBOX = '22222222-2222-4222-8222-222222222222';
const KEYS: Record<string, string> = { prod: PROD, sandbox: SANDBOX };

type Row = Record<string, unknown>;

function policy(id: string, extra: Row): Row {
  return { id, name: id, decision: 'BLOCK', priority: 10, isEnabled: true, mode: 'enforce', repositoryIds: [], ...extra };
}

function makeDb(policies: Row[], exceptions: Row[] = []) {
  const qb = { where: () => qb, andWhere: () => qb, getMany: async () => exceptions };
  return {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
      if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
      return { find: async () => policies };
    },
  } as unknown as Parameters<typeof evaluatePackageVersions>[0];
}

async function decide(db: ReturnType<typeof makeDb>, repoKey: string, version = '4.17.20') {
  const results = await evaluatePackageVersions(db, 'npm', 'lodash', [{ version }], null, undefined, {
    repoKey,
    policiesFromDatabase: true,
  });
  return results.get(version) ?? null;
}

describe('policy engine repository scope', () => {
  beforeEach(() => {
    repositoryIdForMock.mockReset();
    repositoryIdForMock.mockImplementation(async (_db: unknown, _eco: string, key: string) => KEYS[key] ?? null);
    loadVersionFactsMock.mockReset();
    loadVersionFactsMock.mockResolvedValue(new Map());
  });

  it('a scoped policy blocks in its repository and not in another', async () => {
    const db = makeDb([policy('prod-only', { conditions: { packageBlockList: ['lodash'] }, repositoryIds: [PROD] })]);
    expect((await decide(db, 'prod'))?.policyId).toBe('prod-only');
    expect(await decide(db, 'sandbox')).toBeNull();
    expect(await decide(db, 'default')).toBeNull();
  });

  it('an unscoped policy applies to every repository', async () => {
    const db = makeDb([policy('everywhere', { conditions: { packageBlockList: ['lodash'] } })]);
    for (const key of ['prod', 'sandbox', 'default', 'all']) {
      expect((await decide(db, key))?.policyId).toBe('everywhere');
    }
  });

  it('does not look up the repository when nothing is scoped', async () => {
    const db = makeDb([policy('everywhere', { conditions: { packageBlockList: ['lodash'] } })]);
    await decide(db, 'prod');
    expect(repositoryIdForMock).not.toHaveBeenCalled();
  });

  it('a scoped Allow above a global Block allows only in its repository', async () => {
    const db = makeDb([
      policy('allow-prod', {
        decision: 'ALLOW',
        priority: 1,
        conditions: { packageBlockList: ['lodash'] },
        repositoryIds: [PROD],
      }),
      policy('block-all', { priority: 2, conditions: { packageBlockList: ['lodash'] } }),
    ]);
    expect((await decide(db, 'prod'))?.decision).toBe('ALLOW');
    expect((await decide(db, 'sandbox'))?.policyId).toBe('block-all');
  });

  it('a policy scoped to several repositories applies to each of them', async () => {
    const db = makeDb([policy('both', { conditions: { packageBlockList: ['lodash'] }, repositoryIds: [PROD, SANDBOX] })]);
    expect((await decide(db, 'prod'))?.policyId).toBe('both');
    expect((await decide(db, 'sandbox'))?.policyId).toBe('both');
    expect(await decide(db, 'default')).toBeNull();
  });

  it('an unknown repository key is outside every limited scope', async () => {
    const db = makeDb([
      policy('scoped', { priority: 1, conditions: { packageBlockList: ['lodash'] }, repositoryIds: [PROD] }),
      policy('global', { priority: 2, conditions: { packageBlockList: ['lodash'] } }),
    ]);
    expect((await decide(db, 'no-such-repo'))?.policyId).toBe('global');
  });

  it('an exception scoped to one repository does not apply in another', async () => {
    const db = makeDb(
      [policy('block-all', { conditions: { packageBlockList: ['lodash'] } })],
      [{ id: 'ex', ecosystem: 'npm', packageName: 'lodash', version: '*', policyId: null, repositoryIds: [PROD] }]
    );
    expect(await decide(db, 'prod')).toBeNull();
    expect((await decide(db, 'sandbox'))?.policyId).toBe('block-all');
  });

  it('a policy-scoped exception limited to a repository only lifts that policy there', async () => {
    const db = makeDb(
      [
        policy('first', { priority: 1, conditions: { packageBlockList: ['lodash'] } }),
        policy('second', { priority: 2, conditions: { packageBlockList: ['lodash'] } }),
      ],
      [{ id: 'ex', ecosystem: 'npm', packageName: 'lodash', version: '*', policyId: 'first', repositoryIds: [PROD] }]
    );
    expect((await decide(db, 'prod'))?.policyId).toBe('second');
    expect((await decide(db, 'sandbox'))?.policyId).toBe('first');
  });

  it('never loads facts for a policy scoped to another repository', async () => {
    const db = makeDb([policy('license-prod', { conditions: { licenseDenyList: ['GPL-3.0'] }, repositoryIds: [PROD] })]);
    expect(await decide(db, 'sandbox')).toBeNull();
    expect(loadVersionFactsMock).not.toHaveBeenCalled();
  });

  it('loads facts for the same policy in its own repository', async () => {
    loadVersionFactsMock.mockResolvedValue(
      new Map([
        [
          '4.17.20',
          { license: 'GPL-3.0', licenseKnown: true, publishedKnown: false, cveKnown: false, vulns: [] },
        ],
      ])
    );
    const db = makeDb([policy('license-prod', { conditions: { licenseDenyList: ['GPL-3.0'] }, repositoryIds: [PROD] })]);
    expect((await decide(db, 'prod'))?.policyId).toBe('license-prod');
    expect(loadVersionFactsMock).toHaveBeenCalledTimes(1);
  });
});

describe('policy engine scope follows the serving remote (R5)', () => {
  const ALL = '33333333-3333-4333-8333-333333333333';
  const DEFAULT = '44444444-4444-4444-8444-444444444444';
  const remote = (id: string, key: string) => ({
    id,
    key,
    url: `https://${key}.test`,
    timeoutMs: 1000,
    retryCount: 0,
    authType: null,
    authEncrypted: null,
    source: 'public' as const,
  });
  const targets = [remote(PROD, 'prod'), remote(DEFAULT, 'default')];

  function route(served: string | null) {
    const servingSource = vi.fn(async () => targets.find((target) => target.id === served) ?? null);
    return {
      route: {
        ecosystem: 'npm',
        repoKey: 'all',
        packageName: 'lodash',
        targets,
        cacheScope: 'all',
        reserved: null,
        monitored: [],
        skipped: [],
        block: null,
        servingSource,
      },
      servingSource,
    };
  }

  async function decideVia(db: ReturnType<typeof makeDb>, served: string | null) {
    const { route: r, servingSource } = route(served);
    const results = await evaluatePackageVersions(db, 'npm', 'lodash', [{ version: '4.17.20' }], null, undefined, {
      repoKey: 'all',
      policiesFromDatabase: true,
      route: r as never,
    });
    return { result: results.get('4.17.20') ?? null, servingSource };
  }

  beforeEach(() => {
    repositoryIdForMock.mockReset();
    repositoryIdForMock.mockImplementation(async (_db: unknown, _eco: string, key: string) =>
      key === 'all' ? ALL : (KEYS[key] ?? null)
    );
    loadVersionFactsMock.mockReset();
    loadVersionFactsMock.mockResolvedValue(new Map());
  });

  it('a policy on a remote blocks through all when that remote serves the package', async () => {
    const db = makeDb([policy('prod-only', { conditions: { packageBlockList: ['lodash'] }, repositoryIds: [PROD] })]);
    expect((await decideVia(db, PROD)).result?.policyId).toBe('prod-only');
    expect((await decideVia(db, DEFAULT)).result).toBeNull();
  });

  it('an unknown serving remote applies the policies of every member', async () => {
    const db = makeDb([policy('prod-only', { conditions: { packageBlockList: ['lodash'] }, repositoryIds: [PROD] })]);
    expect((await decideVia(db, null)).result?.policyId).toBe('prod-only');
  });

  it('asks for the serving remote only when a scope needs it', async () => {
    const global = makeDb([policy('everywhere', { conditions: { packageBlockList: ['lodash'] } })]);
    expect((await decideVia(global, PROD)).servingSource).not.toHaveBeenCalled();
    const onAll = makeDb([policy('on-all-id', { conditions: { packageBlockList: ['lodash'] }, repositoryIds: [ALL] })]);
    const { result, servingSource } = await decideVia(onAll, PROD);
    expect(result?.policyId).toBe('on-all-id');
    expect(servingSource).not.toHaveBeenCalled();
  });

  it('an exception on a remote applies through all only when that remote serves', async () => {
    const db = makeDb(
      [policy('block-all', { conditions: { packageBlockList: ['lodash'] } })],
      [{ id: 'ex', ecosystem: 'npm', packageName: 'lodash', version: '*', policyId: null, repositoryIds: [PROD] }]
    );
    expect((await decideVia(db, PROD)).result).toBeNull();
    expect((await decideVia(db, DEFAULT)).result?.policyId).toBe('block-all');
    expect((await decideVia(db, null)).result?.policyId).toBe('block-all');
  });
});
