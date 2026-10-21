import { describe, it, expect, vi } from 'vitest';
import { touchApiKey } from './auth.js';

function fakeDb() {
  const update = vi.fn().mockResolvedValue(undefined);
  return { update, db: { getRepository: () => ({ update }) } as never };
}

describe('touchApiKey', () => {
  it('records the first use', () => {
    const { db, update } = fakeDb();
    const key = { id: 'k1', lastUsedAt: null } as never;
    const now = new Date('2026-10-10T10:00:00Z');
    touchApiKey(db, key, now);
    expect(update).toHaveBeenCalledWith({ id: 'k1' }, { lastUsedAt: now });
  });

  it('does not write again within a minute, then writes after it', () => {
    const { db, update } = fakeDb();
    const key = { id: 'k1', lastUsedAt: null } as { id: string; lastUsedAt: Date | null };
    touchApiKey(db, key as never, new Date('2026-10-10T10:00:00Z'));
    touchApiKey(db, key as never, new Date('2026-10-10T10:00:30Z'));
    expect(update).toHaveBeenCalledTimes(1);
    touchApiKey(db, key as never, new Date('2026-10-10T10:01:05Z'));
    expect(update).toHaveBeenCalledTimes(2);
  });
});
