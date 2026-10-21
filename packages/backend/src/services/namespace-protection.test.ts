import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { RemoteTarget } from './repository-resolve.js';

const state = vi.hoisted(() => ({
  targets: [] as RemoteTarget[],
  repositoryIds: new Map<string, string>(),
  sourcesSignature: 'sig-1',
}));

vi.mock('./repository-resolve.js', () => ({
  resolveRemoteTargets: vi.fn(async () => state.targets),
  repositoryIdFor: vi.fn(async (_db: unknown, _eco: string, key: string) => state.repositoryIds.get(key) ?? null),
  remoteSourcesSignature: vi.fn(async () => state.sourcesSignature),
}));

import {
  isKnownPublicRegistry,
  isPrivateName,
  namespaceMonitorMatches,
  namespaceNotFoundResult,
  resolvePackageTargets,
  targetForUrl,
} from './namespace-protection.js';
import { compilePolicy, evaluatePackageVersions, type CompiledPolicy } from './policy-engine.js';
import type { Policy } from '../db/entities/Policy.js';

const PUBLIC: RemoteTarget = {
  id: 'p1',
  key: 'default',
  url: 'https://registry.npmjs.org',
  timeoutMs: 1000,
  retryCount: 0,
  authType: null,
  authEncrypted: null,
  source: 'public',
};
const INTERNAL: RemoteTarget = { ...PUBLIC, id: 'i1', key: 'acme-artifactory', url: 'https://artifactory.acme.test/npm', source: 'internal' };

const POLICY_ID = '11111111-1111-4111-8111-111111111111';
const ALLOW_ID = '22222222-2222-4222-8222-222222222222';

