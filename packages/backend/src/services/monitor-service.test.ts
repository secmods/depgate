import { describe, expect, it } from 'vitest';
import { MonitorError, approvalScope, approvalSpec, parseLastSeenWithin, ruleSignature, widenSpec } from './monitor-service.js';

describe('approvalSpec', () => {
  it('lists versions as one record', () => {
    expect(approvalSpec(['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0'], 'any')).toBe(
      '=1.0.0 || =1.1.0 || =1.2.0 || =1.3.0 || =1.4.0'
    );
  });

  it('keeps * and ranges', () => {
    expect(approvalSpec(['*'], 'any')).toBe('*');
    expect(approvalSpec(['1.0.0 - 2.0.0'], 'any')).toBe('1.0.0 - 2.0.0');
  });

  it('a vulnerability approval lists versions only', () => {
    expect(() => approvalSpec(['*'], 'versions')).toThrow(MonitorError);
    expect(() => approvalSpec(['1.0.0 - 2.0.0'], 'versions')).toThrow(MonitorError);
    expect(approvalSpec(['1.0.0'], 'versions')).toBe('=1.0.0');
  });

  it('a vulnerability approval refuses wildcards and partial versions on npm', () => {
    for (const version of ['x', 'X', '1.x', '1.2.x', '1.2.*', '1', '1.2']) {
      expect(() => approvalSpec([version], 'versions', 'npm')).toThrow(MonitorError);
    }
    expect(approvalSpec(['1.2.5'], 'versions', 'npm')).toBe('=1.2.5');
    expect(approvalSpec(['1.2.5-beta.1'], 'versions', 'npm')).toBe('=1.2.5-beta.1');
    expect(approvalSpec(['dev-main'], 'versions', 'composer')).toBe('=dev-main');
  });
});

describe('widenSpec', () => {
  it('adds new versions and keeps the old ones', () => {
    expect(widenSpec('=1.0.0 || =1.1.0', '=1.1.0 || =2.0.0')).toBe('=1.0.0 || =1.1.0 || =2.0.0');
  });

  it('* wins', () => {
    expect(widenSpec('=1.0.0', '*')).toBe('*');
    expect(widenSpec('*', '=1.0.0')).toBe('*');
  });
});

describe('approvalScope', () => {
  it('follows the rule', () => {
    expect(approvalScope({ packageBlockList: ['a'] })).toBe('any');
    expect(approvalScope({ licenseAllowList: ['MIT'] })).toBe('any');
    expect(approvalScope({ cveSeverityThreshold: 'HIGH' })).toBe('versions');
    expect(approvalScope({ releaseAgeMaxHours: 24 })).toBeNull();
    expect(approvalScope({ releaseTypes: ['prerelease'] })).toBeNull();
  });
});

describe('ruleSignature', () => {
  it('ignores key order and empty values', () => {
    expect(ruleSignature({ ecosystem: ['npm'], licenseAllowList: ['MIT'] })).toBe(
      ruleSignature({ licenseAllowList: ['MIT'], ecosystem: ['npm'], licenseDenyList: [] })
    );
    expect(ruleSignature({ licenseAllowList: ['MIT'] })).not.toBe(ruleSignature({ licenseAllowList: ['MIT', 'ISC'] }));
  });
});

describe('parseLastSeenWithin', () => {
  it('reads days', () => {
    expect(parseLastSeenWithin('7d')).toBe(7);
    expect(parseLastSeenWithin('all')).toBeNull();
    expect(parseLastSeenWithin(undefined)).toBeNull();
    expect(() => parseLastSeenWithin('week')).toThrow(MonitorError);
  });
});
