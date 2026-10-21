import { describe, expect, it } from 'vitest';
import { formatMaliciousSyncAudit, isSyncInProgress, SYNC_STALE_MS, syncModeLabel } from './malicious-sync-status.js';

describe('isSyncInProgress', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  it('is running when the claim is fresh', () => {
    expect(isSyncInProgress('running', '2026-10-02T11:00:00Z', now)).toBe(true);
  });

  it('is not running after the stale window', () => {
    const started = new Date(now - SYNC_STALE_MS - 1).toISOString();
    expect(isSyncInProgress('running', started, now)).toBe(false);
  });

  it('is not running when the last run finished', () => {
    expect(isSyncInProgress('completed', '2026-10-02T11:00:00Z', now)).toBe(false);
    expect(isSyncInProgress('failed', null, now)).toBe(false);
    expect(isSyncInProgress('idle', null, now)).toBe(false);
  });
});

describe('formatMaliciousSyncAudit', () => {
  it('records the mode and both watermarks', () => {
    expect(
      formatMaliciousSyncAudit({
        trigger: 'manual',
        mode: 'changes',
        watermarkBefore: '2026-10-02T05:00:00Z',
        watermarkAfter: '2026-10-02T08:00:00Z',
        added: 2,
        updated: 1,
        removed: 1,
        total: 221857,
      })
    ).toEqual([
      'Trigger: manual',
      'Mode: changes',
      'Watermark before: 2026-10-02T05:00:00Z',
      'Watermark after: 2026-10-02T08:00:00Z',
      'Added: 2',
      'Updated: 1',
      'Removed: 1',
      'Tracked packages: 221857',
    ]);
  });

  it('records a failure without a mode', () => {
    const lines = formatMaliciousSyncAudit({
      trigger: 'scheduled',
      watermarkBefore: null,
      watermarkAfter: null,
      error: 'sha256 does not match',
    });
    expect(lines).toContain('Trigger: scheduled');
    expect(lines).toContain('Mode: unknown');
    expect(lines).toContain('Watermark before: none');
    expect(lines).toContain('Watermark after: unchanged');
    expect(lines).toContain('Error: sha256 does not match');
  });

  it('labels modes for the audit table', () => {
    expect(syncModeLabel('full')).toBe('full sync');
    expect(syncModeLabel('changes')).toBe('changes sync');
    expect(syncModeLabel('none')).toBe('no changes');
  });
});