function policy(overrides: Partial<Policy> & { conditions: Record<string, unknown> }): Policy {
  return {
    id: POLICY_ID,
    name: 'acme-namespace',
    description: null,
    decision: 'BLOCK',
    priority: 10,
    isEnabled: true,
    mode: 'enforce',
    modeChangedAt: null,
    repositoryIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Policy;
}

const namespacePolicy = (extra: Partial<Policy> = {}, conditions: Record<string, unknown> = {}) =>
  compilePolicy(policy({ ...extra, conditions: { ecosystem: ['npm'], reservedNamespaces: ['@acme', 'acme-*'], ...conditions } }));

type Row = { ecosystem: string; packageName: string; policyId: string | null; repositoryIds: string[]; version: string; expiresAt: Date };

/** A database whose exception table holds `exceptions`, and which has no malware entries. */
function fakeDb(exceptions: Row[] = []): DataSource {
  const query = {
    where: () => query,
    andWhere: () => query,
    getMany: async () => exceptions.filter((row) => row.expiresAt > new Date()),
  };
  return {
    getRepository: () => ({
      find: async ({ where }: { where: { policyId?: { _value?: string[] } } }) => {
        const ids = (where.policyId as unknown as { _value: string[] })?._value ?? [];
        return exceptions.filter((row) => row.policyId && ids.includes(row.policyId) && row.expiresAt > new Date());
      },
      findOne: async () => null,
      createQueryBuilder: () => query,
    }),
  } as unknown as DataSource;
}

const future = () => new Date(Date.now() + 86_400_000);

beforeEach(() => {
  state.targets = [PUBLIC, INTERNAL];
  state.repositoryIds = new Map([['all', 'repo-all'], ['default', 'repo-default']]);
  state.sourcesSignature = 'sig-1';
});

describe('resolvePackageTargets: target filtering', () => {
  it('drops every public remote for an enforced reserved name', async () => {
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies: [namespacePolicy()] });
    expect(route.targets.map((t) => t.key)).toEqual(['acme-artifactory']);
    expect(route.skipped.map((t) => t.key)).toEqual(['default']);
    expect(route.reserved).toMatchObject({ policyId: POLICY_ID, pattern: '@acme', mode: 'enforce' });
    expect(route.block).toBeNull();
    expect(route.cacheScope).toMatch(/^all~ns-[0-9a-f]{10}$/);
  });

  it('blocks when the repository has only public remotes, naming the namespace and repository', async () => {
    state.targets = [PUBLIC];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'default', '@acme/billing', { policies: [namespacePolicy()] });
    expect(route.targets).toEqual([]);
    expect(route.block?.decision).toBe('BLOCK');
    expect(route.block?.reasons[0]).toBe(
      'Package "@acme/billing" is in reserved namespace "@acme" and repository "npm/default" has no internal remote'
    );
  });

  it('leaves a name outside every reserved namespace unchanged, with the plain cache scope', async () => {
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', 'lodash', { policies: [namespacePolicy()] });
    expect(route.targets).toEqual([PUBLIC, INTERNAL]);
    expect(route.reserved).toBeNull();
    // `all` searches several remotes, so its scope carries their order (R2).
    expect(route.cacheScope).toMatch(/^all~o-[0-9a-f]{8}$/);
  });

  it('a name in publicPackages may come from public remotes', async () => {
    const policies = [namespacePolicy({}, { publicPackages: ['@acme/eslint-config'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/eslint-config', { policies });
    expect(route.reserved).toBeNull();
    expect(route.targets).toEqual([PUBLIC, INTERNAL]);
  });

  it('an unexpired exception scoped to the namespace policy lifts it; an expired one does not', async () => {
    const live: Row = { ecosystem: 'npm', packageName: '@acme/billing', policyId: POLICY_ID, repositoryIds: [], version: '*', expiresAt: future() };
    const lifted = await resolvePackageTargets(fakeDb([live]), 'npm', 'all', '@ACME/billing', { policies: [namespacePolicy()] });
    expect(lifted.reserved).toBeNull();
    const expired = { ...live, expiresAt: new Date(Date.now() - 1000) };
    const kept = await resolvePackageTargets(fakeDb([expired]), 'npm', 'all', '@acme/billing', { policies: [namespacePolicy()] });
    expect(kept.reserved).not.toBeNull();
  });

  it('a global exception (no policy) does not lift the rule (D4)', async () => {
    const global: Row = { ecosystem: 'npm', packageName: '@acme/billing', policyId: null, repositoryIds: [], version: '*', expiresAt: future() };
    const route = await resolvePackageTargets(fakeDb([global]), 'npm', 'all', '@acme/billing', { policies: [namespacePolicy()] });
    expect(route.reserved).not.toBeNull();
    expect(route.targets.map((t) => t.key)).toEqual(['acme-artifactory']);
  });

  it('a higher-priority Allow policy does not reopen public remotes (D4)', async () => {
    const allow = compilePolicy(
      policy({ id: ALLOW_ID, name: 'allow-acme', decision: 'ALLOW', priority: 1, conditions: { packageBlockList: ['@acme/*'] } })
    );
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies: [allow, namespacePolicy()] });
    expect(route.targets.map((t) => t.key)).toEqual(['acme-artifactory']);
  });

  it('respects repository scope: a policy limited to another repository does not restrict this one', async () => {
    const scoped = namespacePolicy({ repositoryIds: ['repo-default'] });
    const viaAll = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies: [scoped] });
    expect(viaAll.reserved).toBeNull();
    const viaDefault = await resolvePackageTargets(fakeDb(), 'npm', 'default', '@acme/billing', { policies: [scoped] });
    expect(viaDefault.reserved).not.toBeNull();
  });

  it('monitor mode changes nothing about resolution and marks the name private', async () => {
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', 'acme-auth', { policies: [namespacePolicy({ mode: 'monitor' })] });
    expect(route.targets).toEqual([PUBLIC, INTERNAL]);
    expect(route.reserved).toBeNull();
    expect(route.monitored).toHaveLength(1);
    // `all` searches several remotes, so its scope carries their order (R2).
    expect(route.cacheScope).toMatch(/^all~o-[0-9a-f]{8}$/);
    expect(isPrivateName(route)).toBe(true);
    expect(namespaceMonitorMatches(route, PUBLIC)).toEqual([
      expect.objectContaining({
        policyId: POLICY_ID,
        reasonKey: 'namespace:acme-*',
        reasons: ['Served from public remote npm/default; enforcing would block it'],
      }),
    ]);
    expect(namespaceMonitorMatches(route, INTERNAL)).toEqual([]);
  });

  it('only a policy of the requested ecosystem counts', async () => {
    const pypi = compilePolicy(policy({ conditions: { ecosystem: ['pypi'], reservedNamespaces: ['acme-*'] } }));
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', 'acme-auth', { policies: [pypi] });
    expect(route.reserved).toBeNull();
  });

  it('documents with no package name are never filtered', async () => {
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', null, { policies: [namespacePolicy()] });
    expect(route.targets).toEqual([PUBLIC, INTERNAL]);
  });
});

