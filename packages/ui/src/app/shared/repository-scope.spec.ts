import { describe, expect, it } from 'vitest';
import {
  deletionImpact,
  droppedByEcosystem,
  missingIds,
  scopeText,
  scopesOverlap,
  selectableRepositories,
} from './repository-scope';
import { REPOSITORY_ROWS as ROWS } from './repository-scope.testing';

describe('repository scope helpers', () => {
  it('says which repositories a scope covers', () => {
    expect(scopeText([])).toBe('all repositories');
    expect(scopeText([{ ecosystem: 'npm', key: 'prod' }])).toBe('npm/prod');
    expect(scopeText([{ ecosystem: 'npm', key: 'prod' }, { ecosystem: 'npm', key: 'staging' }, { ecosystem: 'pypi', key: 'prod' }])).toBe(
      'npm/prod, npm/staging and pypi/prod'
    );
  });

  it('offers only repositories of the chosen ecosystem, or every one for All', () => {
    expect(selectableRepositories(ROWS, ['pypi']).map((r) => r.id)).toEqual(['y']);
    expect(selectableRepositories(ROWS, [])).toHaveLength(4);
  });

  it('never offers all as a scope (R5)', () => {
    expect(selectableRepositories(ROWS, ['npm']).map((r) => r.key)).toEqual(['default', 'prod', 'frontend']);
  });

  it('drops repositories that no longer fit a changed ecosystem', () => {
    expect(droppedByEcosystem(ROWS, ['p', 'y'], ['npm']).map((r) => r.id)).toEqual(['y']);
    expect(droppedByEcosystem(ROWS, ['p', 'y'], [])).toEqual([]);
  });

  it('finds scoped IDs whose repository was deleted', () => {
    expect(missingIds(['p', 'gone'], [{ id: 'p', ecosystem: 'npm', key: 'prod', type: 'remote' }])).toEqual(['gone']);
    expect(missingIds(undefined, undefined)).toEqual([]);
  });

  it('two scopes overlap when either covers everything or they share a repository', () => {
    expect(scopesOverlap([], ['p'])).toBe(true);
    expect(scopesOverlap(['p'], ['p', 'd'])).toBe(true);
    expect(scopesOverlap(['p'], ['d'])).toBe(false);
  });

  it('describes what deleting a repository does', () => {
    expect(
      deletionImpact({
        policies: [
          { name: 'Prod licenses', onlyRepository: true },
          { name: 'Shared', onlyRepository: false },
        ],
        exceptions: [{ packageName: 'lodash', version: '*', onlyRepository: true }],
        waivers: [{ packageName: 'minimist', version: '1.2.5', onlyRepository: true }],
      })
    ).toEqual([
      'Policy "Prod licenses" will be disabled: this is the only repository it applies to.',
      'Policy "Shared" will no longer apply to it.',
      'Exception lodash@* will be deleted.',
      'Pending waiver request minimist@1.2.5 will be rejected.',
    ]);
    expect(deletionImpact({ policies: [], exceptions: [], waivers: [] })).toEqual([]);
    expect(
      deletionImpact({
        policies: [],
        exceptions: [],
        waivers: [],
        namespacePolicies: [
          { name: 'acme npm', onlyRemote: true },
          { name: 'shared', onlyRemote: false },
        ],
      })
    ).toEqual([
      'Namespace protection policy "acme npm" allows only this remote: its names will be blocked everywhere until another remote is allowed.',
    ]);
  });
});

