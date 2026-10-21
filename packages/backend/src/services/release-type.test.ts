import { describe, expect, it } from 'vitest';
import { classifyRelease, releaseTypeApplies, releaseTypeReason, type ReleaseType } from './release-type.js';

type Vector = [version: string, type: ReleaseType, marker?: string];

function check(ecosystem: string, vectors: Vector[]) {
  for (const [version, type, marker] of vectors) {
    const release = classifyRelease(ecosystem, version);
    expect(release.type, `${ecosystem} ${version}`).toBe(type);
    if (marker !== undefined) expect(release.marker, `${ecosystem} ${version} marker`).toBe(marker);
  }
}

describe('classifyRelease', () => {
  it('reads npm and Cargo versions as SemVer', () => {
    for (const ecosystem of ['npm', 'cargo']) {
      check(ecosystem, [
        ['1.2.3', 'stable'],
        ['1.0.0+build.5', 'stable'],
        ['1.2.3-rc.1', 'prerelease', 'rc'],
        ['2.0.0-rc.1', 'prerelease', 'rc'],
        ['1.0.0-beta', 'prerelease', 'beta'],
        ['1.0.0-alpha.1', 'prerelease', 'alpha'],
        ['19.0.0-canary-5d29478-20240101', 'prerelease', 'canary'],
        ['1.0.0-beta+exp.sha.5114f85', 'prerelease', 'beta'],
      ]);
    }
  });

  it('reads NuGet versions, including four parts and legacy labels', () => {
    check('nuget', [
      ['1.0', 'stable'],
      ['1.0.0.0', 'stable'],
      ['1.0.0.1', 'stable'],
      ['1.0.0+git.abc', 'stable'],
      ['1.0.0-beta', 'prerelease', 'beta'],
      ['1.0.0-beta1', 'prerelease', 'beta'],
      ['8.0.0-preview.1.23110.8', 'prerelease', 'preview'],
    ]);
  });

  it('separates Go pseudo-versions from tagged pre-releases', () => {
    check('go', [
      ['v1.2.3', 'stable'],
      ['v2.0.0+incompatible', 'stable'],
      ['v1.2.0-rc.1', 'prerelease', 'rc'],
      ['v0.0.0-20240101120000-abcdef123456', 'pseudo', 'abcdef123456'],
      ['v1.2.4-0.20240101120000-abcdef123456', 'pseudo', 'abcdef123456'],
      ['v1.2.0-rc.1.0.20240101120000-abcdef123456', 'pseudo', 'abcdef123456'],
      ['v2.0.0-20240101120000-abcdef123456+incompatible', 'pseudo', 'abcdef123456'],
    ]);
  });

  it('reads PyPI versions by PEP 440', () => {
    check('pypi', [
      ['1.0', 'stable'],
      ['1.0.post1', 'stable'],
      ['1!2.0', 'stable'],
      ['2.1.0+cu118', 'stable'],
      ['2.0.0rc1', 'prerelease', 'rc'],
      ['1.0a1', 'prerelease', 'a'],
      ['1.0b2', 'prerelease', 'b'],
      ['1.0c1', 'prerelease', 'rc'],
      ['1.0-preview1', 'prerelease', 'rc'],
      ['1.0rc1.post1', 'prerelease', 'rc'],
      ['2.1.0rc1+cu118', 'prerelease', 'rc'],
      ['1.0.dev1', 'dev', '.dev'],
      ['1.0a1.dev1', 'dev', '.dev'],
      ['1.0.post1.dev2', 'dev', '.dev'],
      ['2004d', 'unknown'],
    ]);
  });

  it('reads Maven qualifiers as whole tokens and snapshots first', () => {
    check('maven', [
      ['1.0', 'stable'],
      ['20231013', 'stable'],
      ['1.2.3.Final', 'stable'],
      ['5.3.30.RELEASE', 'stable'],
      ['1.0-GA', 'stable'],
      ['2.0-SP1', 'stable'],
      ['31.1-jre', 'stable'],
      ['31.1-android', 'stable'],
      ['1.0-src', 'stable'],
      ['1.0-b', 'stable'],
      ['1.0-SNAPSHOT', 'snapshot', 'SNAPSHOT'],
      ['1.0-20240101.123456-1', 'snapshot', '20240101.123456-1'],
      ['2.0.0-RC1-SNAPSHOT', 'snapshot', 'SNAPSHOT'],
      ['2.0.0-RC1', 'prerelease', 'rc'],
      ['6.0.0.CR2', 'prerelease', 'cr'],
      ['1.0-M1', 'prerelease', 'm'],
      ['1.0-beta-2', 'prerelease', 'beta'],
      ['1.0a1', 'prerelease', 'a'],
      ['1.0-alpha', 'prerelease', 'alpha'],
      ['21-ea', 'prerelease', 'ea'],
      ['1.0-preview', 'prerelease', 'preview'],
    ]);
  });

  it('treats any letter in a RubyGems version as a pre-release', () => {
    check('rubygems', [
      ['1.0', 'stable'],
      ['1.15.0', 'stable'],
      ['1.0.0.pre', 'prerelease', 'pre'],
      ['7.1.0.beta1', 'prerelease', 'beta'],
      ['1.0.0.rc1', 'prerelease', 'rc'],
      ['1.0.0-beta', 'prerelease', 'beta'],
    ]);
  });

  it('reads Composer stability flags', () => {
    check('composer', [
      ['1.2.3.0', 'stable'],
      ['v1.2.3', 'stable'],
      ['1.0.0-p1', 'stable'],
      ['1.0.0.0-patch1', 'stable'],
      ['1.0.0.0-RC1', 'prerelease', 'RC'],
      ['1.0.0-beta1', 'prerelease', 'beta'],
      ['1.0.0-alpha2', 'prerelease', 'alpha'],
      ['dev-main', 'dev', 'dev-'],
      ['dev-feature/login', 'dev', 'dev-'],
      ['1.0.x-dev', 'dev', '-dev'],
      ['9999999-dev', 'dev', '-dev'],
      ['1.0.9999999.9999999-dev', 'dev', '-dev'],
    ]);
  });
});

