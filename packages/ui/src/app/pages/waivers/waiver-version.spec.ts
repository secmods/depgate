import { describe, expect, it } from 'vitest';
import { buildVersion, constraintError, hasInvalidVersion, parseVersion, versionInputError } from './waiver-version';

describe('waiver versions', () => {
  it('starts empty so any version is requested', () => {
    expect(parseVersion(undefined)).toEqual([]);
    expect(parseVersion('*')).toEqual([]);
    expect(buildVersion([])).toBe('*');
  });

  it('keeps a single version exact', () => {
    const parsed = parseVersion('1.2.3');
    expect(parsed).toEqual([{ kind: 'exact', version: '1.2.3', from: '', to: '' }]);
    expect(buildVersion(parsed)).toBe('1.2.3');
  });

  it('keeps a filled range inclusive', () => {
    const parsed = parseVersion('1.0.0 - 2.0.0');
    expect(parsed).toEqual([{ kind: 'range', version: '', from: '1.0.0', to: '2.0.0' }]);
    expect(buildVersion(parsed)).toBe('1.0.0 - 2.0.0');
  });

  it('round-trips an exact version together with a range', () => {
    const stored = '4.17.21 || 1.0.0 - 2.0.0';
    expect(buildVersion(parseVersion(stored))).toBe(stored);
  });

  it('does not turn a single version into a greater-than range', () => {
    expect(buildVersion([{ kind: 'exact', version: '1.2.3', from: '', to: '' }])).toBe('1.2.3');
  });

  it('keeps a named version with a dash as one version, not a range', () => {
    for (const stored of ['1.0-SNAPSHOT', '=1.0.0-beta', '31.1-jre', '1.2.3-rc.1']) {
      const version = stored.replace(/^=/, '');
      expect(parseVersion(stored), stored).toEqual([{ kind: 'exact', version, from: '', to: '' }]);
    }
    expect(parseVersion('1.0-SNAPSHOT - 1.0')).toEqual([{ kind: 'range', version: '', from: '1.0-SNAPSHOT', to: '1.0' }]);
  });
});

describe('version input validation', () => {
  const named = [
    '1.2.3-rc.1', '2.0.0-rc.1', '2.0.0rc1', '1.0.post1', '1.0.dev1', '1.0-SNAPSHOT',
    '1.2.3.Final', '31.1-jre', '1.0.0.pre', '1.0.0-beta', 'v1.2.3', '1.0.0+build.5', '1!2.0',
  ];

  it('accepts named versions and leaves empty boxes to the dialog', () => {
    for (const version of named) expect(versionInputError(version), version).toBeNull();
    expect(versionInputError('  ')).toBeNull();
  });

  it('rejects range syntax and words typed into a version box', () => {
    for (const value of ['~> 1.2', '[1.0,2.0)', '~=1.4', '==1.5', '!=1.4', '>=1.0,<2.0', '^1.2.0', '1.*', '1.x', '1.2.X', 'latest', '=1.2.3', '1.0.0-']) {
      expect(versionInputError(value), value).toMatch(/single version/);
    }
  });

  it('accepts Composer branch versions only for Composer', () => {
    expect(versionInputError('dev-main', 'composer')).toBeNull();
    expect(versionInputError('dev-main', 'npm')).not.toBeNull();
  });

  it('reports the first bad bound of a range', () => {
    expect(constraintError({ kind: 'range', version: '', from: '1.0', to: '2.x' })).toMatch(/single version/);
    expect(hasInvalidVersion([{ kind: 'range', version: '', from: '1.0', to: '2.0-SNAPSHOT' }])).toBe(false);
    expect(hasInvalidVersion([{ kind: 'exact', version: '~> 1.2', from: '', to: '' }])).toBe(true);
  });
});
