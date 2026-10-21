import { describe, expect, it } from 'vitest';
import {
  approvalChoices,
  approvalText,
  approvalVersions,
  daysSince,
  licenseIds,
  listTooLong,
  reasonLabel,
  statusView,
  suggestionText,
} from './monitoring';
import type { MonitorPackage } from '../../services/monitor.service';

function pkg(versions: string[], extra: Partial<MonitorPackage> = {}): MonitorPackage {
  return {
    ecosystem: 'npm',
    packageName: 'acme',
    versionCount: versions.length,
    versionRange: versions.length ? { min: versions[versions.length - 1], max: versions[0] } : null,
    reasonKey: 'GPL-3.0',
    reasonKeys: ['GPL-3.0'],
    reasons: [],
    downloads: 1,
    firstSeenAt: null,
    lastSeenAt: null,
    status: 'will_block',
    approvedVersions: 0,
    totalVersions: versions.length,
    approvedUntil: null,
    alsoMatchedBy: [],
    versions: versions.map((version) => ({
      version, reasonKey: 'GPL-3.0', reasons: [], downloads: 1, firstSeenAt: null, lastSeenAt: null, approved: false, approvedUntil: null,
    })),
    ...extra,
  };
}

describe('reasonLabel', () => {
  it('names each kind of reason key', () => {
    expect(reasonLabel('too_new', 'releaseAge')).toBe('Too new');
    expect(reasonLabel('unmaintained', 'releaseAge')).toBe('Unmaintained');
    expect(reasonLabel('cve:CVE-2024-1', 'vulnerability')).toBe('CVE-2024-1');
    expect(reasonLabel('cvss:CVE-2024-1', 'vulnerability')).toBe('CVE-2024-1 (CVSS at or above the minimum)');
    expect(reasonLabel('cvss:unknown', 'vulnerability')).toBe('No CVSS score or severity');
    expect(reasonLabel('severity:HIGH', 'vulnerability')).toBe('High severity');
    expect(reasonLabel('UNKNOWN', 'license')).toBe('No license information');
    expect(reasonLabel('MIT OR GPL-3.0', 'license')).toBe('MIT OR GPL-3.0');
    expect(reasonLabel('prerelease', 'releaseType')).toBe('Pre-release');
    expect(reasonLabel('left-*', 'packages')).toBe('Package left-*');
  });
});

describe('statusView', () => {
  it('reads Will be blocked, Partly approved (n of m) or Approved until', () => {
    expect(statusView(pkg(['1.0.0']))).toEqual({ label: 'Will be blocked', tone: 'danger' });
    expect(statusView({ status: 'partly', approvedVersions: 2, totalVersions: 5, approvedUntil: null }).label).toBe(
      'Partly approved (2 of 5 versions)'
    );
    expect(statusView({ status: 'approved', approvedVersions: 1, totalVersions: 1, approvedUntil: '2027-01-05T12:00:00Z' }).label).toMatch(
      /^Approved until /
    );
  });
});

describe('approvals', () => {
  it('is offered for Packages, License and Vulnerability only', () => {
    expect(approvalChoices('packages')).toEqual({ choices: ['matched', 'range', 'all'], preferred: 'matched' });
    expect(approvalChoices('license')?.preferred).toBe('all');
    expect(approvalChoices('vulnerability')).toEqual({ choices: ['matched'], preferred: 'matched' });
    expect(approvalChoices('releaseAge')).toBeNull();
    expect(approvalChoices('releaseType')).toBeNull();
  });

  it('builds one record per package', () => {
    const p = pkg(['1.2.0', '1.1.0', '1.0.0']);
    expect(approvalText(p, 'matched')).toBe('=1.2.0 || =1.1.0 || =1.0.0');
    expect(approvalText(p, 'range')).toBe('1.0.0 - 1.2.0');
    expect(approvalText(p, 'all')).toBe('*');
    expect(approvalVersions(p, 'range')).toEqual(['1.0.0 - 1.2.0']);
    expect(approvalVersions(p, 'all')).toEqual(['*']);
  });

  it('flags a version list longer than one approval holds', () => {
    expect(listTooLong(pkg(['1.0.0']))).toBe(false);
    expect(listTooLong(pkg(Array.from({ length: 20 }, (_, i) => `1.${i}.0`)))).toBe(true);
    // More versions recorded than the report lists inline.
    expect(listTooLong({ ...pkg(['1.0.0']), versionCount: 150 })).toBe(true);
  });
});

