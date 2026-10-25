import { PolicyConditions } from '../../services/policy.service';
import { ecosystemLabel } from '../../shared/status';

/** A policy has an ecosystem scope and exactly one rule. The backend applies the same model. */
export type PolicyRule = 'packages' | 'releaseType' | 'releaseAge' | 'vulnerability' | 'license' | 'namespace' | 'scorecard';

export interface PolicyRuleInfo {
  id: PolicyRule;
  label: string;
  description: string;
  icon: string;
}

export const POLICY_RULES: PolicyRuleInfo[] = [
  { id: 'packages', label: 'Packages', description: 'Named packages and versions', icon: 'inventory_2' },
  { id: 'releaseType', label: 'Release type', description: 'Pre-release, dev, snapshot, pseudo', icon: 'science' },
  { id: 'releaseAge', label: 'Release age', description: 'Too new or unmaintained', icon: 'schedule' },
  { id: 'vulnerability', label: 'Vulnerability', description: 'CVE, CVSS or EPSS', icon: 'gpp_maybe' },
  { id: 'license', label: 'License', description: 'Allow list or deny list', icon: 'gavel' },
  { id: 'namespace', label: 'Namespace protection', description: 'Your names, trusted remotes only', icon: 'domain' },
  { id: 'scorecard', label: 'Project health', description: 'OpenSSF Scorecard of the source repo', icon: 'health_and_safety' },
];

export type PolicyDecision = 'ALLOW' | 'BLOCK';

/**
 * Actions each rule offers. Allow is only for Packages: the other rules cover every package
 * in the ecosystem, so an Allow there would skip every lower-priority policy for all of them.
 * The backend enforces the same table.
 */
export const RULE_DECISIONS: Record<PolicyRule, PolicyDecision[]> = {
  packages: ['ALLOW', 'BLOCK'],
  releaseType: ['BLOCK'],
  releaseAge: ['BLOCK'],
  vulnerability: ['BLOCK'],
  license: ['BLOCK'],
  namespace: ['BLOCK'],
  scorecard: ['BLOCK'],
};

export function ruleInfo(rule: PolicyRule): PolicyRuleInfo {
  return POLICY_RULES.find((item) => item.id === rule) ?? POLICY_RULES[0];
}

