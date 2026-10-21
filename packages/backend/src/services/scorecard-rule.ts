import { canonicalCheckName, type ScorecardCheckName } from './scorecard-checks.js';

/** Hosts the public Scorecard API has results for. */
const SCORECARD_HOSTS = new Set(['github.com', 'gitlab.com']);

export type ScorecardResult = {
  /** `github.com/owner/repo`, as the package declared it. */
  project: string;
  /** Where the repository came from: the package's registry metadata, or deps.dev. */
  via: 'registry' | 'deps.dev';
  /** deps.dev relationProvenance, e.g. SLSA_ATTESTATION. Only when `via` is deps.dev. */
  provenance?: string;
  /** Where the score came from: the Scorecard API, or deps.dev while it was unavailable. */
  scoreVia: 'scorecard' | 'deps.dev';
  date: string;
  overall: number;
  checks: Record<string, number>;
};

export type ScorecardUnknownReason = 'no-repository' | 'unsupported-host' | 'not-scanned';
export type ScorecardNotApplicable = 'internal-remote' | 'private-name';

/** What a lookup learned about one package version. Present in the facts once the lookup finished. */
export type ScorecardLookup =
  | { status: 'found'; result: ScorecardResult }
  | { status: 'unknown'; reason: ScorecardUnknownReason; project?: string }
  | { status: 'unavailable' }
  | { status: 'not-applicable'; reason: ScorecardNotApplicable }
  | { status: 'disabled' };

export type ScorecardCheckMinimum = { name: ScorecardCheckName; minScore: number };

export type CompiledScorecard = {
  minScore: number | null;
  checks: ScorecardCheckMinimum[];
  unknown: 'allow' | 'block';
  unavailable: 'allow' | 'block';
};

export type ScorecardConditions = {
  scorecardMinScore?: number;
  scorecardChecks?: Array<{ name: string; minScore: number }>;
  scorecardUnknown?: 'allow' | 'block';
  scorecardUnavailable?: 'allow' | 'block';
};

