import { describe, expect, it } from 'vitest';
import { versionInRange, versionSpecError } from './version-range.js';

function inOrder(ecosystem: string, versions: string[]) {
  for (let i = 0; i < versions.length; i++) {
    for (let j = i + 1; j < versions.length; j++) {
      expect(versionInRange(ecosystem, versions[i], `<${versions[j]}`), `${versions[i]} < ${versions[j]}`).toBe(
        'match'
      );
      expect(versionInRange(ecosystem, versions[j], `<${versions[i]}`), `${versions[j]} < ${versions[i]}`).toBe(
        'miss'
      );
    }
  }
}

function equal(ecosystem: string, left: string, right: string) {
  expect(versionInRange(ecosystem, left, `=${right}`), `${left} == ${right}`).toBe('match');
  expect(versionInRange(ecosystem, right, `=${left}`), `${right} == ${left}`).toBe('match');
}

describe('versionInRange', () => {
  it('orders npm, Go, and Cargo with semver and includes prereleases inside the range', () => {
    expect(versionInRange('npm', '1.5.0', '<2.0.0')).toBe('match');
    expect(versionInRange('npm', '2.1.0', '<2.0.0')).toBe('miss');
    expect(versionInRange('npm', '1.2.3-rc.1', '<2.0.0')).toBe('match');
    expect(versionInRange('npm', '2.0.0-rc.1', '<2.0.0')).toBe('match');
    expect(versionInRange('npm', '2.0.0-rc.1', '>=2.0.0')).toBe('miss');
    expect(versionInRange('go', 'v1.2.3', '^1.0.0')).toBe('match');
    expect(versionInRange('cargo', '1.0.0-alpha.1', '<1.0.0')).toBe('match');
    expect(versionInRange('crates.io', '1.2.3', '1.0.0 - 2.0.0')).toBe('match');
    expect(versionInRange('npm', '1.0', '<2.0.0')).toBe('unknown');
  });

  it('orders PyPI versions by PEP 440', () => {
    inOrder('pypi', ['1.0.dev0', '1.0a1', '1.0b1', '1.0rc1', '1.0', '1.0.post1', '1.1']);
    equal('pypi', '1.0', '1.0.0');
    equal('pypi', '2.0.0rc1', '2.0.0.rc.1');
    expect(versionInRange('pypi', '1.0', '>=1.0.0 <2.0.0')).toBe('match');
    expect(versionInRange('pypi', '2.0.0rc1', '<2.0.0')).toBe('match');
    expect(versionInRange('pypi', '2.0.0rc1', '>=2.0.0')).toBe('miss');
    expect(versionInRange('pypi', '1.0.post1', '1.0.0 - 2.0.0')).toBe('match');
    expect(versionInRange('pypi', '1.0.post1', '<=1.0')).toBe('miss');
    expect(versionInRange('pypi', '1!0.1', '>2.0.0')).toBe('match');
    expect(versionInRange('pypi', 'not-a-version', '<2.0.0')).toBe('unknown');
  });

  it('orders Maven versions, including qualifiers', () => {
    inOrder('maven', [
      '1-alpha2snapshot',
      '1-alpha2',
      '1-alpha-123',
      '1-beta-2',
      '1-beta123',
      '1-m2',
      '1-m11',
      '1-rc',
      '1-cr2',
      '1-rc123',
      '1-SNAPSHOT',
      '1',
      '1-sp',
      '1-sp2',
      '1-sp123',
      '1-abc',
      '1-def',
      '1-pom-1',
      '1-1-snapshot',
      '1-1',
      '1-2',
      '1-123',
    ]);
    inOrder('maven', [
      '2.0',
      '2.0.a',
      '2-1',
      '2.0.2',
      '2.0.123',
      '2.1.0',
      '2.1-a',
      '2.1b',
      '2.1-c',
      '2.1-1',
      '2.1.0.1',
      '2.2',
      '2.123',
      '11.a2',
      '11.a11',
      '11.b2',
      '11.b11',
      '11.m2',
      '11.m11',
      '11',
      '11.a',
      '11b',
      '11c',
      '11m',
    ]);
    equal('maven', '1', '1.0.0');
    equal('maven', '1', '1-0');
    equal('maven', '1a', '1-a');
    equal('maven', '1a', '1.0-a');
    equal('maven', '1.0a', '1-a');
    equal('maven', '1a1', '1-alpha-1');
    equal('maven', '1ga', '1');
    equal('maven', '1final', '1');
    equal('maven', '1.2.3.Final', '1.2.3');
    expect(versionInRange('maven', '1.0-SNAPSHOT', '<1.0')).toBe('match');
    expect(versionInRange('maven', '31.1-jre', '>=31.1 <32')).toBe('match');
    expect(versionInRange('maven', '31.1-android', '<31.1-jre')).toBe('match');
    expect(versionInRange('maven', '6.1.0rc3', '<6.1.0')).toBe('match');
    expect(versionInRange('maven', '6.1.0', '<6.1H.5-beta')).toBe('match');
    expect(versionInRange('maven', '1.0.0.RC1', '<1.0.0-RC2')).toBe('match');
  });

  it('orders RubyGems versions', () => {
    equal('rubygems', '1.0', '1.0.0');
    expect(versionInRange('rubygems', '1.0.0.pre', '<1.0.0')).toBe('match');
    expect(versionInRange('rubygems', '1.0.0.pre', '>=1.0.0')).toBe('miss');
    expect(versionInRange('rubygems', '1.0.0.pre.1', '1.0.0.pre - 1.0.0')).toBe('match');
    inOrder('rubygems', ['1.0.0.pre', '1.0.0.pre.1', '1.0.0', '1.0.1']);
  });

  it('orders NuGet and Composer versions, including four-part and short forms', () => {
    equal('nuget', '1.0', '1.0.0');
    equal('nuget', '1.0.0', '1.0.0.0');
    expect(versionInRange('nuget', '1.0.0.1', '>1.0.0')).toBe('match');
    expect(versionInRange('nuget', '1.0.0.1', '<1.0.1')).toBe('match');
    expect(versionInRange('nuget', '1.0.0-beta', '<1.0.0')).toBe('match');
    expect(versionInRange('nuget', '1.0.0-beta.2', '<1.0.0-beta.10')).toBe('match');
    equal('composer', 'v1.2.3', '1.2.3');
    expect(versionInRange('composer', '1.0.0-RC1', '<1.0.0')).toBe('match');
    expect(versionInRange('composer', 'dev-master', '<2.0.0')).toBe('unknown');
  });

  it('treats a wildcard range as every version and an empty range as every version', () => {
    expect(versionInRange('pypi', '1.0.post1', '*')).toBe('match');
    expect(versionInRange('maven', '1.0-SNAPSHOT', '  ')).toBe('match');
  });

  it('does not let unsupported range syntax become a definite miss', () => {
    expect(versionInRange('rubygems', '1.5', '~> 1.2')).toBe('unknown');
    expect(versionInRange('maven', '1.5', '[1.0,2.0)')).toBe('unknown');
    expect(versionInRange('pypi', '1.5', '~=1.4')).toBe('unknown');
    expect(versionInRange('maven', '1.5', '[1.0 - 2.0)')).toBe('unknown');
  });

  it('decides an exact version it cannot order by its text', () => {
    expect(versionInRange('composer', 'dev-main', 'dev-main')).toBe('match');
    expect(versionInRange('composer', '1.2.3', '=dev-main')).toBe('miss');
    expect(versionInRange('pypi', '2004d', '=2004d')).toBe('match');
    expect(versionInRange('pypi', '2004d', '<3.0')).toBe('unknown');
  });
});

