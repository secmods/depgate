import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  osvDown: false,
  vulns: new Map<string, Array<{ id: string; database_specific?: Record<string, unknown> }>>(),
  webhooks: 0,
  ledger: 0,
}));

vi.mock('./osv-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./osv-provider.js')>();
  return {
    ...actual,
    queryOSVBatch: vi.fn(async (_redis: unknown, _eco: string, _pkg: string, versions: string[]) => {
      if (state.osvDown) throw new Error('OSV API request failed');
      return new Map(versions.map((version) => [version, state.vulns.get(version) ?? []]));
    }),
  };
});

vi.mock('./repository-resolve.js', () => ({
  resolveRemoteTargets: vi.fn(async (_db: unknown, _eco: string, repo: string) =>
    repo === 'default' ? [{ id: 'r1', url: 'https://user:secret@registry.npmjs.org', timeoutMs: 1000, retryCount: 0 }] : []
  ),
}));

vi.mock('./webhook-service.js', () => ({
  deliverWebhooks: vi.fn(async () => {
    state.webhooks += 1;
  }),
}));

vi.mock('./audit-service.js', () => ({
  logAudit: vi.fn(async () => {
    state.ledger += 1;
  }),
}));

const listing = vi.hoisted(() => ({ list: null as unknown, delayMs: 0 }));
vi.mock('./package-versions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./package-versions.js')>();
  return {
    ...actual,
    listPackageVersions: vi.fn(async () => listing.list),
  };
});

import { recommendVersion, runPackageCheck, PackageCheckError, type CheckedVersion } from './package-check.js';
import { resetReferenceCache } from './reference-cache.js';
import { V4_9_3 } from '../test-support/cvss-vectors.js';

type Rows = {
  policies?: Array<Record<string, unknown>>;
  exceptions?: Array<Record<string, unknown>>;
  malicious?: Record<string, unknown> | null;
  waivers?: Array<Record<string, unknown>>;
};

function fakeDb(rows: Rows) {
  const qb = {
    where: () => qb,
    andWhere: () => qb,
    getMany: async () => rows.exceptions ?? [],
  };
  return {
    getRepository: (entity: { name?: string }) => {
      switch (entity?.name) {
        case 'Exception':
          return { createQueryBuilder: () => qb };
        case 'MaliciousPackage':
          return { findOne: async () => rows.malicious ?? null };
        case 'WaiverRequest':
          return { find: async () => rows.waivers ?? [] };
        default:
          return { find: async () => rows.policies ?? [] };
      }
    },
  } as never;
}

const hour = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function npmList(versions: Record<string, string>, latest?: string) {
  const rows = Object.entries(versions).map(([version, time]) => ({
    version,
    publishedAt: time,
    versionMeta: { time },
  }));
  return { versions: rows, latestTag: latest, packageLastReleaseAt: rows[0]?.publishedAt };
}

function input(overrides: Partial<Parameters<typeof runPackageCheck>[2]> = {}) {
  return { ecosystem: 'npm', package: 'lodash', repository: 'default', versions: [], offset: 0, limit: 10, ...overrides };
}

const redis = null as never;

function byVersion(rows: CheckedVersion[]): Record<string, CheckedVersion> {
  return Object.fromEntries(rows.map((row) => [row.version, row]));
}

beforeEach(() => {
  resetReferenceCache();
  state.osvDown = false;
  state.vulns.clear();
  state.webhooks = 0;
  state.ledger = 0;
  listing.list = npmList({ '4.17.21': iso(400 * 24 * hour), '4.17.20': iso(800 * 24 * hour) }, '4.17.21');
});

