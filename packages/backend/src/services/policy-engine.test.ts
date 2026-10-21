import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  latestVersionPublishTime,
  packumentTimeMap,
  withVersionPublishTime,
  type PolicyConditions,
  type PackageContext,
} from './policy-engine.js';

describe('policy-engine', () => {
  describe('evaluateConditions', () => {
    it('matches package block list (exact)', () => {
      const conditions: PolicyConditions = {
        packageBlockList: ['bad-package', 'malware-*'],
      };
      const ctx: PackageContext = { name: 'bad-package', version: '1.0.0' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(true);
    });

    it('matches package block list (glob)', () => {
      const conditions: PolicyConditions = {
        packageBlockList: ['malware-*'],
      };
      const ctx: PackageContext = { name: 'malware-fake-lib', version: '1.0.0' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(true);
    });

    it('does not match when package not in block list', () => {
      const conditions: PolicyConditions = {
        packageBlockList: ['bad-package'],
      };
      const ctx: PackageContext = { name: 'lodash', version: '4.17.5' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(false);
    });

    it('matches license deny list', () => {
      const conditions: PolicyConditions = {
        licenseDenyList: ['GPL-3.0', 'AGPL-*'],
      };
      const ctx: PackageContext = { name: 'foo', version: '1.0.0', license: 'GPL-3.0' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(true);
    });

    it('does not block a dual license when another choice is allowed', () => {
      const conditions: PolicyConditions = { licenseDenyList: ['GPL-3.0'] };
      expect(evaluateConditions({ name: 'foo', version: '1.0.0', license: 'MIT OR GPL-3.0' }, conditions).match).toBe(false);
      expect(evaluateConditions({ name: 'foo', version: '1.0.0', license: 'MIT AND GPL-3.0' }, conditions).match).toBe(true);
    });

    it('allows only approved licenses and blocks the rest, unknown included', () => {
      const conditions: PolicyConditions = { licenseAllowList: ['MIT', 'Apache-2.0'] };
      const check = (license?: string) => evaluateConditions({ name: 'foo', version: '1.0.0', license }, conditions);
      expect(check('MIT').match).toBe(false);
      expect(check('MIT OR GPL-3.0').match).toBe(false);
      expect(check('GPL-3.0').reasons).toEqual(['License "GPL-3.0" is not in the approved list']);
      expect(check(undefined).reasons).toEqual(['License is unknown, and only approved licenses are allowed']);
      expect(evaluateConditions({ name: 'foo', version: '1.0.0' }, { ...conditions, allowUnknownLicense: true }).match).toBe(false);
    });

    it('matches license deny list from version meta', () => {
      const conditions: PolicyConditions = {
        licenseDenyList: ['AGPL-3.0'],
      };
      const ctx: PackageContext = { name: 'foo', version: '1.0.0' };
      const versionMeta = { license: 'AGPL-3.0' };
      const { match } = evaluateConditions(ctx, conditions, versionMeta);
      expect(match).toBe(true);
    });

    it('matches version range', () => {
      const conditions: PolicyConditions = {
        versionRange: '<2.0.0',
      };
      const ctx: PackageContext = { name: 'foo', version: '1.5.0' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(true);
    });

    it('does not match version range when outside', () => {
      const conditions: PolicyConditions = {
        versionRange: '<2.0.0',
      };
      const ctx: PackageContext = { name: 'foo', version: '2.1.0' };
      const { match } = evaluateConditions(ctx, conditions);
      expect(match).toBe(false);
    });

    it('matches release age max hours (too new)', () => {
      const conditions: PolicyConditions = {
        releaseAgeMaxHours: 24 * 365,
      };
      const ctx: PackageContext = {
        name: 'foo',
        version: '1.0.0',
        publishedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      };
      const versionMeta = { time: new Date(Date.now() - 1000 * 60 * 60).toISOString() };
      const { match } = evaluateConditions(ctx, conditions, versionMeta);
      expect(match).toBe(true);
    });

    it('matches release age min days (unmaintained)', () => {
      const conditions: PolicyConditions = {
        releaseAgeMinDays: 30,
      };
      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const ctx: PackageContext = {
        name: 'foo',
        version: '1.0.0',
        packageLastReleaseAt: oldDate.toISOString(),
      };
      const versionMeta = { time: oldDate.toISOString() };
      const { match } = evaluateConditions(ctx, conditions, versionMeta);
      expect(match).toBe(true);
    });

    it('returns reasons when match', () => {
      const conditions: PolicyConditions = {
        packageBlockList: ['blocked-pkg'],
      };
      const ctx: PackageContext = { name: 'blocked-pkg', version: '1.0.0' };
      const { match, reasons } = evaluateConditions(ctx, conditions);
      expect(match).toBe(true);
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons[0]).toContain('block list');
    });

    describe('combined conditions (every condition must match)', () => {
      it('matches only when package, license, and version all match', () => {
        const conditions: PolicyConditions = {
          packageBlockList: ['lodash'],
          licenseDenyList: ['MIT'],
          versionRange: '<2.0.0',
        };
        const ctx: PackageContext = { name: 'lodash', version: '1.0.0', license: 'MIT' };
        const { match, reasons } = evaluateConditions(ctx, conditions);
        expect(match).toBe(true);
        expect(reasons.join(' ')).toContain('block list');
        expect(reasons.join(' ')).toContain('license');
        expect(reasons.join(' ')).toContain('Version');
      });

      it('does not match when the package matches but the version is outside the range', () => {
        const conditions: PolicyConditions = {
          packageBlockList: ['express'],
          versionRange: '5.0.0 - 5.2.1',
        };
        const inside = evaluateConditions({ name: 'express', version: '5.1.0' }, conditions);
        const below = evaluateConditions({ name: 'express', version: '4.21.2' }, conditions);
        const above = evaluateConditions({ name: 'express', version: '5.2.2' }, conditions);
        const edges = [
          evaluateConditions({ name: 'express', version: '5.0.0' }, conditions),
          evaluateConditions({ name: 'express', version: '5.2.1' }, conditions),
        ];
        expect(inside.match).toBe(true);
        expect(below.match).toBe(false);
        expect(above.match).toBe(false);
        expect(edges.every((result) => result.match)).toBe(true);
      });

      it('does not match a different package inside the version range', () => {
        const conditions: PolicyConditions = {
          packageBlockList: ['express'],
          versionRange: '5.0.0 - 5.2.1',
        };
        const { match } = evaluateConditions({ name: 'lodash', version: '5.1.0' }, conditions);
        expect(match).toBe(false);
      });

      it('does not match when the license fails even if the package and version match', () => {
        const conditions: PolicyConditions = {
          packageBlockList: ['lodash'],
          licenseDenyList: ['GPL-3.0'],
          versionRange: '<2.0.0',
        };
        const ctx: PackageContext = { name: 'lodash', version: '1.0.0', license: 'MIT' };
        const { match } = evaluateConditions(ctx, conditions);
        expect(match).toBe(false);
      });

      it('does not match when package has no license but licenseDenyList is specified', () => {
        const conditions: PolicyConditions = {
          licenseDenyList: ['GPL-3.0'],
        };
        const ctx: PackageContext = { name: 'foo', version: '1.0.0' };
        const { match } = evaluateConditions(ctx, conditions);
        expect(match).toBe(false);
      });

      it('matches license from versionMeta when ctx.license is missing', () => {
        const conditions: PolicyConditions = {
          licenseDenyList: ['AGPL-3.0'],
        };
        const ctx: PackageContext = { name: 'foo', version: '1.0.0' };
        const versionMeta = { license: 'AGPL-3.0' };
        const { match } = evaluateConditions(ctx, conditions, versionMeta);
        expect(match).toBe(true);
      });
    });

    describe('ecosystem filter', () => {
      it('does not affect evaluateConditions (ecosystem checked in caller)', () => {
        const conditions: PolicyConditions = {
          ecosystem: ['npm'],
          packageBlockList: ['lodash'],
        };
        const ctx: PackageContext = { name: 'lodash', version: '4.17.5' };
        const { match } = evaluateConditions(ctx, conditions);
        expect(match).toBe(true);
      });
    });

    describe('ecosystem version ordering', () => {
      it('matches PyPI versions npm semver cannot parse', () => {
        const conditions: PolicyConditions = { versionRange: '>=1.0.0 <3.0.0' };
        expect(evaluateConditions({ name: 'requests', version: '1.0', ecosystem: 'pypi' }, conditions).match).toBe(
          true
        );
        expect(
          evaluateConditions({ name: 'requests', version: '2.0.0rc1', ecosystem: 'pypi' }, conditions).match
        ).toBe(true);
        expect(
          evaluateConditions({ name: 'requests', version: '1.0.post1', ecosystem: 'pypi' }, conditions).match
        ).toBe(true);
        expect(evaluateConditions({ name: 'requests', version: '3.0.0', ecosystem: 'pypi' }, conditions).match).toBe(
          false
        );
      });

      it('matches an exact non-semver version instead of dropping the constraint', () => {
        const conditions: PolicyConditions = { packageBlockList: ['guava'], versionRange: '=31.1-jre' };
        const hit = evaluateConditions({ name: 'guava', version: '31.1-jre', ecosystem: 'maven' }, conditions);
        const other = evaluateConditions({ name: 'guava', version: '31.1-android', ecosystem: 'maven' }, conditions);
        expect(hit.match).toBe(true);
        expect(other.match).toBe(false);
      });

      it('treats an uncomparable version as a match for a block and a miss for an allow', () => {
        const conditions: PolicyConditions = { versionRange: '>=1.0.0 <2.0.0' };
        const ctx: PackageContext = { name: 'foo', version: 'not a version', ecosystem: 'pypi' };
        expect(evaluateConditions(ctx, conditions, undefined, 'BLOCK').match).toBe(true);
        expect(evaluateConditions(ctx, conditions, undefined, 'ALLOW').match).toBe(false);
      });

      it('includes semver prereleases that sit inside the numeric range', () => {
        const conditions: PolicyConditions = { versionRange: '<2.0.0' };
        expect(evaluateConditions({ name: 'foo', version: '1.2.3-rc.1', ecosystem: 'npm' }, conditions).match).toBe(
          true
        );
        expect(evaluateConditions({ name: 'foo', version: '2.0.0-rc.1', ecosystem: 'npm' }, conditions).match).toBe(
          true
        );
        expect(evaluateConditions({ name: 'foo', version: '2.0.0', ecosystem: 'npm' }, conditions).match).toBe(false);
      });
    });
  });

  describe('npm packument time map', () => {
    const packument = {
      time: {
        created: '2014-03-14T09:09:20.762Z',
        modified: new Date().toISOString(),
        '1.0.0': '2016-03-22T21:42:18.002Z',
        '1.1.0': new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
      versions: {
        '1.0.0': { name: 'left-pad', version: '1.0.0' },
        '1.1.0': { name: 'left-pad', version: '1.1.0' },
      },
    };

    it('uses the top-level version time when the version object has none', () => {
      const timeMap = packumentTimeMap(packument);
      const recent = withVersionPublishTime(packument.versions['1.1.0'], '1.1.0', timeMap);
      const { match } = evaluateConditions(
        { name: 'left-pad', version: '1.1.0' },
        { releaseAgeMaxHours: 24 },
        recent
      );
      expect(match).toBe(true);

      const old = withVersionPublishTime(packument.versions['1.0.0'], '1.0.0', timeMap);
      const oldResult = evaluateConditions(
        { name: 'left-pad', version: '1.0.0' },
        { releaseAgeMaxHours: 24 },
        old
      );
      expect(oldResult.match).toBe(false);
    });

    it('ignores created and modified when choosing the newest release', () => {
      const timeMap = packumentTimeMap(packument);
      expect(latestVersionPublishTime(timeMap)).toBe(packument.time['1.1.0']);
      const { match } = evaluateConditions(
        {
          name: 'left-pad',
          version: '1.0.0',
          packageLastReleaseAt: latestVersionPublishTime(timeMap),
        },
        { releaseAgeMinDays: 30 },
        withVersionPublishTime(packument.versions['1.0.0'], '1.0.0', timeMap)
      );
      expect(match).toBe(false);
    });
  });
});
