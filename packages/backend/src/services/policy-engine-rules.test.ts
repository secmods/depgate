import { describe, expect, it, vi } from 'vitest';
import type { FactNeed, VersionFacts } from './package-facts.js';

/** One HIGH advisory that is not in any block list. */
const loadVersionFacts = vi.fn(
  async (_db: unknown, _redis: unknown, _eco: string, _pkg: string, versions: string[], need: FactNeed) => {
    const out = new Map<string, VersionFacts>();
    for (const version of versions) {
      out.set(version, {
        vulns: need.cve ? [{ id: 'GHSA-high', database_specific: { severity: 'HIGH' } }] : [],
        licenseKnown: need.license,
        publishedKnown: need.publishedAt,
        cveKnown: need.cve,
      });
    }
    return out;
  }
);

vi.mock('./package-facts.js', () => ({
  loadVersionFacts: (...args: Parameters<typeof loadVersionFacts>) => loadVersionFacts(...args),
}));

import { evaluatePackageVersions } from './policy-engine.js';

function dbWith(policies: Array<{ id: string; decision: string; conditions: Record<string, unknown> }>) {
  const qb = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
  return {
    getRepository: (entity: { name?: string }) => {
      if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
      if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
      return {
        find: async () => policies.map((p, i) => ({ ...p, name: p.id, priority: i, isEnabled: true })),
      };
    },
  } as never;
}

const fromDb = { policiesFromDatabase: true };

describe('release type rule', () => {
  it('blocks the selected types without loading any facts', async () => {
    loadVersionFacts.mockClear();
    const db = dbWith([{ id: 'no-pre', decision: 'BLOCK', conditions: { releaseTypes: ['prerelease', 'snapshot'] } }]);
    const versions = ['1.0', '31.1-jre', '2.0.0-RC1', '1.0-M1', '1.0-SNAPSHOT'].map((version) => ({ version }));
    const results = await evaluatePackageVersions(db, 'maven', 'com.acme:lib', versions, null, undefined, fromDb);

    expect(results.get('1.0')).toBeNull();
    expect(results.get('31.1-jre')).toBeNull();
    expect(results.get('2.0.0-RC1')?.reasons).toEqual(['Version 2.0.0-RC1 is a pre-release (Maven "rc")']);
    expect(results.get('1.0-M1')?.decision).toBe('BLOCK');
    expect(results.get('1.0-SNAPSHOT')?.reasons).toEqual(['Version 1.0-SNAPSHOT is a snapshot (Maven "SNAPSHOT")']);
    expect(loadVersionFacts).not.toHaveBeenCalled();
  });

  it('keeps types exclusive, so dev releases need their own checkbox', async () => {
    const db = dbWith([{ id: 'no-pre', decision: 'BLOCK', conditions: { releaseTypes: ['prerelease'] } }]);
    const versions = ['2.0.0rc1', '1.0.dev1', '1.0.post1'].map((version) => ({ version }));
    const results = await evaluatePackageVersions(db, 'pypi', 'acme', versions, null, undefined, fromDb);

    expect(results.get('2.0.0rc1')?.decision).toBe('BLOCK');
    expect(results.get('1.0.dev1')).toBeNull();
    expect(results.get('1.0.post1')).toBeNull();
  });
});

describe('vulnerability rule', () => {
  it('matches a listed CVE or the CVSS minimum, either one', async () => {
    const db = dbWith([
      { id: 'cve', decision: 'BLOCK', conditions: { cveBlockList: ['CVE-2099-0001'], cvssMin: 7 } },
    ]);
    const results = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);

    expect(results.get('1.0.0')?.reasons).toEqual(['GHSA-high: HIGH (no CVSS vector, counted as 7.0)']);
  });

  it('does not match when neither the list nor the CVSS minimum is met', async () => {
    const db = dbWith([
      { id: 'cve', decision: 'BLOCK', conditions: { cveBlockList: ['CVE-2099-0001'], cvssMin: 9 } },
    ]);
    const results = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);

    expect(results.get('1.0.0')).toBeNull();
  });
});

