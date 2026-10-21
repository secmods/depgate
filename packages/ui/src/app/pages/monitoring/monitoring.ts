import { PolicyConditions } from '../../services/policy.service';
import { MonitorPackage, MonitorStatus } from '../../services/monitor.service';
import { Tone, ecosystemLabel } from '../../shared/status';
import { PolicyRule, cvssScoreText, releaseTypeLabel, ruleDetail, ruleInfo, rulesOf } from '../policies/policy-rules';

/** Longest version text an approval (an exception) can store. */
export const APPROVAL_MAX_LENGTH = 128;
export const DEFAULT_APPROVAL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rule a policy uses, or null for a policy without one. */
export function policyRule(conditions: PolicyConditions | null | undefined): PolicyRule | null {
  return rulesOf(conditions)[0] ?? null;
}

/** "License" / "npm · All except MIT". */
export function ruleSummary(conditions: PolicyConditions | null | undefined): { label: string; detail: string } {
  const c = conditions ?? {};
  const rule = policyRule(c);
  if (!rule) return { label: 'No rule', detail: '' };
  const eco = c.ecosystem?.length ? c.ecosystem.map(ecosystemLabel).join(', ') : 'All ecosystems';
  return { label: ruleInfo(rule).label, detail: `${eco} · ${ruleDetail(rule, c)}` };
}

/** How the report names a reason group: `cve:CVE-1` → CVE-1, `cvss:CVE-1` → CVE-1 (CVSS at or above the minimum). */
export function reasonLabel(reasonKey: string, rule?: PolicyRule | null): string {
  if (reasonKey.startsWith('namespace:')) return `Reserved namespace ${reasonKey.slice(10)}, served from a public remote`;
  if (reasonKey === 'scorecard:overall') return 'Scorecard below the minimum';
  if (reasonKey === 'scorecard:unknown') return 'No Scorecard result';
  if (reasonKey === 'scorecard:unavailable') return 'Scorecard unavailable';
  if (reasonKey.startsWith('scorecard:')) return `Scorecard check ${reasonKey.slice(10)}`;
  if (reasonKey === 'too_new') return 'Too new';
  if (reasonKey === 'unmaintained') return 'Unmaintained';
  if (reasonKey.startsWith('cve:')) return reasonKey.slice(4);
  if (reasonKey === 'epss:unknown') return 'No EPSS score';
  if (reasonKey.startsWith('epss:')) return `${reasonKey.slice(5)} (likely to be exploited)`;
  if (reasonKey === 'cvss:unknown') return 'No CVSS score or severity';
  if (reasonKey.startsWith('cvss:')) return `${reasonKey.slice(5)} (CVSS at or above the minimum)`;
  // Recorded before CVSS replaced the severity threshold.
  if (reasonKey.startsWith('severity:')) {
    const level = reasonKey.slice(9).toLowerCase();
    return level === 'unknown' ? 'Unrated vulnerability' : `${level.charAt(0).toUpperCase()}${level.slice(1)} severity`;
  }
  if (rule === 'license' && reasonKey === 'UNKNOWN') return 'No license information';
  if (rule === 'releaseType') return releaseTypeLabel(reasonKey);
  if (rule === 'packages') return `Package ${reasonKey}`;
  return reasonKey;
}

export function statusView(pkg: Pick<MonitorPackage, 'status' | 'approvedVersions' | 'totalVersions' | 'approvedUntil'>): {
  label: string;
  tone: Tone;
} {
  switch (pkg.status) {
    case 'approved':
      return { label: pkg.approvedUntil ? `Approved until ${shortDate(pkg.approvedUntil)}` : 'Approved', tone: 'success' };
    case 'partly':
      return { label: `Partly approved (${pkg.approvedVersions} of ${pkg.totalVersions} versions)`, tone: 'warning' };
    default:
      return { label: 'Will be blocked', tone: 'danger' };
  }
}

export const STATUS_FILTERS: Array<{ value: MonitorStatus | 'all'; label: string }> = [
  { value: 'will_block', label: 'Will be blocked' },
  { value: 'partly', label: 'Partly approved' },
  { value: 'approved', label: 'Approved' },
  { value: 'all', label: 'All' },
];

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Whole days since a date, never negative. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS));
}

export function plural(count: number, unit: string): string {
  return `${count.toLocaleString()} ${unit}${count === 1 ? '' : 's'}`;
}

// --- Approve ---

export type ApprovalChoice = 'matched' | 'range' | 'all';

/** Which scopes the rule allows, the default, and why Approve is missing for the others. */
export function approvalChoices(rule: PolicyRule | null): { choices: ApprovalChoice[]; preferred: ApprovalChoice } | null {
  switch (rule) {
    case 'packages':
      return { choices: ['matched', 'range', 'all'], preferred: 'matched' };
    case 'license':
      return { choices: ['matched', 'range', 'all'], preferred: 'all' };
    case 'scorecard':
      // The score belongs to the repository, so every version of the package shares it.
      return { choices: ['matched', 'range', 'all'], preferred: 'all' };
    case 'vulnerability':
      // A vulnerability approval names versions, so a future vulnerable release is not let through.
      return { choices: ['matched'], preferred: 'matched' };
    default:
      return null;
  }
}

