import { describe, it, expect } from 'vitest';
import { exceptionReason, parseFutureExpiry } from './waiver-request.js';

describe('parseFutureExpiry', () => {
  const now = Date.parse('2026-10-06T12:00:00.000Z');

  it('accepts a timestamp after now', () => {
    const d = parseFutureExpiry('2026-10-13T12:00:00.000Z', now);
    expect(d?.toISOString()).toBe('2026-10-13T12:00:00.000Z');
  });

  it('rejects a timestamp at or before now', () => {
    expect(parseFutureExpiry('2026-10-06T12:00:00.000Z', now)).toBeNull();
    expect(parseFutureExpiry('2026-10-01T12:00:00.000Z', now)).toBeNull();
  });

  it('rejects empty and unparseable values', () => {
    expect(parseFutureExpiry(undefined, now)).toBeNull();
    expect(parseFutureExpiry('   ', now)).toBeNull();
    expect(parseFutureExpiry('not-a-date', now)).toBeNull();
  });
});

describe('exceptionReason', () => {
  it('keeps the requester reason when the reviewer adds no note', () => {
    expect(exceptionReason('Needed for the release', '  ')).toBe('Needed for the release');
  });

  it('appends the reviewer note', () => {
    expect(exceptionReason('Needed for the release', 'Shorten to 3 days')).toBe(
      'Needed for the release\nApprover note: Shorten to 3 days'
    );
  });
});
