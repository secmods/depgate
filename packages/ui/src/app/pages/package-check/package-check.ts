import type { CheckedVersion, IncompleteReason, ProjectHealth, ReleaseType } from '../../services/package-check.service';
import type { Tone } from '../../shared/status';

/** Go module paths reach the gateway case-encoded (`!b` for `B`); people type and install them decoded. */
export function displayPackageName(ecosystem: string, name: string): string {
  return ecosystem === 'go' ? name.replace(/!([a-z])/g, (_, letter: string) => letter.toUpperCase()) : name;
}

/** What to paste to install exactly this version. */
export function installCommand(ecosystem: string, name: string, version: string): string {
  const pkg = displayPackageName(ecosystem, name);
  switch (ecosystem) {
    case 'npm':
      return `npm install ${pkg}@${version}`;
    case 'pypi':
      return `pip install ${pkg}==${version}`;
    case 'go':
      return `go get ${pkg}@${version}`;
    case 'maven': {
      const [groupId, artifactId] = pkg.split(':');
      return [
        '<dependency>',
        `  <groupId>${groupId}</groupId>`,
        `  <artifactId>${artifactId}</artifactId>`,
        `  <version>${version}</version>`,
        '</dependency>',
      ].join('\n');
    }
    case 'nuget':
      return `dotnet add package ${pkg} --version ${version}`;
    case 'cargo':
      return `cargo add ${pkg}@${version}`;
    case 'composer':
      return `composer require ${pkg}:${version}`;
    case 'rubygems':
      return `gem install ${pkg} -v ${version}`;
    default:
      return `${pkg}@${version}`;
  }
}

export const NAME_PLACEHOLDERS: Record<string, string> = {
  npm: 'e.g. lodash or @angular/core',
  pypi: 'e.g. requests',
  go: 'e.g. golang.org/x/net',
  maven: 'e.g. org.slf4j:slf4j-api',
  nuget: 'e.g. Newtonsoft.Json',
  cargo: 'e.g. serde',
  composer: 'e.g. monolog/monolog',
  rubygems: 'e.g. rails',
};

const INCOMPLETE_LABELS: Record<IncompleteReason, string> = {
  cve: 'vulnerability data unavailable',
  license: 'license data unavailable',
  published: 'release date unavailable',
  scorecard: 'Scorecard unavailable',
  timeout: 'timed out',
};

const HEALTH_REASONS: Record<string, string> = {
  'no-repository': 'the package declares no source repository',
  'unsupported-host': 'the repository is not on GitHub or GitLab',
  'not-scanned': 'Scorecard has not scanned the repository',
  'internal-remote': 'this repository has an internal remote',
  'private-name': 'the name is in an internal namespace',
};

/** One line for the Project health panel when there is no score to show. */
export function projectHealthMessage(health: Pick<ProjectHealth, 'status' | 'reason'>): string {
  const why = health.reason ? HEALTH_REASONS[health.reason] ?? health.reason : '';
  switch (health.status) {
    case 'not-applicable':
      return `Not checked: ${why}.`;
    case 'unknown':
      return why ? `No Scorecard result: ${why}.` : 'No Scorecard result.';
    case 'unavailable':
      return 'Scorecard could not be reached.';
    case 'disabled':
      return 'Scorecard lookups are turned off (SCORECARD_ENABLED=false).';
    default:
      return '';
  }
}

/** `CVSS 4.0 9.3`, or the advisory's severity (`HIGH`) when it publishes no CVSS vector. */
export function cvssLabel(vuln: { severity: string; cvss?: { score: number; version: string | null } | null }): string {
  if (!vuln.cvss?.version) return vuln.severity;
  return `CVSS ${vuln.cvss.version} ${vuln.cvss.score === 10 ? '10' : vuln.cvss.score.toFixed(1)}`;
}

