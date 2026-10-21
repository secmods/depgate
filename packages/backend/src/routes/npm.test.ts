import { describe, it, expect } from 'vitest';
import { extractVersionFromTarball } from './npm.js';

describe('extractVersionFromTarball', () => {
  it('extracts standard semver (1.0.0)', () => {
    expect(extractVersionFromTarball('lodash-4.17.21.tgz')).toBe('4.17.21');
    expect(extractVersionFromTarball('pkg-1.0.0.tgz')).toBe('1.0.0');
  });

  it('extracts two-part version (1.0)', () => {
    expect(extractVersionFromTarball('pkg-1.0.tgz')).toBe('1.0');
    expect(extractVersionFromTarball('pkg-0.1.tgz')).toBe('0.1');
  });

  it('extracts four-part version (1.0.0.0)', () => {
    expect(extractVersionFromTarball('pkg-1.0.0.0.tgz')).toBe('1.0.0.0');
  });

  it('extracts single-digit version (1)', () => {
    expect(extractVersionFromTarball('pkg-1.tgz')).toBe('1');
  });

  it('extracts prerelease version', () => {
    expect(extractVersionFromTarball('pkg-1.0.0-alpha.tgz')).toBe('1.0.0-alpha');
    expect(extractVersionFromTarball('pkg-1.0.0-alpha.1.tgz')).toBe('1.0.0-alpha.1');
    expect(extractVersionFromTarball('pkg-1.0.0-beta.2.tgz')).toBe('1.0.0-beta.2');
  });

  it('extracts version from scoped package tarball (core-12.0.0.tgz)', () => {
    expect(extractVersionFromTarball('core-12.0.0.tgz')).toBe('12.0.0');
  });

  it('extracts version from multi-hyphen package name', () => {
    expect(extractVersionFromTarball('my-package-name-1.0.0.tgz')).toBe('1.0.0');
    expect(extractVersionFromTarball('some-pkg-2.3.4.tgz')).toBe('2.3.4');
  });

  it('returns null when no hyphen before .tgz', () => {
    expect(extractVersionFromTarball('pkg.tgz')).toBeNull();
  });

  it('returns null when not ending with .tgz', () => {
    expect(extractVersionFromTarball('pkg-1.0.0.tar')).toBeNull();
    expect(extractVersionFromTarball('pkg-1.0.0')).toBeNull();
  });
});