describe('release age rule', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const policy = { id: 'age', decision: 'BLOCK', conditions: { releaseAgeMaxHours: 72, releaseAgeMinDays: 365 } };

  it('matches a version that is too new or a package that is unmaintained, either one', async () => {
    const db = dbWith([policy]);
    const fresh = await evaluatePackageVersions(
      db, 'npm', 'fresh', [{ version: '2.0.0', versionMeta: { time: hoursAgo(5) } }], null, hoursAgo(5), fromDb
    );
    expect(fresh.get('2.0.0')?.reasons).toEqual(['Release is newer than 72 hours (unvetted)']);

    const abandoned = await evaluatePackageVersions(
      db, 'npm', 'abandoned', [{ version: '1.0.0', versionMeta: { time: hoursAgo(24 * 800) } }], null, hoursAgo(24 * 800), fromDb
    );
    expect(abandoned.get('1.0.0')?.reasons).toEqual(['Package last release is older than 365 days (unmaintained)']);
  });

  it('allows a version that is neither too new nor in an unmaintained package', async () => {
    const db = dbWith([policy]);
    const results = await evaluatePackageVersions(
      db, 'npm', 'healthy', [{ version: '1.5.0', versionMeta: { time: hoursAgo(24 * 30) } }], null, hoursAgo(24 * 10), fromDb
    );
    expect(results.get('1.5.0')).toBeNull();
  });
});

describe('release age rule without a version date in the listing', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600 * 1000).toISOString();

  it('loads the version date when the package date is known (Composer lists no per-version time)', async () => {
    loadVersionFacts.mockImplementationOnce(async (_db, _redis, _eco, _pkg, versions: string[]) => {
      const out = new Map<string, VersionFacts>();
      for (const version of versions) {
        out.set(version, { vulns: [], publishedAt: hoursAgo(48), licenseKnown: false, publishedKnown: true, cveKnown: false });
      }
      return out;
    });
    const db = dbWith([{ id: 'age', decision: 'BLOCK', conditions: { releaseAgeMaxHours: 720 } }]);
    // The package's newest release is recent, but this version has no date of its own.
    const results = await evaluatePackageVersions(db, 'composer', 'acme/pkg', [{ version: '1.0.0' }], null, hoursAgo(10), fromDb);
    expect(results.get('1.0.0')?.reasons).toEqual(['Release is newer than 720 hours (unvetted)']);
  });
});

describe('license rule', () => {
  function withLicense(license: string | undefined, known = true) {
    loadVersionFacts.mockImplementationOnce(async (_db, _redis, _eco, _pkg, versions: string[]) => {
      const out = new Map<string, VersionFacts>();
      for (const version of versions) out.set(version, { vulns: [], license, licenseKnown: known, publishedKnown: true, cveKnown: false });
      return out;
    });
  }

  it('allow only: blocks an unapproved or unknown license and passes an approved one', async () => {
    const db = dbWith([{ id: 'approved', decision: 'BLOCK', conditions: { licenseAllowList: ['MIT', 'Apache-2.0'] } }]);
    withLicense('GPL-3.0-only');
    const gpl = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(gpl.get('1.0')).toMatchObject({ decision: 'BLOCK', reasons: ['License "GPL-3.0-only" is not in the approved list'] });

    withLicense('MIT OR GPL-3.0-only');
    const dual = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(dual.get('1.0')).toBeNull();

    withLicense(undefined);
    const unknown = await evaluatePackageVersions(db, 'pypi', 'acme', [{ version: '1.0' }], null, undefined, fromDb);
    expect(unknown.get('1.0')?.reasons).toEqual(['License is unknown, and only approved licenses are allowed']);
  });

  it('a block list at higher priority names itself for a banned license', async () => {
    const db = dbWith([
      { id: 'banned', decision: 'BLOCK', conditions: { licenseDenyList: ['AGPL-*'] } },
      { id: 'approved', decision: 'BLOCK', conditions: { licenseAllowList: ['MIT'] } },
    ]);
    withLicense('AGPL-3.0-only');
    const results = await evaluatePackageVersions(db, 'npm', 'acme', [{ version: '1.0.0' }], null, undefined, fromDb);
    expect(results.get('1.0.0')?.policyName).toBe('banned');
  });
});