/** `42.1 % · 97th`, or `—` when the vulnerability has no EPSS score. */
export function epssLabel(epss: { score: number; percentile: number } | null | undefined): string {
  if (!epss) return '—';
  const p = epss.score * 100;
  const score = (p >= 1 ? p.toFixed(1) : p.toFixed(2)).replace(/\.?0+$/, '') || '0';
  const n = Math.floor(epss.percentile * 100);
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${score} % · ${n}${suffix}`;
}

/** Tone of a 0–10 score: low is danger, middling warning, high success; -1 is inconclusive. */
export function scoreTone(score: number): Tone {
  if (score < 0) return 'neutral';
  if (score < 4) return 'danger';
  if (score < 7) return 'warning';
  return 'success';
}

export function incompleteLabel(reasons: IncompleteReason[] | undefined): string {
  return (reasons ?? []).map((reason) => INCOMPLETE_LABELS[reason] ?? reason).join(', ');
}

/** `would be blocked by "License policy" (monitoring)`: a monitor-mode policy matches this allowed version. */
export function monitoringLabel(row: Pick<CheckedVersion, 'monitoring'>): string {
  const names = (row.monitoring ?? []).map((match) => `"${match.policyName}"`);
  if (names.length === 0) return '';
  const more = names.length > 1 ? ` and ${names.length - 1} more` : '';
  return `would be blocked by ${names[0]}${more} (monitoring)`;
}

/** Status pill text and tone. An allow on missing data never reads as a plain "Allowed". */
export function statusView(row: CheckedVersion): { label: string; tone: Tone } {
  switch (row.status) {
    case 'allowed':
      if (row.incomplete?.length) return { label: `Allowed · ${incompleteLabel(row.incomplete)}`, tone: 'warning' };
      if (row.exception) return { label: 'Allowed · exception', tone: 'success' };
      if (row.monitoring?.length) return { label: `Allowed · ${monitoringLabel(row)}`, tone: 'info' };
      return { label: 'Allowed', tone: 'success' };
    case 'blocked':
      return { label: row.malicious ? 'Blocked · malware' : 'Blocked', tone: 'danger' };
    default:
      return { label: 'Not checked · timed out', tone: 'neutral' };
  }
}

const RELEASE_LABELS: Record<ReleaseType, string> = {
  stable: 'Stable',
  prerelease: 'Pre-release',
  dev: 'Dev',
  snapshot: 'Snapshot',
  pseudo: 'Pseudo-version',
  unknown: 'Unknown',
};

export function releaseTypeLabel(type: ReleaseType): string {
  return RELEASE_LABELS[type] ?? type;
}

/** Rows a waiver or exception can unblock. Malware is overridden only in Malware Packages. */
export function isUnblockable(row: CheckedVersion): boolean {
  return !row.malicious && row.status === 'blocked';
}

export type RowFilters = { allowedOnly: boolean; hidePrerelease: boolean; search: string };

/**
 * The version table: the checked window in registry order, newest first, after the toolbar
 * filters. A version outside the window that was only checked because someone asked for it
 * is shown in its own panel instead.
 */
export function visibleRows(rows: CheckedVersion[], filters: RowFilters, windowEnd: number): CheckedVersion[] {
  const term = filters.search.trim().toLowerCase();
  return rows
    .filter((row) => {
      if (row.position < 0 || row.position >= windowEnd) return false;
      if (filters.allowedOnly && row.status !== 'allowed') return false;
      if (filters.hidePrerelease && row.releaseType !== 'stable') return false;
      if (term && !row.version.toLowerCase().includes(term)) return false;
      return true;
    })
    .sort((a, b) => a.position - b.position);
}

/** Panel tone for the version someone asked about. */
export function panelTone(row: CheckedVersion): 'success' | 'danger' | 'warning' | 'neutral' {
  const tone = statusView(row).tone;
  return tone === 'info' ? 'neutral' : tone;
}

/**
 * Rows from a later page replace the same version from earlier pages, keeping what only the
 * first page knows (that it was asked for) and what the user did since (a waiver request).
 */
export function mergeRows(current: CheckedVersion[], page: CheckedVersion[]): CheckedVersion[] {
  const byVersion = new Map(current.map((row) => [row.version, row]));
  for (const row of page) {
    const previous = byVersion.get(row.version);
    byVersion.set(
      row.version,
      previous ? { ...row, requested: previous.requested, waiverPending: previous.waiverPending || row.waiverPending } : row
    );
  }
  return [...byVersion.values()].sort((a, b) => a.position - b.position);
}

export function osvUrl(id: string): string {
  return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
}

export type RecentCheck = { ecosystem: string; package: string; repository: string };

const RECENT_KEY = 'depgate_recent_package_checks';
const RECENT_MAX = 5;

/** Local, best effort: a private window or blocked storage just shows no chips. */
export function readRecentChecks(): RecentCheck[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentCheck =>
          !!item && typeof item.ecosystem === 'string' && typeof item.package === 'string' && typeof item.repository === 'string'
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** "Sep 29, 00:51", with the year when it is not this year. */
export function recheckAfterLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const withYear = date.getFullYear() !== now.getFullYear();
  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(date);
  const timePart = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${datePart}, ${timePart}`;
}

export function rememberCheck(check: RecentCheck): RecentCheck[] {
  const next = [
    check,
    ...readRecentChecks().filter(
      (item) => !(item.ecosystem === check.ecosystem && item.package === check.package && item.repository === check.repository)
    ),
  ].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}
