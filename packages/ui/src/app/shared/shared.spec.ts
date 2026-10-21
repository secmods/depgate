import { describe, expect, it } from 'vitest';
import { ecosystemLabel, statusLabel, statusTone } from './status';
import { toCsv } from './csv';

describe('statusTone', () => {
  it('maps every spelling of a status to the same tone', () => {
    expect(statusTone('ALLOW')).toBe('success');
    expect(statusTone('approved')).toBe('success');
    expect(statusTone('BLOCK')).toBe('danger');
    expect(statusTone('rejected')).toBe('danger');
    expect(statusTone('WAIVER_REQUESTED')).toBe('warning');
    expect(statusTone('pending')).toBe('warning');
    expect(statusTone('POLICY_DELETED')).toBe('info');
    expect(statusTone('EXPIRED')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });
});

describe('statusLabel', () => {
  it('humanises API values', () => {
    expect(statusLabel('ALLOW')).toBe('Allow');
    expect(statusLabel('WAIVER_APPROVED')).toBe('Waiver approved');
    expect(statusLabel('pending')).toBe('Pending');
    expect(statusLabel('')).toBe('—');
  });
});

describe('ecosystemLabel', () => {
  it('uses the registry spelling', () => {
    expect(ecosystemLabel('pypi')).toBe('PyPI');
    expect(ecosystemLabel('nuget')).toBe('NuGet');
    expect(ecosystemLabel('unknown-eco')).toBe('unknown-eco');
    expect(ecosystemLabel(undefined)).toBe('—');
  });
});

describe('toCsv', () => {
  it('quotes separators and neutralises formulas', () => {
    const csv = toCsv(['a', 'b'], [['x,y', '=SUM(A1)'], ['say "hi"', null], [-1, 'plain']]);
    expect(csv.split('\r\n')).toEqual([
      'a,b',
      '"x,y",\'=SUM(A1)',
      '"say ""hi""",',
      '-1,plain',
    ]);
  });
});
