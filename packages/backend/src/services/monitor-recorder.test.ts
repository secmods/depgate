import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import { recordMonitorMatches } from './monitor-recorder.js';
import { monitorRecordErrorsTotal } from './monitor-metrics.js';
import type { MonitorMatch } from './policy-engine.js';

/** A database whose rows live in a map, keyed like the unique index. */
function fakeDb(options: { failWith?: Error } = {}) {
  const rows = new Map<string, number>();
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (options.failWith) throw options.failWith;
    const key = (params as string[]).slice(0, 4).join('|');
    if (sql.trimStart().startsWith('UPDATE')) {
      if (!rows.has(key)) return [[], 0];
      rows.set(key, rows.get(key)! + Number(params[4]));
      return [[{ id: key }], 1];
    }
    if (sql.trimStart().startsWith('INSERT')) {
      rows.set(key, (rows.get(key) ?? 0) + Number(params[4]));
      return [{ id: key }];
    }
    return [{ '?column?': 1 }];
  });
  return { db: { query } as never, rows, query };
}

const match: MonitorMatch = { policyId: 'p1', policyName: 'License', reasons: ['GPL'], reasonKey: 'GPL-3.0', modeEpoch: 1 };
const KEY = 'p1|npm|acme|1.0.0';

describe('recordMonitorMatches', () => {
  beforeEach(() => vi.useRealTimers());

  it('writes the first download, then only counts in Redis until the window ends', async () => {
    const redis = createMemoryRedis();
    const { db, rows, query } = fakeDb();
    await recordMonitorMatches(db, redis as never, 'npm', 'acme', '1.0.0', [match]);
    expect(rows.get(KEY)).toBe(1);
    const writes = query.mock.calls.length;

    await recordMonitorMatches(db, redis as never, 'npm', 'acme', '1.0.0', [match]);
    expect(query.mock.calls.length).toBe(writes);
    expect(rows.get(KEY)).toBe(1);

    // The gate expires: the next download folds the counted one in.
    for (const key of [...redis.data.keys()]) if (key.startsWith('monitor:gate:')) await redis.del(key);
    await recordMonitorMatches(db, redis as never, 'npm', 'acme', '1.0.0', [match]);
    expect(rows.get(KEY)).toBe(3);
    const counter = [...redis.data.entries()].find(([key]) => key.startsWith('monitor:count:'));
    expect(counter?.[1]).toEqual({ kind: 'string', value: '0' });
  });

  it('writes every match when there is no Redis', async () => {
    const { db, rows } = fakeDb();
    await recordMonitorMatches(db, null, 'npm', 'acme', '1.0.0', [match]);
    await recordMonitorMatches(db, null, 'npm', 'acme', '1.0.0', [match]);
    expect(rows.get(KEY)).toBe(2);
  });

  it('counts a failed write instead of throwing', async () => {
    const before = (await monitorRecordErrorsTotal.get()).values[0]?.value ?? 0;
    const { db } = fakeDb({ failWith: new Error('db down') });
    const warn = vi.fn();
    await expect(recordMonitorMatches(db, null, 'npm', 'acme', '1.0.0', [match], { warn })).resolves.toBeUndefined();
    const after = (await monitorRecordErrorsTotal.get()).values[0]?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('makes no calls without matches', async () => {
    const redis = createMemoryRedis();
    const { db, query } = fakeDb();
    await recordMonitorMatches(db, redis as never, 'npm', 'acme', '1.0.0', []);
    expect(query).not.toHaveBeenCalled();
    expect(redis.calls).toEqual([]);
  });
});
