import { describe, it, expect } from 'vitest';
import {
  abbreviatePackument,
  acceptsGzip,
  etagFor,
  etagMatches,
  repairDistTags,
  restoreBlockedVersions,
  rewritePackument,
  wantsAbbreviatedPackument,
  withPolicyRestrictions,
} from './npm-packument.js';

describe('npm-packument', () => {
  describe('rewritePackument', () => {
    it('rewrites dist.tarball URLs to gateway', () => {
      const packument = {
        name: 'lodash',
        versions: {
          '4.17.21': {
            dist: {
              tarball: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
              integrity: 'sha512-...',
            },
          },
        },
      };
      const result = rewritePackument(packument, 'https://gateway.example.com');
      expect(result.versions!['4.17.21'].dist!.tarball).toBe(
        'https://gateway.example.com/npm/lodash/-/lodash-4.17.21.tgz'
      );
    });

    it('rewrites scoped package tarball URLs', () => {
      const packument = {
        name: '@angular/core',
        versions: {
          '12.0.0': {
            dist: {
              tarball: 'https://registry.npmjs.org/@angular/core/-/core-12.0.0.tgz',
            },
          },
        },
      };
      const result = rewritePackument(packument, 'http://localhost:3050');
      expect(result.versions!['12.0.0'].dist!.tarball).toBe(
        'http://localhost:3050/npm/@angular%2fcore/-/core-12.0.0.tgz'
      );
    });

    it('rewrites an explicit repository key, including a URL already pointed at the gateway', () => {
      const packument = {
        name: 'lodash',
        versions: {
          '4.17.21': {
            dist: {
              tarball: 'http://localhost:3050/npm/lodash/-/lodash-4.17.21.tgz',
            },
          },
        },
      };
      const result = rewritePackument(packument, 'http://localhost:3050', { key: 'default', explicit: true });
      expect(result.versions!['4.17.21'].dist!.tarball).toBe(
        'http://localhost:3050/npm/default/lodash/-/lodash-4.17.21.tgz'
      );
    });

    it('leaves the access token out of rewritten tarball URLs', () => {
      const packument = {
        name: 'lodash',
        versions: {
          '4.17.21': {
            dist: { tarball: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' },
          },
        },
      };
      const result = rewritePackument(packument, 'http://localhost:3050', {
        key: 'default',
        explicit: true,
        accessToken: 'tok',
      });
      expect(result.versions!['4.17.21'].dist!.tarball).toBe(
        'http://localhost:3050/npm/default/lodash/-/lodash-4.17.21.tgz'
      );
    });

    it('preserves versions without dist.tarball', () => {
      const packument = {
        name: 'foo',
        versions: {
          '1.0.0': { main: 'index.js' },
        },
      };
      const result = rewritePackument(packument, 'https://gateway');
      expect(result.versions!['1.0.0']).toEqual({ main: 'index.js' });
    });
  });
});

describe('packument delivery', () => {
  it('points a blocked latest tag at the highest remaining version', () => {
    const repaired = repairDistTags({
      name: 'lodash',
      'dist-tags': { latest: '2.0.0', next: '2.0.0-beta' },
      versions: {
        '1.2.0': { version: '1.2.0' },
        '1.9.0': { version: '1.9.0' },
        '2.0.0-beta': { version: '2.0.0-beta' },
      },
    });
    expect(repaired['dist-tags']?.latest).toBe('1.9.0');
    expect(repaired['dist-tags']?.next).toBe('2.0.0-beta');
  });

  it('drops dist-tags when every version was removed', () => {
    expect(repairDistTags({ 'dist-tags': { latest: '1.0.0' }, versions: {} })['dist-tags']).toEqual({});
  });

  it('keeps a blocked version so npm requests that tarball', () => {
    const source = {
      name: 'lodash',
      'dist-tags': { latest: '4.17.21' },
      versions: {
        '4.17.20': { version: '4.17.20', dist: { tarball: 'http://registry/lodash-4.17.20.tgz' } },
        '4.17.21': {
          version: '4.17.21',
          dist: {
            tarball: 'http://registry/lodash-4.17.21.tgz',
            integrity: 'sha512-real',
            shasum: 'abc',
          },
        },
      },
    };
    const documented = restoreBlockedVersions(
      repairDistTags({
        ...source,
        versions: { '4.17.20': source.versions['4.17.20'] },
      }),
      source,
      {
        '4.17.21': {
          policyName: 'Block lodash',
          reasons: ['manual block'],
          remediation: 'Request a waiver.',
        },
      }
    );
    expect(documented.versions?.['4.17.21']?.dist?.tarball).toContain('depgate-decision=block');
    expect(documented.versions?.['4.17.21']?.dist?.integrity).toBeUndefined();
    expect(documented.versions?.['4.17.21']?.dist?.shasum).toBeUndefined();
    expect(documented.versions?.['4.17.21']?.deprecated).toBeUndefined();
    expect(documented['dist-tags']?.latest).toBe('4.17.20');
    expect(documented.policyRestrictions).toBeUndefined();
  });

  it('prints the policy once when several versions are blocked by it', () => {
    const documented = withPolicyRestrictions(
      { name: 'lodash', versions: {} },
      {
        '4.17.20': {
          policyName: 'lodash',
          reasons: ['Package "lodash" matches block list', 'Version 4.17.20 matches range "4.17.20 - 4.18"'],
          remediation: 'Contact your administrator to review policy "lodash" (ID: abc).',
        },
        '4.17.21': {
          policyName: 'lodash',
          reasons: ['Package "lodash" matches block list', 'Version 4.17.21 matches range "4.17.20 - 4.18"'],
          remediation: 'Contact your administrator to review policy "lodash" (ID: abc).',
        },
      }
    );
    expect(documented.policyRestrictions?.message).toBe(
      'Package blocked by policy "lodash": Package "lodash" matches block list. Contact your administrator to review policy "lodash" (ID: abc).'
    );
    expect(documented.policyRestrictions?.versions['4.17.21']?.message).toContain('Version 4.17.21 matches range');
  });

  it('keeps the install fields and the rewritten tarball in the abbreviated document', () => {
    const abbreviated = abbreviatePackument({
      name: 'lodash',
      readme: 'very long',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: 'lodash',
          version: '1.0.0',
          readme: 'very long',
          description: 'drop me',
          dependencies: { a: '1.0.0' },
          dist: {
            tarball: 'http://localhost:3050/npm/lodash/-/lodash-1.0.0.tgz',
            integrity: 'sha512-abc',
            fileCount: 1,
          },
        },
      },
    });
    expect(abbreviated.readme).toBeUndefined();
    expect(abbreviated.versions?.['1.0.0'].description).toBeUndefined();
    expect(abbreviated.versions?.['1.0.0'].dependencies).toEqual({ a: '1.0.0' });
    expect(abbreviated.versions?.['1.0.0'].dist?.tarball).toBe('http://localhost:3050/npm/lodash/-/lodash-1.0.0.tgz');
    expect(abbreviated.versions?.['1.0.0'].dist?.integrity).toBe('sha512-abc');
  });

  it('honors the abbreviated Accept header and gzip', () => {
    expect(wantsAbbreviatedPackument('application/vnd.npm.install-v1+json')).toBe(true);
    expect(wantsAbbreviatedPackument('application/json')).toBe(false);
    expect(wantsAbbreviatedPackument('application/vnd.npm.install-v1+json;q=0')).toBe(false);
    expect(acceptsGzip('gzip, deflate')).toBe(true);
    expect(acceptsGzip('identity')).toBe(false);
    const etag = etagFor('{"name":"lodash"}');
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
    expect(etagMatches('"something-else"', etag)).toBe(false);
  });
});
