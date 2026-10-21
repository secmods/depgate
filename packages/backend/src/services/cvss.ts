import * as cvssModule from 'ae-cvss-calculator';
import type { OSVVuln } from './osv-provider.js';

type CvssLibrary = typeof cvssModule;
// CommonJS gets the classes on the module; an ES import (Vitest) gets them on its default export.
const cvssLib: CvssLibrary =
  typeof cvssModule.Cvss3P1 === 'function' ? cvssModule : (cvssModule as unknown as { default: CvssLibrary }).default;

export type CvssVersion = '4.0' | '3.1' | '3.0';

/** Preferred first: a vulnerability's score comes from its newest CVSS version. */
const VERSIONS: readonly CvssVersion[] = ['4.0', '3.1', '3.0'];

/** Without every base metric the calculator fills in "not defined" and returns 0 instead of failing. */
const BASE_METRICS: Record<CvssVersion, readonly string[]> = {
  '4.0': ['AV', 'AC', 'AT', 'PR', 'UI', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA'],
  '3.1': ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'],
  '3.0': ['AV', 'AC', 'PR', 'UI', 'S', 'C', 'I', 'A'],
};

/** The lowest score of each rating (FIRST qualitative severity scale), so an advisory's label stands for its score. */
export const SEVERITY_MIN_SCORE: Record<string, number> = { CRITICAL: 9.0, HIGH: 7.0, MEDIUM: 4.0, LOW: 0.1 };

/**
 * A vulnerability's CVSS base score. `version` is null when the score stands in for the
 * advisory's severity label, because the advisory publishes no CVSS vector.
 */
export type VulnCvss = { score: number; version: CvssVersion; label?: undefined } | { score: number; version: null; label: string };

/** The base score of a CVSS 3.0, 3.1 or 4.0 vector, or null when the vector is not one of those or is incomplete. */
export function cvssBaseScore(vector: string): { score: number; version: CvssVersion } | null {
  const text = vector.trim();
  const version = /^CVSS:(4\.0|3\.1|3\.0)\//.exec(text)?.[1] as CvssVersion | undefined;
  if (!version) return null;
  const metrics = new Set(text.split('/').slice(1).map((part) => part.split(':')[0]));
  if (BASE_METRICS[version].some((metric) => !metrics.has(metric))) return null;
  try {
    const calculator =
      version === '4.0' ? new cvssLib.Cvss4P0(text) : version === '3.1' ? new cvssLib.Cvss3P1(text) : new cvssLib.Cvss3P0(text);
    const score = calculator.calculateScores().base;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) return null;
    return { score: Math.round(score * 10) / 10, version };
  } catch {
    return null;
  }
}

/** CRITICAL, HIGH, MEDIUM or LOW from the advisory database's own label (GitHub says MODERATE), else null. */
function severityLabel(vuln: OSVVuln): string | null {
  const raw = (vuln.database_specific as { severity?: unknown } | undefined)?.severity;
  if (typeof raw !== 'string') return null;
  const label = raw.trim().toUpperCase();
  const normalized = label === 'MODERATE' ? 'MEDIUM' : label;
  return normalized in SEVERITY_MIN_SCORE ? normalized : null;
}

/**
 * The vulnerability's CVSS score: from its 4.0 vector, else 3.1, else 3.0 (the highest when a version
 * has several). Without a vector, the lowest score of the advisory's severity label. Null when neither exists.
 */
export function vulnCvss(vuln: OSVVuln): VulnCvss | null {
  let best: { score: number; version: CvssVersion } | null = null;
  for (const entry of vuln.severity ?? []) {
    if (typeof entry?.score !== 'string') continue;
    const parsed = cvssBaseScore(entry.score);
    if (!parsed) continue;
    const rank = VERSIONS.indexOf(parsed.version);
    const bestRank = best ? VERSIONS.indexOf(best.version) : VERSIONS.length;
    if (rank < bestRank || (rank === bestRank && parsed.score > best!.score)) best = parsed;
  }
  if (best) return best;
  const label = severityLabel(vuln);
  return label ? { score: SEVERITY_MIN_SCORE[label], version: null, label } : null;
}

