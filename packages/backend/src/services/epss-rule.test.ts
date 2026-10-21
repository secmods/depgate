import { describe, expect, it } from 'vitest';
import type { OSVVuln } from './osv-provider.js';
import {
  compileEpss,
  cvesOf,
  epssConditionsError,
  epssReason,
  evaluateVulnerabilities,
  percent,
  vulnEpss,
  type EpssFacts,
  type VulnerabilityRule,
} from './epss-rule.js';
import { compileCvss } from './cvss.js';
import { V30_6_5, V31_7_5, V31_8_8, V31_9_8, V4_4_8 } from '../test-support/cvss-vectors.js';

/** `severity` is a CVSS vector, or the advisory's label when it publishes no vector. */
const vuln = (id: string, severity: string, aliases: string[] = []): OSVVuln =>
  severity.startsWith('CVSS:')
    ? { id, aliases, severity: [{ type: severity.startsWith('CVSS:4') ? 'CVSS_V4' : 'CVSS_V3', score: severity }] }
    : { id, aliases, database_specific: { severity } };

const CRIT_LOW_EPSS = vuln('GHSA-crit', V31_9_8, ['CVE-2024-0001']);
const LOW_HIGH_EPSS = vuln('GHSA-low', 'LOW', ['CVE-2024-0002']);
const HIGH_42 = vuln('GHSA-high', V31_7_5, ['CVE-2024-0003']);
const NO_CVE = vuln('RUSTSEC-2024-0001', V31_8_8);
const NO_SCORE = vuln('GO-2024-0001', '');

const facts: EpssFacts = {
  scoreDate: '2026-10-11',
  scores: new Map([
    ['CVE-2024-0001', { score: 0.001, percentile: 0.2 }],
    ['CVE-2024-0002', { score: 0.9, percentile: 0.999 }],
    ['CVE-2024-0003', { score: 0.421, percentile: 0.97 }],
    ['CVE-2024-0004', { score: 0.05, percentile: 0.9 }],
    ['CVE-2024-0005', { score: 0.6, percentile: 0.98 }],
  ]),
};

type RuleOptions = {
  cveBlockList?: string[];
  cvssMin?: number;
  cvssUnknown?: 'match' | 'ignore';
  epssMin?: number;
  epssPercentileMin?: number;
  epssUnknown?: 'match' | 'ignore';
};

const rule = (extra: RuleOptions = {}): VulnerabilityRule => ({
  cveBlockList: extra.cveBlockList ?? [],
  cvss: compileCvss(extra),
  epss: compileEpss(extra),
});

describe('Vulnerability rule with CVSS', () => {
  it('CVSS only: names the vulnerability with its CVSS version and score', () => {
    expect(evaluateVulnerabilities([HIGH_42], rule({ cvssMin: 7 }), null)).toEqual({
      reasons: ['GHSA-high (CVE-2024-0003): CVSS 3.1 7.5'],
      reasonKey: 'cvss:CVE-2024-0003',
    });
    expect(evaluateVulnerabilities([HIGH_42], rule({ cvssMin: 7.5 }), null)?.reasonKey).toBe('cvss:CVE-2024-0003');
    expect(evaluateVulnerabilities([HIGH_42], rule({ cvssMin: 7.6 }), null)).toBeNull();
  });

  it('names the highest score first and counts the rest', () => {
    expect(evaluateVulnerabilities([HIGH_42, CRIT_LOW_EPSS, LOW_HIGH_EPSS], rule({ cvssMin: 7 }), null)?.reasons).toEqual([
      'GHSA-crit (CVE-2024-0001): CVSS 3.1 9.8',
      '1 more vulnerability matches',
    ]);
  });

  it('a CVSS 4.0 vector wins over 3.1', () => {
    const both: OSVVuln = {
      id: 'GHSA-both',
      aliases: ['CVE-2024-0009'],
      severity: [
        { type: 'CVSS_V3', score: V31_9_8 },
        { type: 'CVSS_V4', score: V4_4_8 },
      ],
    };
    expect(evaluateVulnerabilities([both], rule({ cvssMin: 7 }), null)).toBeNull();
    expect(evaluateVulnerabilities([both], rule({ cvssMin: 4.8 }), null)?.reasons).toEqual(['GHSA-both (CVE-2024-0009): CVSS 4.0 4.8']);
  });

  it('without a vector, the severity label counts as its lowest score', () => {
    const labelled = vuln('GHSA-label', 'HIGH', ['CVE-2024-0010']);
    expect(evaluateVulnerabilities([labelled], rule({ cvssMin: 7 }), null)?.reasons).toEqual([
      'GHSA-label (CVE-2024-0010): HIGH (no CVSS vector, counted as 7.0)',
    ]);
    expect(evaluateVulnerabilities([labelled], rule({ cvssMin: 7.1 }), null)).toBeNull();
  });

  it('with neither a vector nor a label, follows cvssUnknown: ignore (default) or match', () => {
    expect(evaluateVulnerabilities([NO_SCORE], rule({ cvssMin: 7 }), null)).toBeNull();
    expect(evaluateVulnerabilities([NO_SCORE], rule({ cvssMin: 7, cvssUnknown: 'match' }), null)).toEqual({
      reasons: ['GO-2024-0001: CVSS unknown'],
      reasonKey: 'cvss:unknown',
    });
  });

  it('a policy saved with a severity threshold reads it as a CVSS minimum', () => {
    const legacy: VulnerabilityRule = { cveBlockList: [], cvss: compileCvss({ cveSeverityThreshold: 'HIGH' }), epss: null };
    expect(evaluateVulnerabilities([HIGH_42], legacy, null)?.reasonKey).toBe('cvss:CVE-2024-0003');
    expect(evaluateVulnerabilities([vuln('GHSA-med', V30_6_5)], legacy, null)).toBeNull();
  });
});

