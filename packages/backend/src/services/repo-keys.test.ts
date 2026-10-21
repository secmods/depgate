import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyRepoKeyMessage,
  bindRepoKeyPublisher,
  clientPath,
  forgetRepoKey,
  isKnownRepoKey,
  rememberRepoKey,
  REPO_KEY_CHANNEL,
  rewritePackageUrl,
  shareRepoKey,
  unshareRepoKey,
  validateRepoKey,
} from './repo-keys.js';

describe('rewritePackageUrl', () => {
  it('leaves a legacy npm path on the default repository', () => {
    const req: { depgateRepoKey?: string; depgateRepoExplicit?: boolean } = {};
    expect(rewritePackageUrl('/npm/lodash', req)).toBe('/npm/lodash');
    expect(req).toEqual({ depgateRepoKey: 'default', depgateRepoExplicit: false });
  });

  it('strips a reserved key and keeps the trailing slash', () => {
    const req: { depgateRepoKey?: string; depgateRepoExplicit?: boolean } = {};
    expect(rewritePackageUrl('/pypi/default/simple/requests/', req)).toBe('/pypi/simple/requests/');
    expect(req).toEqual({ depgateRepoKey: 'default', depgateRepoExplicit: true });
  });

  it('keeps the query string when rewriting an explicit repository', () => {
    const req: { depgateRepoKey?: string; depgateRepoExplicit?: boolean } = {};
    expect(rewritePackageUrl('/npm/all/lodash?write=true', req)).toBe('/npm/lodash?write=true');
    expect(req.depgateRepoKey).toBe('all');
    expect(req.depgateRepoExplicit).toBe(true);
  });

  it('treats an unknown first segment as a package name', () => {
    const req: { depgateRepoKey?: string; depgateRepoExplicit?: boolean } = {};
    expect(rewritePackageUrl('/npm/lodash/-/lodash-1.0.0.tgz', req)).toBe('/npm/lodash/-/lodash-1.0.0.tgz');
    expect(req.depgateRepoExplicit).toBe(false);
  });

  it('strips the path token and injects a bearer header', () => {
    const req: { headers: { authorization?: string }; depgateRepoKey?: string; depgateRepoExplicit?: boolean; depgateAccessToken?: string } = { headers: {} };
    expect(rewritePackageUrl('/npm/default/_auth/tok.en/lodash', req)).toBe('/npm/lodash');
    expect(req.depgateRepoKey).toBe('default');
    expect(req.depgateRepoExplicit).toBe(true);
    expect(req.depgateAccessToken).toBe('tok.en');
    expect(req.headers.authorization).toBe('Bearer tok.en');
  });

  it('accepts a token on a legacy path that has no repository key', () => {
    const req: { headers: { authorization?: string }; depgateAccessToken?: string; depgateRepoExplicit?: boolean } = { headers: {} };
    expect(rewritePackageUrl('/npm/_auth/tok/lodash', req)).toBe('/npm/lodash');
    expect(req.depgateAccessToken).toBe('tok');
    expect(req.depgateRepoExplicit).toBe(false);
    expect(req.headers.authorization).toBe('Bearer tok');
  });

  it('leaves an existing authorization header in place', () => {
    const req = { headers: { authorization: 'Bearer already' } };
    rewritePackageUrl('/npm/default/_auth/tok/lodash', req);
    expect(req.headers.authorization).toBe('Bearer already');
  });

  it('recognizes a key registered after startup', () => {
    rememberRepoKey('npm', 'github');
    const req: { depgateRepoKey?: string; depgateRepoExplicit?: boolean } = {};
    expect(rewritePackageUrl('/npm/github/left-pad', req)).toBe('/npm/left-pad');
    expect(req.depgateRepoKey).toBe('github');
    forgetRepoKey('npm', 'github');
    expect(isKnownRepoKey('npm', 'github')).toBe(false);
  });
});

describe('repo key replication', () => {
  afterEach(() => {
    bindRepoKeyPublisher(null);
    forgetRepoKey('npm', 'github');
    forgetRepoKey('pypi', 'acme');
  });

  it('publishes a create so another process can apply it', () => {
    const publish = vi.fn().mockResolvedValue(1);
    bindRepoKeyPublisher({ publish });
    shareRepoKey('npm', 'github');
    expect(publish).toHaveBeenCalledWith(
      REPO_KEY_CHANNEL,
      JSON.stringify({ op: 'add', ecosystem: 'npm', key: 'github' })
    );

    forgetRepoKey('pypi', 'acme');
    applyRepoKeyMessage(JSON.stringify({ op: 'add', ecosystem: 'pypi', key: 'acme' }));
    const req: { depgateRepoKey?: string } = {};
    expect(rewritePackageUrl('/pypi/acme/simple/requests/', req)).toBe('/pypi/simple/requests/');
    expect(req.depgateRepoKey).toBe('acme');
  });

  it('publishes a delete and drops the key on the subscriber', () => {
    const publish = vi.fn().mockResolvedValue(1);
    bindRepoKeyPublisher({ publish });
    shareRepoKey('npm', 'github');
    unshareRepoKey('npm', 'github');
    expect(isKnownRepoKey('npm', 'github')).toBe(false);
    expect(publish).toHaveBeenLastCalledWith(
      REPO_KEY_CHANNEL,
      JSON.stringify({ op: 'remove', ecosystem: 'npm', key: 'github' })
    );
    applyRepoKeyMessage(JSON.stringify({ op: 'remove', ecosystem: 'npm', key: 'github' }));
    expect(rewritePackageUrl('/npm/github/left-pad', {})).toBe('/npm/github/left-pad');
  });
});

describe('validateRepoKey', () => {
  it('rejects reserved and protocol keys', () => {
    expect(validateRepoKey('default')).toMatch(/reserved/);
    expect(validateRepoKey('simple')).toMatch(/protocol/);
    expect(validateRepoKey('team-npm')).toBeNull();
  });
});

describe('clientPath', () => {
  it('builds the client path for each ecosystem', () => {
    expect(clientPath('npm', 'default')).toBe('/npm/default/');
    expect(clientPath('pypi', 'all')).toBe('/pypi/all/simple/');
    expect(clientPath('nuget', 'github')).toBe('/nuget/github/v3/index.json');
    expect(clientPath('cargo', 'default')).toBe('/cargo/default/');
  });
});