describe('runPackageCheck', () => {
  it('recommends the newest allowed version and shows the blocked one with its policy', async () => {
    const db = fakeDb({
      policies: [
        {
          id: 'p1',
          name: 'Block old lodash',
          decision: 'BLOCK',
          priority: 0,
          isEnabled: true,
          conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '=4.17.20' },
        },
      ],
    });
    const result = await runPackageCheck(db, redis, input());
    const rows = byVersion(result.versions);
    expect(rows['4.17.20'].status).toBe('blocked');
    expect(rows['4.17.20'].policyName).toBe('Block old lodash');
    expect(rows['4.17.21'].status).toBe('allowed');
    expect(rows['4.17.21'].isDefault).toBe(true);
    expect(result.recommended?.version).toBe('4.17.21');
    expect(result.checkedAgainst).toEqual(['registry.npmjs.org']);
    expect(JSON.stringify(result)).not.toContain('p1');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('is read-only: a blocked version writes no ledger row or webhook', async () => {
    const db = fakeDb({
      policies: [
        {
          id: 'pb',
          name: 'Block lodash',
          decision: 'BLOCK',
          priority: 0,
          isEnabled: true,
          conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'] },
        },
      ],
    });
    const result = await runPackageCheck(db, redis, input());
    const rows = byVersion(result.versions);
    expect(rows['4.17.21'].status).toBe('blocked');
    expect(rows['4.17.20'].status).toBe('blocked');
    expect(state.ledger).toBe(0);
    expect(state.webhooks).toBe(0);
    expect(result.recommended).toBeNull();
  });

  it('never calls a version allowed when OSV is unreachable', async () => {
    state.osvDown = true;
    const db = fakeDb({
      policies: [
        { id: 'pv', name: 'CVE High', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { cvssMin: 7 } },
      ],
    });
    const result = await runPackageCheck(db, redis, input());
    for (const row of result.versions) {
      expect(row.status).toBe('allowed');
      expect(row.incomplete).toEqual(['cve']);
      expect(row.vulnerabilities).toBeUndefined();
    }
    expect(result.recommended).toBeNull();
  });

  it('lists CVE IDs, CVSS and severity for a version blocked by a vulnerability policy', async () => {
    state.vulns.set('4.17.21', [
      { id: 'GHSA-xxxx', database_specific: { severity: 'HIGH' } },
      { id: 'GHSA-yyyy', aliases: ['CVE-2024-0001'], severity: [{ type: 'CVSS_V4', score: V4_9_3 }] },
    ]);
    const db = fakeDb({
      policies: [
        { id: 'pv', name: 'CVE High', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { cvssMin: 7 } },
      ],
    });
    const result = await runPackageCheck(db, redis, input());
    const rows = byVersion(result.versions);
    expect(rows['4.17.21'].status).toBe('blocked');
    expect(rows['4.17.21'].vulnerabilities).toEqual([
      { id: 'GHSA-xxxx', severity: 'HIGH', cvss: { score: 7, version: null }, cves: [], epss: null },
      { id: 'CVE-2024-0001', severity: 'CRITICAL', cvss: { score: 9.3, version: '4.0' }, cves: ['CVE-2024-0001'], epss: null },
    ]);
    expect(rows['4.17.20'].vulnerabilities).toEqual([]);
    expect(result.recommended?.version).toBe('4.17.20');
  });

  it('shows when a too-new version can be checked again', async () => {
    const published = iso(2 * hour);
    listing.list = npmList({ '19.1.0': published, '19.0.0': iso(90 * 24 * hour) });
    const db = fakeDb({
      policies: [
        { id: 'pa', name: 'Too new', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { releaseAgeMaxHours: 72 } },
      ],
    });
    const result = await runPackageCheck(db, redis, input({ package: 'react' }));
    const rows = byVersion(result.versions);
    expect(rows['19.1.0'].status).toBe('blocked');
    expect(rows['19.1.0'].allowedAfter).toBe(new Date(Date.parse(published) + 72 * hour).toISOString());
    expect(result.recommended?.version).toBe('19.0.0');
  });

  it('reports exceptions, pending waivers, and pinned requested versions', async () => {
    const expiresAt = new Date(Date.now() + 24 * hour);
    const db = fakeDb({
      policies: [
        { id: 'pb', name: 'Block lodash', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { packageBlockList: ['lodash'] } },
      ],
      exceptions: [{ version: '4.17.21', expiresAt }],
      waivers: [{ version: '4.17.20', status: 'pending' }],
    });
    const result = await runPackageCheck(db, redis, input({ versions: ['4.17.20'], userId: 'u1' }));
    const rows = byVersion(result.versions);
    expect(rows['4.17.21'].status).toBe('allowed');
    expect(rows['4.17.21'].policyName).toBe('Exception');
    expect(rows['4.17.21'].exception).toEqual({ expiresAt: expiresAt.toISOString() });
    expect(rows['4.17.20'].waiverPending).toBe(true);
    expect(rows['4.17.20'].requested).toBe(true);
    expect(rows['4.17.21'].position).toBe(0);
    expect(rows['4.17.20'].position).toBe(1);
  });

  it('shows the license of the version asked for, as the license policies read it', async () => {
    listing.list = {
      versions: [
        { version: '2.0.0', publishedAt: iso(hour), versionMeta: { license: 'MIT OR Apache-2.0' } },
        { version: '1.0.0', publishedAt: iso(2 * hour), versionMeta: { license: { type: 'MIT' } } },
        { version: '0.1.0', publishedAt: iso(3 * hour), versionMeta: { license: 'SEE LICENSE IN LICENSE.md' } },
      ],
    };
    const result = await runPackageCheck(fakeDb({}), redis, input({ versions: ['2.0.0', '1.0.0', '0.1.0'] }));
    const rows = byVersion(result.versions);
    expect(rows['2.0.0'].license).toBe('MIT OR Apache-2.0');
    expect(rows['1.0.0'].license).toBe('MIT');
    expect(rows['0.1.0'].license).toBeNull();

    const unasked = await runPackageCheck(fakeDb({}), redis, input());
    expect(unasked.versions.every((row) => !('license' in row))).toBe(true);
  });

  it("shows the recommended version's license, which can differ from the version asked for", async () => {
    listing.list = {
      versions: [
        { version: '2.0.0', publishedAt: iso(hour), versionMeta: { license: 'BUSL-1.1' } },
        { version: '1.0.0', publishedAt: iso(2 * hour), versionMeta: { license: 'MIT' } },
      ],
    };
    const asked = await runPackageCheck(fakeDb({}), redis, input({ versions: ['1.0.0'] }));
    expect(asked.recommended).toMatchObject({ version: '2.0.0', license: 'BUSL-1.1' });
    expect(byVersion(asked.versions)['1.0.0'].license).toBe('MIT');

    const unasked = await runPackageCheck(fakeDb({}), redis, input());
    expect(unasked.recommended).toMatchObject({ version: '2.0.0', license: 'BUSL-1.1' });

    listing.list = { versions: [{ version: '2.0.0', publishedAt: iso(hour), versionMeta: {} }] };
    const undeclared = await runPackageCheck(fakeDb({}), redis, input({ versions: ['2.0.0'] }));
    expect(undeclared.recommended).toMatchObject({ version: '2.0.0', license: null });
  });

  it('names a policy that blocks the whole package', async () => {
    const db = fakeDb({
      policies: [
        { id: 'pb', name: 'No lodash', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { packageBlockList: ['lodash'] } },
      ],
    });
    const result = await runPackageCheck(db, redis, input());
    expect(result.packageNotice).toEqual(expect.objectContaining({ kind: 'policy', policyName: 'No lodash' }));
    expect(result.recommended).toBeNull();
  });

  it('shows the malware banner and recommends nothing for a listed package', async () => {
    const db = fakeDb({ malicious: { name: 'lodash', ecosystem: 'npm', overrideStatus: 'BLOCK', versionRange: null, reason: 'Malware' } });
    const result = await runPackageCheck(db, redis, input());
    expect(result.packageNotice?.kind).toBe('malware');
    expect(result.versions.every((row) => row.status === 'blocked' && row.malicious)).toBe(true);
    expect(result.recommended).toBeNull();
  });

  it('returns what it has after the deadline instead of failing', async () => {
    state.osvDown = false;
    const db = fakeDb({
      policies: [
        { id: 'pv', name: 'CVE High', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { cvssMin: 7 } },
      ],
    });
    const osv = await import('./osv-provider.js');
    vi.mocked(osv.queryOSVBatch).mockImplementationOnce(() => new Promise(() => undefined));
    const result = await runPackageCheck(db, redis, input(), 20);
    expect(result.versions.every((row) => row.status === 'unknown' && row.incomplete?.[0] === 'timeout')).toBe(true);
    expect(result.recommended).toBeNull();
  });

  it('rejects a repository that does not exist', async () => {
    await expect(runPackageCheck(fakeDb({}), redis, input({ repository: 'nope' }))).rejects.toMatchObject({ status: 400 });
  });

  it('returns 404 for a package no member lists, and 502 when the upstream fails', async () => {
    listing.list = null;
    await expect(runPackageCheck(fakeDb({}), redis, input())).rejects.toMatchObject({ status: 404 });
    const versions = await import('./package-versions.js');
    vi.mocked(versions.listPackageVersions).mockRejectedValueOnce(new Error('Upstream returned 503'));
    const failure = await runPackageCheck(fakeDb({}), redis, input()).catch((err: PackageCheckError) => err);
    expect(failure).toBeInstanceOf(PackageCheckError);
    expect((failure as PackageCheckError).status).toBe(502);
    expect((failure as PackageCheckError).message).toContain('registry.npmjs.org');
  });
});

describe('recommendVersion', () => {
  const row = (version: string, extra: Partial<CheckedVersion> = {}): CheckedVersion => ({
    version,
    position: 0,
    status: 'allowed',
    reasons: [],
    releaseType: 'stable',
    ...extra,
  });

  it('prefers the newest stable allowed version over a newer pre-release', () => {
    expect(recommendVersion([row('2.0.0-rc.1', { releaseType: 'prerelease' }), row('1.9.0')])?.version).toBe('1.9.0');
  });

  it('falls back to the newest allowed version of any type', () => {
    const rows = [row('2.0.0-rc.1', { releaseType: 'prerelease' }), row('1.9.0', { status: 'blocked' })];
    expect(recommendVersion(rows)?.version).toBe('2.0.0-rc.1');
  });

  it('skips versions whose data was incomplete', () => {
    expect(recommendVersion([row('2.0.0', { incomplete: ['cve'] }), row('1.9.0')])?.version).toBe('1.9.0');
    expect(recommendVersion([row('2.0.0', { incomplete: ['cve'] })])).toBeNull();
  });

  it('returns nothing when nothing is allowed', () => {
    expect(recommendVersion([row('1.0.0', { status: 'blocked' }), row('0.9.0', { status: 'unknown' })])).toBeNull();
  });
});
