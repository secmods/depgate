import { describe, expect, it } from 'vitest';
import { parseCiTokenName, parseExpiresIn, parseMetadata } from './ci-token.js';

describe('parseExpiresIn', () => {
  it('accepts minutes, hours, and one day', () => {
    expect(parseExpiresIn('30m')).toBe(30 * 60_000);
    expect(parseExpiresIn('2h')).toBe(2 * 3_600_000);
    expect(parseExpiresIn('24h')).toBe(24 * 3_600_000);
    expect(parseExpiresIn('1d')).toBe(86_400_000);
  });

  it('rejects missing, zero, and anything over one day', () => {
    expect(parseExpiresIn(undefined)).toBeNull();
    expect(parseExpiresIn('0h')).toBeNull();
    expect(parseExpiresIn('25h')).toBeNull();
    expect(parseExpiresIn('2d')).toBeNull();
    expect(parseExpiresIn('7d')).toBeNull();
    expect(parseExpiresIn('2 hours')).toBeNull();
  });
});

describe('parseMetadata', () => {
  it('keeps a flat string map', () => {
    expect(parseMetadata({ pr_number: '4821', build_number: '9102' })).toEqual({
      metadata: { pr_number: '4821', build_number: '9102' },
    });
  });

  it('rejects nested values, reserved keys, and too many pairs', () => {
    expect(parseMetadata({ build: { id: '1' } })).toEqual({ error: 'invalid metadata value for build' });
    expect(parseMetadata({ role: 'Admin' })).toEqual({ error: 'invalid metadata key: role' });
    const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(parseMetadata(tooMany)).toEqual({ error: 'metadata accepts at most 20 pairs' });
  });
});

describe('parseCiTokenName', () => {
  it('accepts a pipeline name and rejects an empty one', () => {
    expect(parseCiTokenName(' github-actions ')).toBe('github-actions');
    expect(parseCiTokenName('')).toBeNull();
  });
});