describe('releaseTypeReason', () => {
  it('states the version, the type, and what decided it', () => {
    const reason = (ecosystem: string, version: string) =>
      releaseTypeReason(version, classifyRelease(ecosystem, version));
    expect(reason('pypi', '2.0.0rc1')).toBe('Version 2.0.0rc1 is a pre-release (PEP 440 "rc")');
    expect(reason('maven', '2.0.0-RC1')).toBe('Version 2.0.0-RC1 is a pre-release (Maven "rc")');
    expect(reason('npm', '1.2.3-rc.1')).toBe('Version 1.2.3-rc.1 is a pre-release (SemVer "rc")');
    expect(reason('rubygems', '7.1.0.beta1')).toBe('Version 7.1.0.beta1 is a pre-release (RubyGems "beta")');
    expect(reason('composer', '1.0.0-beta1')).toBe('Version 1.0.0-beta1 is a pre-release (Composer "beta")');
    expect(reason('pypi', '1.0.dev1')).toBe('Version 1.0.dev1 is a dev release (PEP 440 ".dev")');
    expect(reason('composer', 'dev-main')).toBe('Version dev-main is a dev branch (Composer "dev-")');
    expect(reason('maven', '1.0-SNAPSHOT')).toBe('Version 1.0-SNAPSHOT is a snapshot (Maven "SNAPSHOT")');
    expect(reason('go', 'v0.0.0-20240101120000-abcdef123456')).toBe(
      'Version v0.0.0-20240101120000-abcdef123456 is a pseudo-version (untagged Go commit abcdef123456)'
    );
  });
});

describe('releaseTypeApplies', () => {
  it('limits dev, snapshot, and pseudo to the ecosystems that have them', () => {
    expect(releaseTypeApplies('prerelease', 'cargo')).toBe(true);
    expect(releaseTypeApplies('dev', 'pypi')).toBe(true);
    expect(releaseTypeApplies('dev', 'npm')).toBe(false);
    expect(releaseTypeApplies('snapshot', 'maven')).toBe(true);
    expect(releaseTypeApplies('snapshot', 'go')).toBe(false);
    expect(releaseTypeApplies('pseudo', 'go')).toBe(true);
  });
});
