import { describe, expect, it } from 'vitest';
import type { OSVVuln } from './osv-provider.js';
import { vulnSeverity } from './osv-provider.js';
import {
  compileCvss,
  cvssBaseScore,
  cvssConditionsError,
  cvssText,
  vulnCvss,
  withCvssMin,
} from './cvss.js';
import { V30_6_5, V31_6_1, V31_7_5, V31_8_8, V31_9_8, V4_4_8, V4_9_3 } from '../test-support/cvss-vectors.js';

const withVectors = (...vectors: Array<[string, string]>): OSVVuln => ({
  id: 'GHSA-test',
  severity: vectors.map(([type, score]) => ({ type, score })),
});

describe('cvssBaseScore', () => {
  it('scores CVSS 4.0, 3.1 and 3.0 vectors', () => {
    expect(cvssBaseScore(V4_9_3)).toEqual({ score: 9.3, version: '4.0' });
    expect(cvssBaseScore(V31_9_8)).toEqual({ score: 9.8, version: '3.1' });
    expect(cvssBaseScore(V30_6_5)).toEqual({ score: 6.5, version: '3.0' });
    expect([V4_4_8, V31_8_8, V31_7_5, V31_6_1].map((vector) => cvssBaseScore(vector)?.score)).toEqual([4.8, 8.8, 7.5, 6.1]);
  });

  it('rejects CVSS 2, bare numbers, garbage and vectors missing a base metric', () => {
    expect(cvssBaseScore('AV:N/AC:L/Au:N/C:P/I:P/A:P')).toBeNull();
    expect(cvssBaseScore('8.5')).toBeNull();
    expect(cvssBaseScore('garbage')).toBeNull();
    expect(cvssBaseScore('CVSS:3.1/AV:N/AC:L')).toBeNull();
    expect(cvssBaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H')).toBeNull();
  });
});

describe('vulnCvss', () => {
  it('prefers 4.0 over 3.1 over 3.0, whatever the order', () => {
    expect(vulnCvss(withVectors(['CVSS_V3', V31_9_8], ['CVSS_V4', V4_4_8]))).toEqual({ score: 4.8, version: '4.0' });
    expect(vulnCvss(withVectors(['CVSS_V3', V30_6_5], ['CVSS_V3', V31_7_5]))).toEqual({ score: 7.5, version: '3.1' });
    expect(vulnCvss(withVectors(['CVSS_V3', V30_6_5]))).toEqual({ score: 6.5, version: '3.0' });
  });

  it('takes the highest score among vectors of the same version', () => {
    expect(vulnCvss(withVectors(['CVSS_V3', V31_7_5], ['CVSS_V3', V31_8_8]))).toEqual({ score: 8.8, version: '3.1' });
  });

  it('skips CVSS 2 and unreadable vectors', () => {
    expect(vulnCvss(withVectors(['CVSS_V2', 'AV:N/AC:L/Au:N/C:C/I:C/A:C'], ['CVSS_V3', V31_7_5]))).toEqual({ score: 7.5, version: '3.1' });
    expect(vulnCvss(withVectors(['CVSS_V3', 'CVSS:3.1/AV:N']))).toBeNull();
  });

  it('without a vector, counts the severity label as its lowest score', () => {
    expect(vulnCvss({ id: 'GHSA-a', database_specific: { severity: 'HIGH' } })).toEqual({ score: 7, version: null, label: 'HIGH' });
    expect(vulnCvss({ id: 'GHSA-b', database_specific: { severity: 'moderate' } })).toEqual({ score: 4, version: null, label: 'MEDIUM' });
    expect(vulnCvss({ id: 'GHSA-c', database_specific: { severity: 'CRITICAL' } })?.score).toBe(9);
    expect(vulnCvss({ id: 'GHSA-d', database_specific: { severity: 'LOW' } })?.score).toBe(0.1);
  });

  it('a vector wins over the label', () => {
    expect(vulnCvss({ ...withVectors(['CVSS_V3', V31_7_5]), database_specific: { severity: 'CRITICAL' } })).toEqual({ score: 7.5, version: '3.1' });
  });

  it('is null with neither a vector nor a known label', () => {
    expect(vulnCvss({ id: 'GO-2024-0001' })).toBeNull();
    expect(vulnCvss({ id: 'X', database_specific: { severity: 'UNKNOWN' } })).toBeNull();
  });
});

describe('severity from CVSS', () => {
  it('rates the computed score, then the label, else UNKNOWN', () => {
    expect(vulnSeverity(withVectors(['CVSS_V4', V4_9_3]))).toBe('CRITICAL');
    expect(vulnSeverity(withVectors(['CVSS_V3', V31_7_5]))).toBe('HIGH');
    expect(vulnSeverity(withVectors(['CVSS_V3', V30_6_5]))).toBe('MEDIUM');
    expect(vulnSeverity({ id: 'GHSA-m', database_specific: { severity: 'MODERATE' } })).toBe('MEDIUM');
    expect(vulnSeverity({ id: 'GO-1' })).toBe('UNKNOWN');
  });

  it('describes the score with its version', () => {
    expect(cvssText({ score: 9.3, version: '4.0' })).toBe('CVSS 4.0 9.3');
    expect(cvssText({ score: 9, version: '3.1' })).toBe('CVSS 3.1 9.0');
    expect(cvssText({ score: 7, version: null, label: 'HIGH' })).toBe('HIGH (no CVSS vector, counted as 7.0)');
    expect(cvssText(null)).toBe('CVSS unknown');
  });
});

describe('CVSS conditions', () => {
  it.each([
    [{ cvssMin: 0 }, /0.1 to 10/],
    [{ cvssMin: 10.5 }, /0.1 to 10/],
    [{ cvssMin: 7.25 }, /one decimal/],
    [{ cvssMin: '7' }, /0.1 to 10/],
    [{ cvssMin: 7, cvssUnknown: 'maybe' }, /match or ignore/],
    [{ cvssUnknown: 'match' }, /needs cvssMin/],
    [{ cveSeverityThreshold: 'SEVERE' }, /replaced by cvssMin/],
  ])('rejects %j', (conditions, message) => {
    expect(cvssConditionsError(conditions as never)).toMatch(message);
  });

  it('accepts decimal scores from 0.1 to 10', () => {
    for (const cvssMin of [0.1, 6.1, 7, 7.1, 9.0, 10]) expect(cvssConditionsError({ cvssMin })).toBeNull();
    expect(cvssConditionsError({ cvssMin: 7, cvssUnknown: 'match' })).toBeNull();
  });

  it('compiles with unknown ignored by default', () => {
    expect(compileCvss({ cvssMin: 7.1 })).toEqual({ min: 7.1, unknown: 'ignore' });
    expect(compileCvss({ cvssMin: 7, cvssUnknown: 'match' })).toEqual({ min: 7, unknown: 'match' });
    expect(compileCvss({})).toBeNull();
  });

  it('reads a saved severity threshold as the lowest score of its rating', () => {
    expect(withCvssMin({ cveSeverityThreshold: 'CRITICAL', epssMin: 0.1 } as never)).toEqual({ cvssMin: 9, epssMin: 0.1 });
    expect(withCvssMin({ cveSeverityThreshold: 'high' })).toEqual({ cvssMin: 7 });
    expect(withCvssMin({ cveSeverityThreshold: 'MEDIUM' })).toEqual({ cvssMin: 4 });
    expect(withCvssMin({ cveSeverityThreshold: 'LOW' })).toEqual({ cvssMin: 0.1 });
    expect(withCvssMin({ cveSeverityThreshold: '' })).toEqual({});
    expect(withCvssMin({ cveSeverityThreshold: 'HIGH', cvssMin: 8 })).toEqual({ cvssMin: 8 });
    expect(withCvssMin({ cveSeverityThreshold: 'SEVERE' })).toEqual({ cveSeverityThreshold: 'SEVERE' });
    expect(compileCvss({ cveSeverityThreshold: 'HIGH' })).toEqual({ min: 7, unknown: 'ignore' });
  });
});