function filled(list: unknown): boolean {
  return Array.isArray(list) && list.some((item) => String(item ?? '').trim() !== '');
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

/** The rules stored conditions use, in display order. Policies saved before single-rule policies may have several. */
export function rulesOf(conditions: PolicyConditions | null | undefined): PolicyRule[] {
  const c = conditions ?? {};
  const rules: PolicyRule[] = [];
  if (filled(c.packageBlockList) || (typeof c.versionRange === 'string' && c.versionRange.trim())) rules.push('packages');
  if (filled(c.releaseTypes)) rules.push('releaseType');
  if (positive(c.releaseAgeMinDays) || positive(c.releaseAgeMaxHours)) rules.push('releaseAge');
  if (filled(c.cveBlockList) || typeof c.cvssMin === 'number' || typeof c.epssMin === 'number' || typeof c.epssPercentileMin === 'number') {
    rules.push('vulnerability');
  }
  if (filled(c.licenseDenyList) || filled(c.licenseAllowList)) rules.push('license');
  if (filled(c.reservedNamespaces)) rules.push('namespace');
  if (typeof c.scorecardMinScore === 'number' || (Array.isArray(c.scorecardChecks) && c.scorecardChecks.length > 0)) rules.push('scorecard');
  return rules;
}

// --- Project health (OpenSSF Scorecard) ---

/** The checks a policy may set a minimum for; the backend keeps the same list (scorecard-checks.ts). */
export const SCORECARD_CHECKS: Array<{ name: string; description: string }> = [
  { name: 'Binary-Artifacts', description: 'The repository has no checked-in binaries' },
  { name: 'Branch-Protection', description: 'The default branch is protected against force pushes and unreviewed changes' },
  { name: 'CI-Tests', description: 'Tests run in CI before pull requests are merged' },
  { name: 'CII-Best-Practices', description: 'The project has an OpenSSF Best Practices badge' },
  { name: 'Code-Review', description: 'Changes are reviewed before they are merged' },
  { name: 'Contributors', description: 'Contributors come from several organizations' },
  { name: 'Dangerous-Workflow', description: 'CI workflows have no dangerous patterns such as untrusted code checkout' },
  { name: 'Dependency-Update-Tool', description: 'A tool such as Dependabot or Renovate keeps dependencies up to date' },
  { name: 'Fuzzing', description: 'The project is fuzzed, for example by OSS-Fuzz' },
  { name: 'License', description: 'The repository declares a license' },
  { name: 'Maintained', description: 'The project had commits or issue activity in the last 90 days' },
  { name: 'Packaging', description: 'Releases are published by a CI packaging workflow' },
  { name: 'Pinned-Dependencies', description: 'Build and CI dependencies are pinned by hash' },
  { name: 'SAST', description: 'Static analysis runs on changes' },
  { name: 'Security-Policy', description: 'The project has a security policy (SECURITY.md)' },
  { name: 'Signed-Releases', description: 'Releases are cryptographically signed' },
  { name: 'Token-Permissions', description: 'CI workflow tokens have least-privilege permissions' },
  { name: 'Vulnerabilities', description: 'The project has no open, unfixed vulnerabilities' },
];

export function scorecardCheckDescription(name: string): string {
  return SCORECARD_CHECKS.find((check) => check.name === name)?.description ?? '';
}

/** `5.0`, `4.5`, `10`. */
export function formatScore(value: number): string {
  return Number.isInteger(value) && value !== 10 ? value.toFixed(1) : String(value);
}

/** Hosts the backend treats as public whatever the remote's source says (deps-dev.ts PUBLIC_HOSTS). */
const PUBLIC_REGISTRY_HOSTS = new Set([
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'repo1.maven.org', 'repo.maven.apache.org',
  'maven.google.com', 'dl.google.com', 'repo.jenkins-ci.org', 'plugins.gradle.org', 'api.nuget.org', 'crates.io',
  'index.crates.io', 'static.crates.io', 'rubygems.org', 'index.rubygems.org',
]);

type RepositoryLike = { ecosystem: string; key: string; type: string; source?: string | null; upstreamUrl: string | null; memberKeys?: string[]; isEnabled?: boolean };

function remoteIsPublic(row: RepositoryLike): boolean {
  if (row.source !== 'internal') return true;
  if (row.ecosystem === 'composer' || !row.upstreamUrl) return false;
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(row.upstreamUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Whether the Project health rule applies through this repository (requirements_scorecard.md §5.1):
 * every remote behind it is public or on a known public registry host.
 */
export function repositoryIsPublic(row: RepositoryLike, all: RepositoryLike[]): boolean {
  if (row.type === 'remote') return remoteIsPublic(row);
  const remotes = all.filter((r) => r.ecosystem === row.ecosystem && r.type === 'remote' && r.isEnabled !== false);
  const members = row.key === 'all' ? remotes : remotes.filter((r) => (row.memberKeys ?? []).includes(r.key));
  return members.length > 0 && members.every(remoteIsPublic);
}

/** "Scorecard below 5.0 or Dangerous-Workflow below 10". */
export function scorecardDetail(c: PolicyConditions): string {
  const parts: string[] = [];
  if (typeof c.scorecardMinScore === 'number') parts.push(`Scorecard below ${formatScore(c.scorecardMinScore)}`);
  for (const check of c.scorecardChecks ?? []) parts.push(`${check.name} below ${formatScore(check.minScore)}`);
  return parts.join(' or ');
}

// --- Release types ---

export type ReleaseTypeId = 'prerelease' | 'dev' | 'snapshot' | 'pseudo';

export interface ReleaseTypeInfo {
  id: ReleaseTypeId;
  label: string;
  description: string;
  /** Ecosystems where the type occurs; null means every ecosystem. */
  appliesTo: string[] | null;
  /** Example versions per ecosystem; `''` holds the examples shown for every ecosystem. */
  examples: Record<string, string[]>;
}

export const RELEASE_TYPES: ReleaseTypeInfo[] = [
  {
    id: 'prerelease',
    label: 'Pre-release',
    description: 'Alpha, beta, RC, preview.',
    appliesTo: null,
    examples: {
      '': ['1.2.3-rc.1', '2.0.0rc1', '2.0.0-RC1', '7.1.0.beta1'],
      npm: ['1.2.3-rc.1', '2.0.0-beta.2', '19.0.0-canary-5d29478'],
      pypi: ['2.0.0rc1', '1.0a1', '1.0b2'],
      go: ['v1.2.0-rc.1', 'v2.0.0-beta.1'],
      maven: ['2.0.0-RC1', '1.0-M1', '6.0.0.CR2', '1.0-beta-2'],
      nuget: ['1.0.0-beta1', '8.0.0-preview.1.23110.8'],
      cargo: ['1.0.0-alpha.1', '2.0.0-rc.1'],
      composer: ['1.0.0-beta1', '2.0.0-RC1'],
      rubygems: ['1.0.0.pre', '7.1.0.beta1', '1.0.0.rc1'],
    },
  },
  {
    id: 'dev',
    label: 'Dev release',
    description: 'Dev builds and branch heads.',
    appliesTo: ['pypi', 'composer'],
    examples: {
      '': ['1.0.dev1', 'dev-main', '1.0.x-dev'],
      pypi: ['1.0.dev1', '1.0a1.dev1'],
      composer: ['dev-main', '1.0.x-dev'],
    },
  },
  {
    id: 'snapshot',
    label: 'Snapshot',
    description: 'Maven builds that can be replaced.',
    appliesTo: ['maven'],
    examples: {
      '': ['1.0-SNAPSHOT', '1.0-20240101.123456-1'],
      maven: ['1.0-SNAPSHOT', '1.0-20240101.123456-1'],
    },
  },
  {
    id: 'pseudo',
    label: 'Pseudo-version',
    description: 'Go versions for an untagged commit.',
    appliesTo: ['go'],
    examples: {
      '': ['v0.0.0-20240101120000-abcdef123456'],
      go: ['v0.0.0-20240101120000-abcdef123456', 'v1.2.4-0.20240101120000-abcdef123456'],
    },
  },
];

/** Versions that stay allowed under a release type rule, per ecosystem. */
export const STABLE_EXAMPLES: Record<string, string[]> = {
  '': ['1.2.3', '1.0.post1', '31.1-jre', '1.2.3.Final'],
  npm: ['1.2.3', '1.0.0+build.5'],
  pypi: ['1.0', '1.0.post1', '2.1.0+cu118'],
  go: ['v1.2.3', 'v2.0.0+incompatible'],
  maven: ['31.1-jre', '1.2.3.Final', '5.3.30.RELEASE', '2.0-SP1'],
  nuget: ['1.0.0', '1.0.0.1'],
  cargo: ['1.2.3', '1.0.0+build.5'],
  composer: ['v1.2.3', '1.0.0-p1'],
  rubygems: ['1.15.0', '7.1.0'],
};

/** How each ecosystem decides a version's release type, for the reference table. */
export const RELEASE_TYPE_RULES: Array<{ ecosystem: string; rule: string }> = [
  { ecosystem: 'npm', rule: 'SemVer: anything after "-" is a pre-release; "+build" is ignored.' },
  { ecosystem: 'cargo', rule: 'SemVer: anything after "-" is a pre-release; "+build" is ignored.' },
  { ecosystem: 'nuget', rule: 'A release label after "-" is a pre-release; a fourth number is a stable revision.' },
  { ecosystem: 'go', rule: 'Untagged commits (vX.Y.Z-yyyymmddhhmmss-commit) are pseudo-versions; other "-" labels are pre-releases.' },
  { ecosystem: 'pypi', rule: 'PEP 440: a, b, rc are pre-releases; .devN is a dev release; .postN and +local are stable.' },
  { ecosystem: 'maven', rule: '-SNAPSHOT is a snapshot; alpha, beta, milestone (M1), RC, CR, preview, ea are pre-releases; Final, GA, RELEASE, SP, jre, android are stable.' },
  { ecosystem: 'rubygems', rule: 'Any letter in the version makes it a pre-release, as gem itself decides.' },
  { ecosystem: 'composer', rule: 'dev-* and *-dev are dev releases; alpha, beta, RC are pre-releases; patch versions (-p1) are stable.' },
];

export function releaseTypeApplies(info: ReleaseTypeInfo, ecosystem: string): boolean {
  return !ecosystem || info.appliesTo == null || info.appliesTo.includes(ecosystem);
}

export function appliesToLabel(info: ReleaseTypeInfo): string {
  return info.appliesTo == null ? 'All ecosystems' : info.appliesTo.map(ecosystemLabel).join(', ');
}

export function releaseTypeExamples(info: ReleaseTypeInfo, ecosystem: string): string[] {
  return info.examples[ecosystem] ?? info.examples[''];
}

export function stableExamples(ecosystem: string): string[] {
  return STABLE_EXAMPLES[ecosystem] ?? STABLE_EXAMPLES[''];
}

export function releaseTypeLabel(id: string): string {
  return RELEASE_TYPES.find((info) => info.id === id)?.label ?? id;
}

// --- One-line descriptions for lists and dialogs ---

/** `7.0`, `9.8`, `10`: a CVSS score as advisories print it. */
export function cvssScoreText(score: number): string {
  return score === 10 ? '10' : score.toFixed(1);
}

/** "CVSS ≥ 7.0", empty without a CVSS minimum. */
export function cvssText(c: PolicyConditions): string {
  return typeof c.cvssMin === 'number' ? `CVSS ≥ ${cvssScoreText(c.cvssMin)}` : '';
}

/** A CVSS minimum from 0.1 to 10 with at most one decimal, as the backend accepts it; null otherwise. */
export function cvssScoreOf(raw: string | number | null | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!/^\d+(\.\d)?$/.test(text)) return null;
  const n = Number(text);
  return n >= 0.1 && n <= 10 ? n : null;
}

/** What the rule matches, e.g. "Pre-release, Snapshot" or "Newer than 72 hours". */
export function ruleDetail(rule: PolicyRule, c: PolicyConditions): string {
  switch (rule) {
    case 'packages': {
      const names = (c.packageBlockList ?? []).join(', ');
      return c.versionRange?.trim() ? `${names} · ${versionText(c.versionRange)}` : names;
    }
    case 'releaseType':
      return (c.releaseTypes ?? []).map(releaseTypeLabel).join(', ');
    case 'releaseAge': {
      const parts: string[] = [];
      if (positive(c.releaseAgeMaxHours)) parts.push(`Newer than ${plural(c.releaseAgeMaxHours as number, 'hour')}`);
      if (positive(c.releaseAgeMinDays)) parts.push(`no release in ${plural(c.releaseAgeMinDays as number, 'day')}`);
      return parts.join(' or ').replace(/^n/, 'N');
    }
    case 'vulnerability': {
      const parts: string[] = [];
      if (c.cveBlockList?.length) parts.push(c.cveBlockList.join(', '));
      const condition = [cvssText(c), epssText(c)].filter(Boolean);
      if (condition.length) parts.push(condition.join(' and '));
      return parts.join(' or ');
    }
    case 'license':
      if (c.licenseAllowList?.length) return `All except ${c.licenseAllowList.join(', ')}`;
      return (c.licenseDenyList ?? []).join(', ');
    case 'namespace': {
      const reserved = `Internal only: ${(c.reservedNamespaces ?? []).join(', ')}`;
      return c.publicPackages?.length ? `${reserved} · public: ${c.publicPackages.join(', ')}` : reserved;
    }
    case 'scorecard':
      return scorecardDetail(c);
  }
}

/** `10 %`, `0.5 %`: a fraction as people read a probability. */
export function percentText(fraction: number): string {
  const p = fraction * 100;
  return `${Number.isInteger(p) ? p : Number(p.toFixed(2))} %`;
}

/** `95th`. */
export function ordinalText(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/** "EPSS ≥ 10 %" or "EPSS percentile ≥ 95th", empty without an EPSS threshold. */
export function epssText(c: PolicyConditions): string {
  if (typeof c.epssMin === 'number') return `EPSS ≥ ${percentText(c.epssMin)}`;
  if (typeof c.epssPercentileMin === 'number') return `EPSS percentile ≥ ${ordinalText(Math.round(c.epssPercentileMin * 100))}`;
  return '';
}

/** Example reserved namespaces per ecosystem, for placeholders and help. */
export const NAMESPACE_EXAMPLES: Record<string, string> = {
  npm: '@acme, acme-*',
  pypi: 'acme-*',
  go: 'github.com/acme, go.acme.com',
  maven: 'com.acme, com.acme:core',
  nuget: 'Acme.*',
  cargo: 'acme-*',
  composer: 'acme/*',
  rubygems: 'acme-*, acme_*',
};

/** What each ecosystem's patterns mean, shown under the reserved namespaces field. */
export const NAMESPACE_HINTS: Record<string, string> = {
  npm: '@acme = whole scope · acme-* = names starting with acme-',
  pypi: 'acme-* also matches acme_auth and Acme.Auth.',
  go: 'github.com/acme covers github.com/acme/svc, not github.com/acmecorp.',
  maven: 'com.acme covers com.acme.billing · com.acme:core = one artifact',
  nuget: 'Acme.* covers Acme.Billing.',
  cargo: 'acme-* also matches acme_core.',
  composer: 'acme/* = whole vendor · acme/pkg-* = a prefix inside it',
  rubygems: 'acme-* also matches acme_billing.',
};

/** Advice beside the hint, in a tooltip: claim the namespace on the public registry too. */
export const NAMESPACE_TIPS: Record<string, string> = {
  npm: 'Also claim the scope on npmjs.com as an org, so nobody else can publish under it.',
  pypi: 'PyPI has no namespaces: pick a distinctive prefix.',
  nuget: 'Also reserve the prefix on nuget.org, so only your account can publish under it.',
  cargo: 'crates.io has no namespaces: pick a distinctive prefix.',
  rubygems: 'RubyGems has no namespaces: pick a distinctive prefix.',
};

export function versionText(range: string | undefined): string {
  const parts = versionParts(range);
  return parts.length ? parts.join(', ') : 'Any version';
}

/** The `||` clauses of a stored range as people read them: `=1.2.3` shows as 1.2.3. Empty for any version. */
export function versionParts(range: string | null | undefined): string[] {
  const value = (range ?? '').trim();
  if (!value || value === '*') return [];
  return value
    .split(/\s*\|\|\s*/)
    .map((part) => part.trim().replace(/^=\s*/, ''))
    .filter(Boolean);
}

const VERSION_ORDER = new Intl.Collator('en', { numeric: true });

/** versionParts in version order (0.1.2 before 0.1.10), for lists nobody typed in an order. */
export function sortedVersionParts(range: string | null | undefined): string[] {
  return versionParts(range).sort(VERSION_ORDER.compare);
}

const DOTTED_VERSION = /^(\d+(?:\.\d+)*\.)(\d+)$/;

/**
 * Sorted versions with each run of three or more consecutive releases shown as one entry:
 * 0.1.0, 0.1.1, 0.1.2, 0.1.3 shows as 0.1.0 – 0.1.3. Display only; a run is still those versions
 * and nothing between them, such as 0.1.2rc1. Anything that is not plain dotted numbers stays as it is.
 */
export function versionRuns(sorted: readonly string[]): string[] {
  const runs: string[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const prev = DOTTED_VERSION.exec(sorted[i - 1]);
    const next = i < sorted.length ? DOTTED_VERSION.exec(sorted[i]) : null;
    if (prev && next && prev[1] === next[1] && Number(next[2]) === Number(prev[2]) + 1) continue;
    const length = i - start;
    if (length >= 3) runs.push(`${sorted[start]} – ${sorted[i - 1]}`);
    else runs.push(...sorted.slice(start, i));
    start = i;
  }
  return runs;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}
