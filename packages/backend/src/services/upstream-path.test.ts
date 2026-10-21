import { describe, expect, it } from 'vitest';
import { UnsafeUpstreamPathError, isUnsafePathParam, isUnsafeUpstreamPath, upstreamUrl } from './upstream-path.js';

describe('isUnsafeUpstreamPath', () => {
  it('accepts ordinary package paths', () => {
    for (const path of [
      'lodash/-/lodash-4.17.21.tgz',
      '@types%2fnode',
      'github.com/sirupsen/logrus/@v/v1.9.3.zip',
      'org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar',
      'v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg',
      'api/v1/crates/serde/1.0.0/download',
      'p2/monolog/monolog~dev.json',
      'simple/requests/',
      'gems/rake-13.1.0.gem',
      'info/.github',
    ]) {
      expect(isUnsafeUpstreamPath(path), path).toBe(false);
    }
  });

  it('rejects dot segments in every form the URL parser or a registry resolves', () => {
    for (const path of [
      'lodash/-/../../evil-pkg/-/evil-pkg-1.0.0.tgz',
      'github.com/good/x/../../../evil/x/@v/v1.0.0.zip',
      './x',
      'a/%2e%2e/b',
      'a/.%2E/b',
      'a/%252e%252e/b',
      '@a%2f..%2fevil',
      'a/..%252Fevil',
      'a/..\\evil',
      'a/..%5cevil',
      'a/.\t./b',
      'a/.%0a./b',
    ]) {
      expect(isUnsafeUpstreamPath(path), path).toBe(true);
    }
  });

  it('rejects a query or fragment that would cut the path short', () => {
    expect(isUnsafeUpstreamPath('evil.com/mal/@v/v1.0.0.zip?/@v/v9.zip')).toBe(true);
    expect(isUnsafeUpstreamPath('evil.com/mal/@v/v1.0.0.zip#/@v/v9.zip')).toBe(true);
  });
});

describe('isUnsafePathParam', () => {
  it('rejects a decoded slash in a single-segment param', () => {
    expect(isUnsafePathParam('../../evil-pkg/-/evil-pkg-1.0.0.tgz', { wildcard: false })).toBe(true);
    expect(isUnsafePathParam('x/evil-pkg-1.0.0.tgz', { wildcard: false })).toBe(true);
    expect(isUnsafePathParam('lodash-4.17.21.tgz', { wildcard: false })).toBe(false);
  });

  it('lets the npm scoped form through only where allowed', () => {
    expect(isUnsafePathParam('@types/node', { wildcard: false, allowScopedName: true })).toBe(false);
    expect(isUnsafePathParam('@types/node', { wildcard: false })).toBe(true);
    expect(isUnsafePathParam('@a/b/c', { wildcard: false, allowScopedName: true })).toBe(true);
    expect(isUnsafePathParam('@a/..', { wildcard: false, allowScopedName: true })).toBe(true);
  });

  it('allows slashes but not dot segments in a wildcard', () => {
    expect(isUnsafePathParam('github.com/a/b/@v/list', { wildcard: true })).toBe(false);
    expect(isUnsafePathParam('github.com/a/../b/@v/list', { wildcard: true })).toBe(true);
  });
});

describe('upstreamUrl', () => {
  it('joins the remote URL, base path and path', () => {
    expect(upstreamUrl('https://registry.npmjs.org/', '/lodash')).toBe('https://registry.npmjs.org/lodash');
    expect(upstreamUrl('https://art.test/api/npm/remote', 'lodash/-/lodash-1.0.0.tgz')).toBe(
      'https://art.test/api/npm/remote/lodash/-/lodash-1.0.0.tgz'
    );
    expect(upstreamUrl('https://art.test/root', 'x', 'sub/')).toBe('https://art.test/root/sub/x');
  });

  it('refuses a path that leaves the remote base path', () => {
    expect(() => upstreamUrl('https://art.test/api/npm/remote', '../../npm-private/x')).toThrow(UnsafeUpstreamPathError);
    expect(() => upstreamUrl('https://registry.npmjs.org', 'lodash/-/../../evil-pkg/-/evil-pkg-1.0.0.tgz')).toThrow(
      UnsafeUpstreamPathError
    );
  });

  it('refuses a path that changes the host', () => {
    expect(() => upstreamUrl('https://art.test/api', '/@evil.test/x')).not.toThrow();
    expect(() => upstreamUrl('https://art.test', '\\\\evil.test/x')).toThrow(UnsafeUpstreamPathError);
  });
});