const NAMED_VERSIONS = [
  '1.2.3-rc.1',
  '2.0.0-rc.1',
  '2.0.0rc1',
  '1.0.post1',
  '1.0.dev1',
  '1.0-SNAPSHOT',
  '1.2.3.Final',
  '31.1-jre',
  '1.0.0.pre',
  '1.0.0-beta',
  'v1.2.3',
  'v0.0.0-20240101120000-abcdef123456',
  'v2.0.0+incompatible',
  '1.0.0+build.5',
  '1!2.0',
  '1.0.0.0',
];

describe('versionSpecError', () => {
  it('accepts named versions as a version and as range bounds', () => {
    for (const version of NAMED_VERSIONS) {
      expect(versionSpecError(version, []), version).toBeNull();
      expect(versionSpecError(`=${version}`, []), `=${version}`).toBeNull();
    }
    expect(versionSpecError('1.0-SNAPSHOT - 1.0', ['maven'])).toBeNull();
    expect(versionSpecError('2.0.0rc1 - 2.0.0.post1', ['pypi'])).toBeNull();
    expect(versionSpecError('=1.2.3 || 1.0.0-beta - 2.0.0 || >=3.0.0', [])).toBeNull();
  });

  it('treats an empty spec and a wildcard as any version', () => {
    expect(versionSpecError(undefined, [])).toBeNull();
    expect(versionSpecError('  ', ['npm'])).toBeNull();
    expect(versionSpecError('*', ['pypi'])).toBeNull();
  });

  it('rejects range syntax and words typed where a version belongs', () => {
    for (const spec of ['~> 1.2', '[1.0,2.0)', '~=1.4', '==1.5', '!=1.4', '>=1.0,<2.0', '1.*', '1.x', '1.2.X', 'latest', '1.0.0-', '>= 1.0']) {
      expect(versionSpecError(spec, ['pypi']), spec).toMatch(/is not a version/);
    }
    expect(versionSpecError('1.0 ||', ['npm'])).toMatch(/both sides/);
  });

  it('keeps npm range syntax for policies scoped only to semver ecosystems', () => {
    expect(versionSpecError('^1.2.0', ['npm'])).toBeNull();
    expect(versionSpecError('~1.2 || >=3', ['npm', 'cargo'])).toBeNull();
    expect(versionSpecError('^1.2.0', ['npm', 'pypi'])).toMatch(/is not a version/);
    expect(versionSpecError('^1.2.0', [])).toMatch(/is not a version/);
  });

  it('rejects a range whose start is after its end', () => {
    expect(versionSpecError('2.0.0 - 1.0.0', ['npm'])).toMatch(/after its end/);
    expect(versionSpecError('1.0 - 1.0-SNAPSHOT', ['maven'])).toMatch(/after its end/);
    expect(versionSpecError('1.0 - 1.0rc1', ['pypi'])).toMatch(/after its end/);
  });

  it('allows Composer branch versions only for Composer', () => {
    expect(versionSpecError('dev-main', ['composer'])).toBeNull();
    expect(versionSpecError('dev-main', ['npm'])).toMatch(/is not a version/);
    expect(versionSpecError('dev-main', [])).toMatch(/is not a version/);
  });

  it('enforces the stored column length', () => {
    expect(versionSpecError(`1.${'0'.repeat(200)}`, ['npm'], 128)).toMatch(/128 characters/);
  });
});
