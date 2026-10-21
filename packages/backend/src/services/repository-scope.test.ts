import { describe, expect, it, vi } from 'vitest';
import {
  describeScope,
  detachRepository,
  inRepositoryScope,
  parseScopeIds,
  scopeIds,
  validateRepositoryScope,
} from './repository-scope.js';

const PROD = '11111111-1111-4111-8111-111111111111';
const STAGING = '22222222-2222-4222-8222-222222222222';
const PYPI = '33333333-3333-4333-8333-333333333333';

const REPOS = [
  { id: PROD, ecosystem: 'npm', key: 'prod', type: 'remote' },
  { id: STAGING, ecosystem: 'npm', key: 'staging', type: 'virtual' },
  { id: PYPI, ecosystem: 'pypi', key: 'prod', type: 'remote' },
];

function repoDb() {
  return {
    getRepository: () => ({
      find: async ({ where }: { where: { id: { value: string[] } } }) =>
        REPOS.filter((row) => where.id.value.includes(row.id)),
    }),
  } as never;
}

describe('scope helpers', () => {
  it('an empty or missing list covers every repository', () => {
    expect(scopeIds([])).toBeNull();
    expect(scopeIds(undefined)).toBeNull();
    expect(inRepositoryScope(null, null)).toBe(true);
    expect(inRepositoryScope(null, PROD)).toBe(true);
  });

  it('a limited list covers only its repositories', () => {
    const scope = scopeIds([PROD]);
    expect(inRepositoryScope(scope, PROD)).toBe(true);
    expect(inRepositoryScope(scope, STAGING)).toBe(false);
    expect(inRepositoryScope(scope, null)).toBe(false);
  });

  it('parses request values', () => {
    expect(parseScopeIds(undefined)).toEqual({});
    expect(parseScopeIds(null)).toEqual({ ids: [] });
    expect(parseScopeIds([PROD, PROD.toUpperCase(), STAGING])).toEqual({ ids: [PROD, STAGING] });
    expect(parseScopeIds('prod').error).toMatch(/list of repository IDs/);
    expect(parseScopeIds(['prod']).error).toMatch(/list of repository IDs/);
  });

  it('describes a scope for the audit log and review sentence', () => {
    expect(describeScope([])).toBe('all repositories');
    expect(describeScope([REPOS[0], REPOS[1]] as never)).toBe('npm/prod, npm/staging');
  });
});

describe('validateRepositoryScope', () => {
  it('accepts repositories of the policy ecosystem, in the order given', async () => {
    const result = await validateRepositoryScope(repoDb(), [STAGING, PROD], ['npm']);
    expect('refs' in result && result.refs.map((ref) => ref.key)).toEqual(['staging', 'prod']);
  });

  it('accepts any ecosystem for an all-ecosystems policy', async () => {
    const result = await validateRepositoryScope(repoDb(), [PROD, PYPI], []);
    expect('refs' in result && result.refs).toHaveLength(2);
  });

  it('rejects an unknown repository', async () => {
    const missing = '44444444-4444-4444-8444-444444444444';
    const result = await validateRepositoryScope(repoDb(), [PROD, missing], ['npm']);
    expect('error' in result && result.error).toBe(`Repository ${missing} does not exist`);
  });

  it('rejects a repository outside the policy ecosystem', async () => {
    const result = await validateRepositoryScope(repoDb(), [PYPI], ['npm']);
    expect('error' in result && result.error).toMatch(/pypi\/prod is not in this policy's ecosystem \(npm\)/);
  });
});

describe('detachRepository', () => {
  function manager(rows: { policies: unknown[]; exceptions: unknown[]; waivers: unknown[] }) {
    const saved: unknown[] = [];
    const deleted: unknown[] = [];
    const updated: Array<[unknown, unknown]> = [];
    const repoFor = (list: unknown[]) => ({
      createQueryBuilder: () => {
        const qb = { where: () => qb, andWhere: () => qb, getMany: async () => list };
        return qb;
      },
      save: vi.fn(async (row: unknown) => saved.push(structuredClone(row))),
      delete: vi.fn(async (where: unknown) => deleted.push(where)),
      update: vi.fn(async (where: unknown, values: unknown) => updated.push([where, values])),
    });
    const repos: Record<string, ReturnType<typeof repoFor>> = {
      Policy: repoFor(rows.policies),
      Exception: repoFor(rows.exceptions),
      WaiverRequest: repoFor(rows.waivers),
    };
    return {
      em: { getRepository: (entity: { name: string }) => repos[entity.name] } as never,
      saved,
      deleted,
      updated,
    };
  }

  it('disables a policy whose only repository was deleted, without widening it', async () => {
    const m = manager({
      policies: [{ id: 'p1', name: 'prod only', isEnabled: true, repositoryIds: [PROD] }],
      exceptions: [],
      waivers: [],
    });
    const result = await detachRepository(m.em, PROD);
    expect(result.disabledPolicies.map((p) => p.id)).toEqual(['p1']);
    expect(m.saved).toEqual([{ id: 'p1', name: 'prod only', isEnabled: false, repositoryIds: [PROD] }]);
  });

  it('narrows a policy that keeps other repositories', async () => {
    const m = manager({
      policies: [{ id: 'p1', name: 'two', isEnabled: true, repositoryIds: [PROD, STAGING] }],
      exceptions: [],
      waivers: [],
    });
    const result = await detachRepository(m.em, PROD);
    expect(result.narrowedPolicies).toHaveLength(1);
    expect(m.saved).toEqual([{ id: 'p1', name: 'two', isEnabled: true, repositoryIds: [STAGING] }]);
  });

  it('deletes an exception limited to the repository and narrows a wider one', async () => {
    const m = manager({
      policies: [],
      exceptions: [
        { id: 'e1', repositoryIds: [PROD] },
        { id: 'e2', repositoryIds: [PROD, STAGING] },
      ],
      waivers: [],
    });
    const result = await detachRepository(m.em, PROD);
    expect(result.deletedExceptions.map((e) => e.id)).toEqual(['e1']);
    expect(m.deleted).toContainEqual({ id: 'e1' });
    expect(m.updated).toContainEqual([{ id: 'e2' }, { repositoryIds: [STAGING] }]);
  });

  it('rejects a pending waiver whose only repository was deleted', async () => {
    const m = manager({
      policies: [],
      exceptions: [],
      waivers: [{ id: 'w1', status: 'pending', repositoryIds: [PROD] }],
    });
    const result = await detachRepository(m.em, PROD);
    expect(result.rejectedWaivers.map((w) => w.id)).toEqual(['w1']);
    const [, values] = m.updated[0] as [unknown, { status: string; reviewNote: string }];
    expect(values.status).toBe('rejected');
    expect(values.reviewNote).toMatch(/repository it was requested for was deleted/);
  });
});
