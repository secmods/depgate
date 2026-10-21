import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countDecision, dgKey, hourBucket, noteUsage, pushCounts, resetSummaryState, startSummaryPusher, stopSummaryPusher, upsertCounts, upsertUsage } from './summary.js';

/** §5.2: counts are summed in memory and sent every 5 s; usage goes through an LRU first. */

function fakeRedis() {
  const calls: string[] = [];
  const hincr: Array<[string, string, number]> = [];
  const redis = {
    status: 'ready',
    set: vi.fn(async (...args: unknown[]) => {
      calls.push(`set ${args[0]}`);
      return 'OK';
    }),
    multi: () => {
      const tx = {
        sadd: (key: string) => {
          calls.push(`sadd ${key}`);
          return tx;
        },
        expire: () => tx,
        exec: async () => [],
      };
      return tx;
    },
    pipeline: () => {
      const pipe = {
        hincrby: (key: string, field: string, n: number) => {
          hincr.push([key, field, n]);
          return pipe;
        },
        expire: () => pipe,
        exec: async () => hincr.map(() => [null, 1]),
      };
      return pipe;
    },
  };
  return { redis, calls, hincr };
}

describe('summary counts and usage (§5.2)', () => {
  beforeEach(() => resetSummaryState());
  afterEach(async () => {
    await stopSummaryPusher();
  });

  it('sums downloads in memory and sends one HINCRBY per key and hour', async () => {
    const { redis, hincr } = fakeRedis();
    const at = Date.parse('2026-10-14T10:15:00Z');
    for (let i = 0; i < 500; i += 1) countDecision('npm', 'default', 'lodash', 'ALLOW', at);
    countDecision('npm', 'default', 'lodash', 'BLOCK_ENFORCE', at);
    countDecision('npm', null, 'evil', 'BLOCK_ENFORCE', at + 3_600_000);
    await pushCounts(redis as never);
    expect(hincr).toEqual([
      [dgKey('counts:2026-10-14T10'), JSON.stringify(['npm', 'default', 'ALLOW']), 500],
      [dgKey('counts:2026-10-14T10'), JSON.stringify(['npm', 'default', 'BLOCK_ENFORCE']), 1],
      [dgKey('counts:2026-10-14T11'), JSON.stringify(['npm', null, 'BLOCK_ENFORCE']), 1],
      [dgKey('pkgcounts:2026-10-14T10'), JSON.stringify(['npm', 'lodash', 'ALLOW']), 500],
      [dgKey('pkgcounts:2026-10-14T10'), JSON.stringify(['npm', 'lodash', 'BLOCK_ENFORCE']), 1],
      [dgKey('pkgcounts:2026-10-14T11'), JSON.stringify(['npm', 'evil', 'BLOCK_ENFORCE']), 1],
    ]);
    // The sums were cleared: a second push sends nothing.
    hincr.length = 0;
    await pushCounts(redis as never);
    expect(hincr).toEqual([]);
  });

  it('hour buckets are UTC hours', () => {
    expect(hourBucket(Date.parse('2026-10-14T23:59:59.999Z'))).toBe('2026-10-14T23');
  });

  it('a repeat download within 10 minutes makes no Redis call; the first is queued once', async () => {
    const { redis, calls } = fakeRedis();
    startSummaryPusher(redis as never);
    const key = { ecosystem: 'npm', packageName: 'lodash', version: '4.17.21', repository: 'default', sourceRepository: 'npm/default', sourceType: 'public', decision: 'ALLOW' as const };
    const now = Date.now();
    noteUsage(key, now);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([`set ${dgKey(`usage:${calls[0]?.split(':').pop()}`)}`, `sadd ${dgKey('usage:pending')}`]);
    calls.length = 0;
    for (let i = 0; i < 100; i += 1) noteUsage(key, now + i * 1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    // After the LRU entry expires, one SET NX again.
    noteUsage(key, now + 601_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);
  });

  it('upserts add to the existing count and merge duplicate keys of one batch', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const manager = { query: async (sql: string, params: unknown[] = []) => void queries.push({ sql, params }) };
    await upsertCounts(manager, 'counts', new Date('2026-10-14T10:00:00Z'), [
      { key: ['npm', null, 'ALLOW'], n: 2 },
      { key: ['npm', null, 'ALLOW'], n: 3 },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('ON CONFLICT ON CONSTRAINT uq_decision_counts_hourly DO UPDATE SET count = decision_counts_hourly.count + EXCLUDED.count');
    expect(queries[0].params).toEqual([new Date('2026-10-14T10:00:00Z'), 'npm', null, 'ALLOW', 5]);
    await upsertUsage(manager, [
      { ecosystem: 'npm', packageName: 'a', version: '1', repository: null, sourceRepository: null, sourceType: null, decision: 'ALLOW', seenAt: new Date('2026-10-14T10:00:00Z') },
      { ecosystem: 'npm', packageName: 'a', version: '1', repository: null, sourceRepository: null, sourceType: null, decision: 'ALLOW', seenAt: new Date('2026-10-14T11:00:00Z') },
    ]);
    expect(queries[1].sql).toContain('ON CONFLICT ON CONSTRAINT uq_package_usage');
    expect(queries[1].params).toHaveLength(9);
    expect(queries[1].params[8]).toEqual(new Date('2026-10-14T11:00:00Z'));
  });
});