describe('Vulnerability rule with EPSS (§6.2)', () => {
  it('EPSS only: any vulnerability at or above the threshold', () => {
    const outcome = evaluateVulnerabilities([CRIT_LOW_EPSS, LOW_HIGH_EPSS], rule({ epssMin: 0.5 }), facts);
    expect(outcome).toEqual({
      reasons: ['GHSA-low (CVE-2024-0002): LOW (no CVSS vector, counted as 0.1), EPSS 90 % (99th percentile, 2026-10-11)'],
      reasonKey: 'epss:CVE-2024-0002',
    });
    expect(evaluateVulnerabilities([CRIT_LOW_EPSS], rule({ epssMin: 0.5 }), facts)).toBeNull();
  });

  it('CVSS and EPSS on the same vulnerability match', () => {
    const outcome = evaluateVulnerabilities([HIGH_42], rule({ cvssMin: 7, epssMin: 0.1 }), facts);
    expect(outcome?.reasons).toEqual(['GHSA-high (CVE-2024-0003): CVSS 3.1 7.5, EPSS 42.1 % (97th percentile, 2026-10-11)']);
    expect(outcome?.reasonKey).toBe('epss:CVE-2024-0003');
  });

  it('CVSS on one vulnerability and EPSS on another do not match (D2)', () => {
    expect(evaluateVulnerabilities([CRIT_LOW_EPSS, LOW_HIGH_EPSS], rule({ cvssMin: 7, epssMin: 0.1 }), facts)).toBeNull();
  });

  it('a listed CVE matches whatever its CVSS and EPSS (D3)', () => {
    const outcome = evaluateVulnerabilities([CRIT_LOW_EPSS], rule({ cveBlockList: ['cve-2024-0001'], cvssMin: 10, epssMin: 0.5 }), facts);
    expect(outcome).toEqual({ reasons: ['CVE(s) in block list: CVE-2024-0001'], reasonKey: 'cve:CVE-2024-0001' });
  });

  it('an unknown EPSS follows epssUnknown: match (default) or ignore (D6)', () => {
    const matched = evaluateVulnerabilities([NO_CVE], rule({ cvssMin: 7, epssMin: 0.1 }), facts);
    expect(matched).toEqual({ reasons: ['RUSTSEC-2024-0001: CVSS 3.1 8.8, EPSS unknown (no CVE id)'], reasonKey: 'epss:unknown' });
    expect(evaluateVulnerabilities([NO_CVE], rule({ cvssMin: 7, epssMin: 0.1, epssUnknown: 'ignore' }), facts)).toBeNull();
  });

  it('says why a CVE has no score: never synced, or not in that day’s file', () => {
    const unscored = vuln('GHSA-new', V31_7_5, ['CVE-2026-9999']);
    expect(epssReason(unscored, null, '2026-10-11')).toBe('GHSA-new (CVE-2026-9999): CVSS 3.1 7.5, EPSS unknown (no score on 2026-10-11)');
    expect(epssReason(unscored, null, null)).toBe('GHSA-new (CVE-2026-9999): CVSS 3.1 7.5, EPSS unknown (EPSS data not synced)');
    const neverSynced = evaluateVulnerabilities([HIGH_42], rule({ cvssMin: 7, epssMin: 0.1 }), { scores: new Map(), scoreDate: null });
    expect(neverSynced?.reasons[0]).toContain('EPSS data not synced');
  });

  it('percentile mode compares the percentile', () => {
    expect(evaluateVulnerabilities([HIGH_42], rule({ epssPercentileMin: 0.95 }), facts)?.reasonKey).toBe('epss:CVE-2024-0003');
    expect(evaluateVulnerabilities([HIGH_42], rule({ epssPercentileMin: 0.98 }), facts)).toBeNull();
  });

  it('names the most likely vulnerability first and counts the rest', () => {
    const outcome = evaluateVulnerabilities([HIGH_42, LOW_HIGH_EPSS, NO_CVE], rule({ epssMin: 0.1 }), facts);
    expect(outcome?.reasons).toEqual([
      'GHSA-low (CVE-2024-0002): LOW (no CVSS vector, counted as 0.1), EPSS 90 % (99th percentile, 2026-10-11)',
      '2 more vulnerabilities match',
    ]);
  });
});