function score(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

/** Whether stored conditions use the Scorecard rule. */
export function hasScorecardRule(c: ScorecardConditions): boolean {
  return score(c.scorecardMinScore) !== null || (Array.isArray(c.scorecardChecks) && c.scorecardChecks.length > 0);
}

export function compileScorecard(c: ScorecardConditions): CompiledScorecard | null {
  if (!hasScorecardRule(c)) return null;
  const checks: ScorecardCheckMinimum[] = [];
  for (const row of c.scorecardChecks ?? []) {
    const name = canonicalCheckName(row?.name);
    const min = score(row?.minScore);
    if (name && min !== null) checks.push({ name, minScore: min });
  }
  return {
    minScore: score(c.scorecardMinScore),
    checks,
    unknown: c.scorecardUnknown === 'block' ? 'block' : 'allow',
    unavailable: c.scorecardUnavailable === 'block' ? 'block' : 'allow',
  };
}

/** Why the Scorecard conditions cannot be saved, or null. */
export function scorecardConditionsError(c: ScorecardConditions): string | null {
  if (c.scorecardMinScore != null && score(c.scorecardMinScore) === null) {
    return 'scorecardMinScore must be a number from 0 to 10';
  }
  if (c.scorecardChecks != null) {
    if (!Array.isArray(c.scorecardChecks)) return 'scorecardChecks must be a list';
    const seen = new Set<string>();
    for (const row of c.scorecardChecks) {
      const raw = row && typeof row === 'object' ? (row as { name?: unknown }).name : undefined;
      if (typeof raw === 'string' && raw.trim().toLowerCase() === 'webhooks') {
        return 'The Webhooks check needs admin access to the repository and is never in public results';
      }
      const name = canonicalCheckName(raw);
      if (!name) return `Unknown Scorecard check "${String(raw ?? '')}"`;
      if (score((row as { minScore?: unknown }).minScore) === null) return `The minimum for ${name} must be a number from 0 to 10`;
      if (seen.has(name)) return `${name} is listed twice`;
      seen.add(name);
    }
  }
  for (const field of ['scorecardUnknown', 'scorecardUnavailable'] as const) {
    const value = c[field];
    if (value != null && value !== 'allow' && value !== 'block') return `${field} must be allow or block`;
  }
  return null;
}

/** Stored conditions with each check name in its canonical spelling. */
export function canonicalScorecardChecks<T extends ScorecardConditions>(c: T): T {
  if (!Array.isArray(c.scorecardChecks)) return c;
  return {
    ...c,
    scorecardChecks: c.scorecardChecks.map((row) => ({ ...row, name: canonicalCheckName(row.name) ?? row.name })),
  };
}

export type ScorecardOutcome = {
  match: boolean;
  reasons: string[];
  reasonKey?: string;
  /** The lookup failed, so the answer is incomplete whether or not the policy blocks on it. */
  unavailable?: boolean;
};

function day(iso: string): string {
  return iso.slice(0, 10);
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function source(result: ScorecardResult): string {
  const repo = result.via === 'registry' ? 'declared by the package' : `from deps.dev${result.provenance ? `, ${result.provenance}` : ''}`;
  const scored = result.scoreVia === 'deps.dev' ? ', score from deps.dev' : '';
  return `${result.project}, ${repo}, ${day(result.date)}${scored}`;
}

/** The rule against one lookup (requirements_scorecard.md §6.3). */
export function scorecardOutcome(lookup: ScorecardLookup, rule: CompiledScorecard, pkg: string): ScorecardOutcome {
  switch (lookup.status) {
    case 'not-applicable':
    case 'disabled':
      return { match: false, reasons: [] };
    case 'unavailable':
      return rule.unavailable === 'block'
        ? { match: true, reasons: [`OpenSSF Scorecard could not be checked for ${pkg}`], reasonKey: 'scorecard:unavailable', unavailable: true }
        : { match: false, reasons: [], unavailable: true };
    case 'unknown':
      return rule.unknown === 'block'
        ? { match: true, reasons: [`No OpenSSF Scorecard result for ${pkg}`], reasonKey: 'scorecard:unknown' }
        : { match: false, reasons: [] };
    case 'found': {
      const result = lookup.result;
      const reasons: string[] = [];
      let reasonKey: string | undefined;
      if (rule.minScore !== null && result.overall < rule.minScore) {
        reasons.push(`Scorecard ${formatScore(result.overall)} is below ${formatScore(rule.minScore)} (${source(result)})`);
        reasonKey = 'scorecard:overall';
      }
      for (const check of rule.checks) {
        const value = result.checks[check.name];
        // -1 (inconclusive) and a check the source did not report never match.
        if (value === undefined || value < 0 || value >= check.minScore) continue;
        reasons.push(`Scorecard check ${check.name} is ${formatScore(value)}, minimum ${formatScore(check.minScore)} (${result.project})`);
        reasonKey ??= `scorecard:${check.name}`;
      }
      return { match: reasons.length > 0, reasons, reasonKey };
    }
  }
}

const SHORTHAND = /^(github|gitlab):([^/\s]+)\/([^/\s#?]+)/i;
const BARE_OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `github.com/owner/repo` or `gitlab.com/group/[sub/]repo` from a declared repository value,
 * or null when it is not a repository on a host with public Scorecard results.
 * `npmShorthand` reads a bare `owner/repo` as GitHub, as npm does.
 */
export function normaliseRepoUrl(raw: unknown, opts: { npmShorthand?: boolean } = {}): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;

  const short = text.match(SHORTHAND);
  if (short) return build(`${short[1].toLowerCase()}.com`, [short[2], short[3]]);
  if (opts.npmShorthand && BARE_OWNER_REPO.test(text)) return build('github.com', text.split('/'));

  text = text.replace(/^git\+/i, '').replace(/^scm:(git:)?/i, '');
  // scp-style `user@host:owner/repo`, also written after a scheme (`ssh://git@host:owner/repo`) or without
  // a user (`host:owner/repo`). A colon followed by digits is a port and stays.
  const scp = text.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([a-z0-9.-]+\.[a-z]{2,}):(?!\d+(?:\/|$))\/?(.+)$/i);
  if (scp) text = `https://${scp[1]}/${scp[2]}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!SCORECARD_HOSTS.has(host)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  // A GitHub repository is always owner/repo, so anything after it (/tree/main/dir, /blob/…, /releases/…) is dropped.
  // GitLab groups nest, so its path ends at `/-/` or, in older links without it, at a page name.
  const stop = parts.findIndex((part, index) => index >= 2 && (part === '-' || GITLAB_PAGES.has(part.toLowerCase())));
  const repoParts = host === 'github.com' ? parts.slice(0, 2) : parts.slice(0, stop === -1 ? parts.length : stop);
  return build(host, repoParts);
}

const GITLAB_PAGES = new Set([
  'tree', 'blob', 'raw', 'blame', 'commits', 'commit', 'compare', 'branches', 'tags', 'releases',
  'issues', 'merge_requests', 'pipelines', 'jobs', 'wikis', 'wiki', 'archive', 'graphs', 'network',
]);

function build(host: string, parts: string[]): string | null {
  const cleaned = [...parts];
  if (cleaned.length < 2) return null;
  cleaned[cleaned.length - 1] = cleaned[cleaned.length - 1].replace(/\.git$/i, '');
  if (!cleaned.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')) return null;
  return `${host}/${cleaned.join('/')}`;
}

/** Whether a value names some URL or repository at all, to tell "no repository" from "a host without Scorecard". */
export function looksLikeRepository(raw: unknown): boolean {
  return typeof raw === 'string' && /[/:]/.test(raw.trim());
}

/** The Scorecard API body as stored: overall score, date and check scores. Null when it has no score. */
export function parseScorecardApi(body: unknown): { date: string; overall: number; checks: Record<string, number> } | null {
  if (!body || typeof body !== 'object') return null;
  const doc = body as { date?: unknown; score?: unknown; checks?: unknown };
  return parsedScore(doc.date, doc.score, doc.checks);
}

/** deps.dev GetProject: the same scan under `scorecard`, with `overallScore`. Null when the project has none. */
export function parseDepsDevProject(body: unknown): { date: string; overall: number; checks: Record<string, number> } | null {
  const card = body && typeof body === 'object' ? (body as { scorecard?: unknown }).scorecard : undefined;
  if (!card || typeof card !== 'object') return null;
  const doc = card as { date?: unknown; overallScore?: unknown; checks?: unknown };
  return parsedScore(doc.date, doc.overallScore, doc.checks);
}

function parsedScore(date: unknown, overall: unknown, rawChecks: unknown): { date: string; overall: number; checks: Record<string, number> } | null {
  if (typeof overall !== 'number' || !Number.isFinite(overall)) return null;
  const checks: Record<string, number> = {};
  if (Array.isArray(rawChecks)) {
    for (const row of rawChecks) {
      if (!row || typeof row !== 'object') continue;
      const name = canonicalCheckName((row as { name?: unknown }).name) ?? (row as { name?: unknown }).name;
      const value = (row as { score?: unknown }).score;
      if (typeof name === 'string' && typeof value === 'number' && Number.isFinite(value)) checks[name] = value;
    }
  }
  const at = typeof date === 'string' ? Date.parse(date) : NaN;
  return { date: Number.isNaN(at) ? new Date(0).toISOString() : new Date(at).toISOString(), overall, checks };
}