describe('edit rule suggestions', () => {
  it('says what changes', () => {
    expect(suggestionText('license', 'GPL-3.0', { licenseAllowList: ['MIT'] })).toBe('Approve GPL-3.0');
    expect(suggestionText('license', 'GPL-3.0', { licenseDenyList: ['GPL-3.0'] })).toBe('Unban GPL-3.0');
    expect(suggestionText('vulnerability', 'cve:CVE-1', {})).toBe('Remove CVE-1 from the CVE list');
    expect(suggestionText('vulnerability', 'cvss:CVE-1', { cvssMin: 6.5 })).toBe('Raise the CVSS minimum to 7.0');
    expect(suggestionText('vulnerability', 'severity:HIGH', { cvssMin: 7 })).toBe('Raise the CVSS minimum to 9.0');
    expect(suggestionText('vulnerability', 'cvss:CVE-1', { cvssMin: 9.5 })).toBe('Remove the CVSS minimum');
    expect(suggestionText('vulnerability', 'cvss:unknown', { cvssMin: 7 })).toBe('Ignore vulnerabilities without a CVSS score or severity');
    expect(suggestionText('releaseType', 'snapshot', {})).toBe('Untick Snapshot');
    expect(suggestionText('releaseAge', 'too_new', {})).toBe('Shorten the "too new" window');
  });

  it('reads license IDs out of an expression', () => {
    expect(licenseIds('(MIT OR GPL-3.0) AND BSD-2-Clause')).toEqual(['MIT', 'GPL-3.0', 'BSD-2-Clause']);
  });
});

describe('daysSince', () => {
  it('counts whole days', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(daysSince('2026-10-02T11:00:00Z', now)).toBe(7);
    expect(daysSince(null, now)).toBe(0);
  });
});

describe('internal namespace reason groups', () => {
  it('names the reserved pattern and suggests a fix', async () => {
    const { reasonLabel, suggestionText } = await import('./monitoring');
    expect(reasonLabel('namespace:@acme', 'namespace')).toBe('Reserved namespace @acme, served from a public remote');
    expect(suggestionText('namespace', 'namespace:@acme', {})).toContain('Add an internal remote');
  });
});


describe('EPSS reason groups', () => {
  it('names the CVE that drove the match, and unscored ones', () => {
    expect(reasonLabel('epss:CVE-2024-1234', 'vulnerability')).toBe('CVE-2024-1234 (likely to be exploited)');
    expect(reasonLabel('epss:unknown', 'vulnerability')).toBe('No EPSS score');
    expect(suggestionText('vulnerability', 'epss:CVE-2024-1234', { epssMin: 0.1 })).toBe('Raise the EPSS threshold');
    expect(suggestionText('vulnerability', 'epss:unknown', { epssMin: 0.1 })).toBe('Ignore vulnerabilities without an EPSS score');
  });
});

describe('project health (Scorecard) reason groups', () => {
  it('names each reason key', () => {
    expect(reasonLabel('scorecard:overall', 'scorecard')).toBe('Scorecard below the minimum');
    expect(reasonLabel('scorecard:Dangerous-Workflow', 'scorecard')).toBe('Scorecard check Dangerous-Workflow');
    expect(reasonLabel('scorecard:unknown', 'scorecard')).toBe('No Scorecard result');
    expect(reasonLabel('scorecard:unavailable', 'scorecard')).toBe('Scorecard unavailable');
  });

  it('suggests a narrower rule for each group', () => {
    expect(suggestionText('scorecard', 'scorecard:overall', { scorecardMinScore: 5 })).toBe('Lower the overall minimum to 4');
    expect(suggestionText('scorecard', 'scorecard:overall', { scorecardMinScore: 0 })).toBe('Remove the overall minimum');
    expect(suggestionText('scorecard', 'scorecard:Maintained', {})).toBe('Remove the Maintained check');
    expect(suggestionText('scorecard', 'scorecard:unknown', {})).toBe('Let through packages without a Scorecard result');
  });

  it('approves the whole package by default, since every version shares the score', () => {
    expect(approvalChoices('scorecard')).toEqual({ choices: ['matched', 'range', 'all'], preferred: 'all' });
  });
});