/** The text one approval stores for a package, as the backend builds it. */
export function approvalText(pkg: Pick<MonitorPackage, 'versions' | 'versionRange'>, choice: ApprovalChoice): string {
  if (choice === 'all') return '*';
  if (choice === 'range') {
    const range = pkg.versionRange;
    if (!range) return '*';
    return range.min === range.max ? `=${range.min}` : `${range.min} - ${range.max}`;
  }
  return pkg.versions.map((v) => `=${v.version}`).join(' || ');
}

/** What the dialog sends for a package. */
export function approvalVersions(pkg: Pick<MonitorPackage, 'versions' | 'versionRange'>, choice: ApprovalChoice): string[] {
  if (choice === 'all') return ['*'];
  if (choice === 'range') {
    const range = pkg.versionRange;
    if (!range) return ['*'];
    return range.min === range.max ? [range.min] : [`${range.min} - ${range.max}`];
  }
  return pkg.versions.map((v) => v.version);
}

/** The listed versions do not fit one approval: more were recorded than the report shows, or the text is too long. */
export function listTooLong(pkg: Pick<MonitorPackage, 'versions' | 'versionCount' | 'versionRange'>): boolean {
  return pkg.versions.length < pkg.versionCount || approvalText(pkg, 'matched').length > APPROVAL_MAX_LENGTH;
}

export function defaultExpiry(now = new Date()): string {
  const at = new Date(now.getTime() + DEFAULT_APPROVAL_DAYS * DAY_MS);
  return at.toISOString().slice(0, 10);
}

// --- Edit rule suggestions (MON-U4) ---

export type RuleSuggestion = { reasonKey: string };

const CVSS_RATING_STARTS = [4, 7, 9];

/** The change "Edit rule" proposes for a reason group, in words. */
export function suggestionText(rule: PolicyRule | null, reasonKey: string, conditions: PolicyConditions): string {
  switch (rule) {
    case 'license':
      if (reasonKey === 'UNKNOWN') {
        return conditions.licenseAllowList?.length
          ? 'Let through packages with no license information'
          : 'Stop banning packages with no license information';
      }
      return conditions.licenseAllowList?.length
        ? `Approve ${licenseIds(reasonKey).join(' or ')}`
        : `Unban ${licenseIds(reasonKey).join(', ')}`;
    case 'vulnerability':
      if (reasonKey.startsWith('cve:')) return `Remove ${reasonKey.slice(4)} from the CVE list`;
      if (reasonKey === 'epss:unknown') return 'Ignore vulnerabilities without an EPSS score';
      if (reasonKey.startsWith('epss:')) return 'Raise the EPSS threshold';
      if (reasonKey === 'cvss:unknown') return 'Ignore vulnerabilities without a CVSS score or severity';
      return raisedCvss(conditions.cvssMin) !== null
        ? `Raise the CVSS minimum to ${cvssScoreText(raisedCvss(conditions.cvssMin)!)}`
        : 'Remove the CVSS minimum';
    case 'releaseType':
      return `Untick ${releaseTypeLabel(reasonKey)}`;
    case 'releaseAge':
      return reasonKey === 'too_new' ? 'Shorten the "too new" window' : 'Lengthen the "unmaintained" window';
    case 'packages':
      return `Narrow the versions or the pattern ${reasonKey}`;
    case 'namespace':
      return reasonKey.startsWith('namespace:')
        ? `Add an internal remote that has these packages, or list them as published publicly on purpose (${reasonKey.slice(10)})`
        : 'Edit the rule';
    case 'scorecard':
      if (reasonKey === 'scorecard:overall') {
        return typeof conditions.scorecardMinScore === 'number' && conditions.scorecardMinScore > 0
          ? `Lower the overall minimum to ${Math.max(0, conditions.scorecardMinScore - 1)}`
          : 'Remove the overall minimum';
      }
      if (reasonKey === 'scorecard:unknown') return 'Let through packages without a Scorecard result';
      if (reasonKey === 'scorecard:unavailable') return "Let packages through when Scorecard can't be reached";
      return reasonKey.startsWith('scorecard:') ? `Remove the ${reasonKey.slice(10)} check` : 'Edit the rule';
    default:
      return 'Edit the rule';
  }
}

/** License IDs in a reason key such as `MIT OR GPL-3.0`. */
export function licenseIds(reasonKey: string): string[] {
  return reasonKey
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+|\s+/i)
    .map((part) => part.trim())
    .filter((part) => part && !/^(OR|AND|WITH)$/i.test(part));
}

/** The next rating boundary above the CVSS minimum (Medium 4.0, High 7.0, Critical 9.0), or null from 9.0 up. */
export function raisedCvss(current: number | undefined): number | null {
  return CVSS_RATING_STARTS.find((start) => start > (current ?? 0)) ?? null;
}
