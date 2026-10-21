import { describe, expect, it } from 'vitest';
import { moveKey, orderWarning } from './repository-order';
import { repositoryRow } from './repository-scope.testing';

const internal = { ...repositoryRow('i', 'npm', 'acme-private', 'remote'), source: 'internal' as const, upstreamUrl: 'https://artifactory.acme.test/npm' };
const npmjs = { ...repositoryRow('d', 'npm', 'default', 'remote'), source: 'public' as const, upstreamUrl: 'https://registry.npmjs.org' };
const github = { ...repositoryRow('g', 'npm', 'github', 'remote'), source: 'public' as const, upstreamUrl: 'https://npm.pkg.github.com' };
const ROWS = [internal, npmjs, github];

describe('repository order (R2, R4)', () => {
  it('moves one key up or down and ignores moves past either end', () => {
    expect(moveKey(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveKey(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveKey(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveKey(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('warns when a public remote is searched before an internal one', () => {
    expect(orderWarning(['default', 'acme-private'], ROWS)).toBe(
      'Public registry default is searched before internal acme-private. A package published on registry.npmjs.org under one of your internal names would be taken from it. Move internal remotes first.'
    );
  });

  it('is quiet when internal remotes come first, or there are none', () => {
    expect(orderWarning(['acme-private', 'default', 'github'], ROWS)).toBeNull();
    expect(orderWarning(['default', 'github'], ROWS)).toBeNull();
    expect(orderWarning([], ROWS)).toBeNull();
  });

  it('names the first public remote and the last internal one it overtakes', () => {
    expect(orderWarning(['acme-private', 'github', 'default'], ROWS)).toBeNull();
    const other = { ...internal, id: 'j', key: 'acme-two' };
    expect(orderWarning(['acme-private', 'github', 'acme-two'], [...ROWS, other])).toMatch(/^Public registry github is searched before internal acme-two/);
  });
});