describe('namespace epoch (§6.6)', () => {
  it('changes with the namespace policy and with any remote source, not with unrelated policies', async () => {
    const scope = async (policies: CompiledPolicy[]) =>
      (await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies })).cacheScope;
    const base = await scope([namespacePolicy()]);
    expect(await scope([namespacePolicy()])).toBe(base);
    const unrelated = compilePolicy(policy({ id: ALLOW_ID, conditions: { ecosystem: ['npm'], packageBlockList: ['x'] } }));
    expect(await scope([unrelated, namespacePolicy()])).toBe(base);
    expect(await scope([namespacePolicy({}, { reservedNamespaces: ['@acme', 'acme-*', '@acme2'] })])).not.toBe(base);
    expect(await scope([namespacePolicy({ mode: 'monitor' }), namespacePolicy({ id: ALLOW_ID })])).not.toBe(base);
    state.sourcesSignature = 'sig-2';
    expect(await scope([namespacePolicy()])).not.toBe(base);
  });
});

describe('not found internally (D6)', () => {
  it('says the internal remotes were asked and the public ones were not', async () => {
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies: [namespacePolicy()] });
    expect(namespaceNotFoundResult(route)?.reasons[0]).toBe(
      'Package "@acme/billing" is in reserved namespace "@acme" and was not found in internal remotes (npm/acme-artifactory). Public remotes were not consulted.'
    );
    const plain = await resolvePackageTargets(fakeDb(), 'npm', 'all', 'lodash', { policies: [namespacePolicy()] });
    expect(namespaceNotFoundResult(plain)).toBeNull();
  });
});

describe('engine order for a namespace block (D4, D8)', () => {
  const block = {
    decision: 'BLOCK' as const,
    policyId: POLICY_ID,
    policyName: 'acme-namespace',
    reasons: ['Package "@acme/billing" is in reserved namespace "@acme" and repository "npm/default" has no internal remote'],
  };

  function engineDb(opts: { malicious?: boolean; globalException?: boolean }): DataSource {
    const rows = opts.globalException
      ? [{ ecosystem: 'npm', packageName: '@acme/billing', policyId: null, repositoryIds: [], version: '*', expiresAt: future() }]
      : [];
    const query = { where: () => query, andWhere: () => query, getMany: async () => rows };
    return {
      getRepository: () => ({
        createQueryBuilder: () => query,
        findOne: async () =>
          opts.malicious ? { name: '@acme/billing', ecosystem: 'npm', overrideStatus: null, versionRange: null, reason: 'Known malware' } : null,
        find: async () => [],
      }),
    } as unknown as DataSource;
  }

  it('the namespace block wins over a global exception and an Allow policy', async () => {
    const result = await evaluatePackageVersions(engineDb({ globalException: true }), 'npm', '@acme/billing', [{ version: '1.0.0' }], null, undefined, {
      policiesFromDatabase: false,
      namespaceBlock: block,
    });
    expect(result.get('1.0.0')).toEqual(block);
  });

  it('the malicious packages list still comes first', async () => {
    const result = await evaluatePackageVersions(engineDb({ malicious: true }), 'npm', '@acme/billing', [{ version: '1.0.0' }], null, undefined, {
      namespaceBlock: block,
    });
    expect(result.get('1.0.0')?.policyId).toBe('malicious');
  });
});

