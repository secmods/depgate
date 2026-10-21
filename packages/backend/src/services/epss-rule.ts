import { getVulnIds, hasVulnInBlockList, type OSVVuln } from './osv-provider.js';
import { isCveId, type EpssValue } from './epss-feed.js';
import { cvssText, vulnCvss, type CompiledCvss, type VulnCvss } from './cvss.js';

/** EPSS conditions of the Vulnerability rule (requirements_epss.md §6.1). Fractions 0–1. */
export type EpssConditions = {
  epssMin?: number;
  epssPercentileMin?: number;
  epssUnknown?: 'match' | 'ignore';
};

export type CompiledEpss = {
  /** Which number the threshold applies to. */
  mode: 'score' | 'percentile';
  min: number;
  /** A vulnerability with no EPSS: `match` counts it as meeting the threshold (D6). */
  unknown: 'match' | 'ignore';
};

function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : null;
}

export function hasEpssThreshold(c: EpssConditions): boolean {
  return c.epssMin != null || c.epssPercentileMin != null;
}

export function compileEpss(c: EpssConditions): CompiledEpss | null {
  const score = fraction(c.epssMin);
  const percentile = fraction(c.epssPercentileMin);
  if (score === null && percentile === null) return null;
  return {
    mode: score !== null ? 'score' : 'percentile',
    min: (score ?? percentile)!,
    unknown: c.epssUnknown === 'ignore' ? 'ignore' : 'match',
  };
}

/** Why the EPSS conditions cannot be saved, or null. */
export function epssConditionsError(c: EpssConditions): string | null {
  if (c.epssMin != null && c.epssPercentileMin != null) {
    return 'Use either epssMin or epssPercentileMin, not both';
  }
  if (c.epssMin != null && fraction(c.epssMin) === null) return 'epssMin must be a fraction above 0 and at most 1 (0.1 is 10 %)';
  if (c.epssPercentileMin != null && fraction(c.epssPercentileMin) === null) {
    return 'epssPercentileMin must be a fraction above 0 and at most 1 (0.95 is the 95th percentile)';
  }
  if (c.epssUnknown != null) {
    if (c.epssUnknown !== 'match' && c.epssUnknown !== 'ignore') return 'epssUnknown must be match or ignore';
    if (!hasEpssThreshold(c)) return 'epssUnknown needs epssMin or epssPercentileMin';
  }
  return null;
}

/** The CVE ids of a vulnerability: its own id and its aliases (a GHSA advisory lists its CVE there). */
export function vulnCves(vuln: OSVVuln): string[] {
  return [...new Set([vuln.id, ...(vuln.aliases ?? [])].map((id) => id.trim().toUpperCase()).filter(isCveId))];
}

/** Every CVE id among a list of vulnerabilities, for one EPSS lookup. */
export function cvesOf(vulns: OSVVuln[]): string[] {
  return [...new Set(vulns.flatMap(vulnCves))];
}

/** The highest EPSS among the vulnerability's CVE ids (D5), with that CVE; null when none has a score. */
export function vulnEpss(vuln: OSVVuln, scores: Map<string, EpssValue>): (EpssValue & { cve: string }) | null {
  let best: (EpssValue & { cve: string }) | null = null;
  for (const cve of vulnCves(vuln)) {
    const value = scores.get(cve);
    if (value && (!best || value.score > best.score)) best = { ...value, cve };
  }
  return best;
}

export type VulnerabilityRule = {
  cveBlockList: string[];
  cvss: CompiledCvss | null;
  epss: CompiledEpss | null;
};

export type EpssFacts = { scores: Map<string, EpssValue>; scoreDate: string | null };

export type VulnerabilityOutcome = { reasons: string[]; reasonKey: string };