/** The rating of a CVSS score: CRITICAL, HIGH, MEDIUM, LOW or NONE (0.0). */
export function cvssRating(score: number): string {
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'NONE';
}

/** CRITICAL, HIGH, MEDIUM, LOW, NONE or UNKNOWN: the rating of the CVSS score, else the advisory's label. */
export function cvssSeverity(cvss: VulnCvss | null): string {
  if (!cvss) return 'UNKNOWN';
  return cvss.version ? cvssRating(cvss.score) : cvss.label;
}

/** `CVSS 4.0 9.3`, or `HIGH (no CVSS vector, counted as 7.0)`, or `CVSS unknown`. */
export function cvssText(cvss: VulnCvss | null): string {
  if (!cvss) return 'CVSS unknown';
  if (cvss.version) return `CVSS ${cvss.version} ${cvss.score.toFixed(1)}`;
  return `${cvss.label} (no CVSS vector, counted as ${cvss.score.toFixed(1)})`;
}

/** CVSS conditions of the Vulnerability rule. */
export type CvssConditions = {
  /** Match a vulnerability whose CVSS base score is at least this, 0.1–10 with one decimal. */
  cvssMin?: number;
  /** A vulnerability with neither a CVSS vector nor a severity label: `match` counts it as meeting cvssMin. Default ignore. */
  cvssUnknown?: 'match' | 'ignore';
  /** Replaced by cvssMin. Policies saved with it are read as the lowest score of the rating. */
  cveSeverityThreshold?: string;
};

export type CompiledCvss = { min: number; unknown: 'match' | 'ignore' };

function validMin(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 10 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
}

export function hasCvssThreshold(c: CvssConditions): boolean {
  return c.cvssMin != null || (typeof c.cveSeverityThreshold === 'string' && c.cveSeverityThreshold.trim() !== '');
}

/**
 * The conditions with a saved severity threshold turned into cvssMin (Critical 9.0, High 7.0,
 * Medium 4.0, Low 0.1). An unknown label stays, so validation can report it.
 */
export function withCvssMin<T extends CvssConditions | null | undefined>(conditions: T): T {
  if (!conditions || conditions.cveSeverityThreshold == null) return conditions;
  const label = String(conditions.cveSeverityThreshold).trim().toUpperCase();
  const min = SEVERITY_MIN_SCORE[label];
  if (label !== '' && min === undefined) return conditions;
  const next: CvssConditions = { ...conditions };
  delete next.cveSeverityThreshold;
  if (label !== '' && next.cvssMin == null) next.cvssMin = min;
  return next as T;
}

export function compileCvss(conditions: CvssConditions): CompiledCvss | null {
  const c = withCvssMin(conditions);
  if (!validMin(c.cvssMin)) return null;
  return { min: c.cvssMin, unknown: c.cvssUnknown === 'match' ? 'match' : 'ignore' };
}

/** Why the CVSS conditions cannot be saved, or null. */
export function cvssConditionsError(c: CvssConditions): string | null {
  if (c.cveSeverityThreshold != null && String(c.cveSeverityThreshold).trim() !== '') {
    return 'cveSeverityThreshold is replaced by cvssMin: a CVSS score from 0.1 to 10 (LOW, MEDIUM, HIGH and CRITICAL are 0.1, 4.0, 7.0 and 9.0)';
  }
  if (c.cvssMin != null && !validMin(c.cvssMin)) return 'cvssMin must be a CVSS score from 0.1 to 10 with at most one decimal, such as 7.5';
  if (c.cvssUnknown != null) {
    if (c.cvssUnknown !== 'match' && c.cvssUnknown !== 'ignore') return 'cvssUnknown must be match or ignore';
    if (c.cvssMin == null) return 'cvssUnknown needs cvssMin';
  }
  return null;
}