describe('helpers', () => {
  it('maps a served URL to its remote, longest URL first', () => {
    const nested = { ...INTERNAL, id: 'i2', key: 'acme-npm-private', url: 'https://artifactory.acme.test/npm/private' };
    expect(targetForUrl([INTERNAL, nested], 'https://artifactory.acme.test/npm/private/x')?.key).toBe('acme-npm-private');
    expect(targetForUrl([INTERNAL, nested], 'https://artifactory.acme.test/npm/x')?.key).toBe('acme-artifactory');
    expect(targetForUrl([INTERNAL], 'https://artifactory.acme.test/npmx/x')).toBeNull();
  });

  it('recognises public registry hosts, including Packagist', () => {
    expect(isKnownPublicRegistry('npm', 'https://registry.npmjs.org')).toBe(true);
    expect(isKnownPublicRegistry('composer', 'https://repo.packagist.org')).toBe(true);
    expect(isKnownPublicRegistry('npm', 'https://artifactory.acme.test/npm')).toBe(false);
  });
});

describe('allowed remotes for a namespace (R6)', () => {
  const GITHUB: RemoteTarget = { ...PUBLIC, id: 'g1', key: 'github-npm', url: 'https://npm.pkg.github.test' };

  it('serves a bound namespace only from the remotes it allows, public ones included', async () => {
    state.targets = [PUBLIC, GITHUB, INTERNAL];
    const policies = [namespacePolicy({}, { allowedRemotes: ['g1'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies });
    expect(route.targets.map((t) => t.key)).toEqual(['github-npm']);
    expect(route.skipped.map((t) => t.key)).toEqual(['default', 'acme-artifactory']);
    expect(route.reserved?.allowedRemoteIds).toEqual(['g1']);
  });

  it('blocks on a repository without an allowed remote, naming it as such', async () => {
    state.targets = [PUBLIC, INTERNAL];
    const policies = [namespacePolicy({}, { allowedRemotes: ['g1'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies });
    expect(route.targets).toEqual([]);
    expect(route.block?.reasons[0]).toBe(
      'Package "@acme/billing" is in reserved namespace "@acme" and repository "npm/all" has none of the remotes allowed to serve it'
    );
  });

  it('a missing package names the allowed remotes it was looked for in', async () => {
    state.targets = [PUBLIC, GITHUB];
    const policies = [namespacePolicy({}, { allowedRemotes: ['g1'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies });
    expect(namespaceNotFoundResult(route)?.reasons[0]).toBe(
      'Package "@acme/billing" is in reserved namespace "@acme" and was not found in the remotes allowed to serve it (npm/github-npm). Other remotes were not consulted.'
    );
  });

  it('monitor mode records a remote the policy does not allow, even an internal one', async () => {
    state.targets = [PUBLIC, GITHUB, INTERNAL];
    const policies = [namespacePolicy({ mode: 'monitor' }, { allowedRemotes: ['g1'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies });
    expect(namespaceMonitorMatches(route, GITHUB)).toEqual([]);
    expect(namespaceMonitorMatches(route, INTERNAL)[0]?.reasons[0]).toBe(
      'Served from npm/acme-artifactory, which the policy does not allow; enforcing would block it'
    );
  });

  it('a namespace policy scoped to a member remote covers requests through a virtual repository containing it', async () => {
    state.targets = [PUBLIC, INTERNAL];
    const policies = [namespacePolicy({ repositoryIds: ['p1'] })];
    const route = await resolvePackageTargets(fakeDb(), 'npm', 'all', '@acme/billing', { policies });
    expect(route.reserved).not.toBeNull();
    expect(route.targets.map((t) => t.key)).toEqual(['acme-artifactory']);
  });

  it('changing the order of the remotes gives a new cache scope (R2)', async () => {
    state.targets = [PUBLIC, INTERNAL];
    const first = (await resolvePackageTargets(fakeDb(), 'npm', 'all', 'lodash', { policies: [] })).cacheScope;
    state.targets = [INTERNAL, PUBLIC];
    const second = (await resolvePackageTargets(fakeDb(), 'npm', 'all', 'lodash', { policies: [] })).cacheScope;
    expect(first).not.toBe(second);
  });
});