/** `42.1 %`, `2 %`, `0.42 %`. */
export function percent(value: number): string {
  const p = value * 100;
  const text = (p >= 1 ? p.toFixed(1) : p.toFixed(2)).replace(/\.?0+$/, '');
  return `${text || '0'} %`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function percentileText(value: number): string {
  return ordinal(Math.floor(value * 100));
}

function label(vuln: OSVVuln, epss: (EpssValue & { cve: string }) | null): string {
  const cve = epss?.cve ?? vulnCves(vuln)[0];
  return cve && cve !== vuln.id.toUpperCase() ? `${vuln.id} (${cve})` : vuln.id;
}

function epssText(epss: (EpssValue & { cve: string }) | null, vuln: OSVVuln, scoreDate: string | null): string {
  if (!epss) {
    const why = vulnCves(vuln).length === 0 ? 'no CVE id' : scoreDate ? `no score on ${scoreDate}` : 'EPSS data not synced';
    return `EPSS unknown (${why})`;
  }
  return `EPSS ${percent(epss.score)} (${percentileText(epss.percentile)} percentile${scoreDate ? `, ${scoreDate}` : ''})`;
}

/** `GHSA-xxxx (CVE-2024-1234): CVSS 3.1 7.5, EPSS 42.1 % (97th percentile, 2026-10-11)` */
export function epssReason(vuln: OSVVuln, epss: (EpssValue & { cve: string }) | null, scoreDate: string | null): string {
  return `${label(vuln, epss)}: ${cvssText(vulnCvss(vuln))}, ${epssText(epss, vuln, scoreDate)}`;
}

/** `GHSA-xxxx (CVE-2024-1234): CVSS 4.0 9.3` */
export function cvssReason(vuln: OSVVuln): string {
  return `${label(vuln, null)}: ${cvssText(vulnCvss(vuln))}`;
}

/** The CVE id the report groups a CVSS match under: the advisory's CVE, else its own id. */
function cvssReasonKey(vuln: OSVVuln, cvss: VulnCvss | null): string {
  return cvss ? `cvss:${vulnCves(vuln)[0] ?? vuln.id}` : 'cvss:unknown';
}

type Candidate = { vuln: OSVVuln; cvss: VulnCvss | null; epss: (EpssValue & { cve: string }) | null };

/**
 * The Vulnerability rule: a listed CVE, or one vulnerability that meets both the CVSS minimum and
 * the EPSS threshold (D2). Either threshold alone is enough when only one is set. Null when it does not match.
 */
export function evaluateVulnerabilities(vulns: OSVVuln[], rule: VulnerabilityRule, epss: EpssFacts | null): VulnerabilityOutcome | null {
  const reasons: string[] = [];
  let reasonKey: string | undefined;

  if (rule.cveBlockList.length && hasVulnInBlockList(getVulnIds(vulns), rule.cveBlockList)) {
    const blockSet = new Set(rule.cveBlockList.map((id) => id.toUpperCase()));
    const matched = getVulnIds(vulns).filter((id) => blockSet.has(id.toUpperCase()));
    reasons.push(`CVE(s) in block list: ${matched.join(', ')}`);
    reasonKey = `cve:${matched[0].toUpperCase()}`;
  }
  if (!rule.cvss && !rule.epss) return reasons.length ? { reasons, reasonKey: reasonKey! } : null;

  const scores = epss?.scores ?? new Map<string, EpssValue>();
  const matching: Candidate[] = [];
  for (const vuln of vulns) {
    const cvss = vulnCvss(vuln);
    if (rule.cvss && !(cvss ? cvss.score >= rule.cvss.min : rule.cvss.unknown === 'match')) continue;
    const value = rule.epss ? vulnEpss(vuln, scores) : null;
    if (rule.epss) {
      const meets = value
        ? (rule.epss.mode === 'score' ? value.score : value.percentile) >= rule.epss.min
        : rule.epss.unknown === 'match';
      if (!meets) continue;
    }
    matching.push({ vuln, cvss, epss: value });
  }
  if (matching.length > 0) {
    // The most likely to be exploited first (else the highest score); unscored ones after every scored one.
    matching.sort((a, b) =>
      rule.epss ? (b.epss?.score ?? -1) - (a.epss?.score ?? -1) : (b.cvss?.score ?? -1) - (a.cvss?.score ?? -1)
    );
    const top = matching[0];
    reasons.push(rule.epss ? epssReason(top.vuln, top.epss, epss?.scoreDate ?? null) : cvssReason(top.vuln));
    if (matching.length > 1) reasons.push(`${matching.length - 1} more ${matching.length === 2 ? 'vulnerability matches' : 'vulnerabilities match'}`);
    reasonKey ??= rule.epss ? (top.epss ? `epss:${top.epss.cve}` : 'epss:unknown') : cvssReasonKey(top.vuln, top.cvss);
  }
  return reasons.length ? { reasons, reasonKey: reasonKey! } : null;
}