describe('aliases (D5)', () => {
  it('takes the highest EPSS among a vulnerability’s CVE ids', () => {
    const twoCves = vuln('GHSA-two', 'HIGH', ['CVE-2024-0004', 'cve-2024-0005', 'PYSEC-1']);
    expect(vulnEpss(twoCves, facts.scores)).toEqual({ cve: 'CVE-2024-0005', score: 0.6, percentile: 0.98 });
    expect(evaluateVulnerabilities([twoCves], rule({ epssMin: 0.5 }), facts)?.reasonKey).toBe('epss:CVE-2024-0005');
  });

  it('reads a CVE used as the vulnerability id itself, and collects CVE ids once', () => {
    expect(vulnEpss(vuln('CVE-2024-0003', 'HIGH'), facts.scores)?.score).toBe(0.421);
    expect(cvesOf([HIGH_42, vuln('GHSA-dup', 'LOW', ['CVE-2024-0003']), NO_CVE])).toEqual(['CVE-2024-0003']);
  });
});

describe('EPSS conditions', () => {
  it.each([
    [{ epssMin: 0.1, epssPercentileMin: 0.9 }, /either epssMin or epssPercentileMin/],
    [{ epssMin: 0 }, /above 0 and at most 1/],
    [{ epssMin: 10 }, /above 0 and at most 1/],
    [{ epssPercentileMin: 1.5 }, /epssPercentileMin must be/],
    [{ epssMin: 0.1, epssUnknown: 'maybe' }, /match or ignore/],
    [{ epssUnknown: 'ignore' }, /needs epssMin or epssPercentileMin/],
  ])('rejects %j', (conditions, message) => {
    expect(epssConditionsError(conditions as never)).toMatch(message);
  });

  it('accepts a score or a percentile threshold, and compiles the default for unknown', () => {
    expect(epssConditionsError({ epssMin: 1 })).toBeNull();
    expect(epssConditionsError({ epssPercentileMin: 0.95, epssUnknown: 'ignore' })).toBeNull();
    expect(compileEpss({ epssMin: 0.1 })).toEqual({ mode: 'score', min: 0.1, unknown: 'match' });
    expect(compileEpss({ epssPercentileMin: 0.95, epssUnknown: 'ignore' })).toEqual({ mode: 'percentile', min: 0.95, unknown: 'ignore' });
    expect(compileEpss({})).toBeNull();
  });

  it('formats percentages', () => {
    expect([percent(0.421), percent(0.9), percent(0.0042), percent(1), percent(0)]).toEqual(['42.1 %', '90 %', '0.42 %', '100 %', '0 %']);
  });
});
