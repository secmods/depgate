import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import {
  ReferenceCacheSubscriber,
  bindReferencePublisher,
  bumpReference,
  readReference,
  readReferenceEntry,
  referenceKindsFor,
  resetReferenceCache,
} from './reference-cache.js';
import { config } from '../config.js';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
    publish: async () => 1,
  };
}

const policiesTable = { tableName: 'policies' };

describe('reference cache', () => {
  afterEach(() => {
    vi.useRealTimers();
    bindReferencePublisher(null);
    resetReferenceCache();
  });

  it('reloads when the generation changes and skips Postgres while it matches', async () => {
    bindReferencePublisher(fakeRedis() as never);
    let loads = 0;
    const load = async () => ++loads;

    expect(await readReference('policies', load)).toBe(1);
    expect(await readReference('policies', load)).toBe(1);
    await bumpReference('policies');
    expect(await readReference('policies', load)).toBe(2);
    expect(loads).toBe(2);
  });

  it('verify sees a bump from another replica at once, without waiting for its message', async () => {
    const redis = fakeRedis();
    bindReferencePublisher(redis as never);
    let loads = 0;
    const load = async () => ++loads;

    expect(await readReference('policies', load)).toBe(1);
    // Another replica saved a policy: the generation moved, but no pub/sub message arrived here.
    await redis.incr('depgate:gen:policies');
    expect(await readReference('policies', load)).toBe(1);
    expect(await readReference('policies', load, { verify: true })).toBe(2);
    expect(await readReference('policies', load, { verify: true })).toBe(2);
    expect(loads).toBe(2);
  });

  it('is registered with TypeORM, which ignores undecorated subscriber classes', () => {
    expect(getMetadataArgsStorage().filterSubscribers([ReferenceCacheSubscriber])).toHaveLength(1);
  });

  it('holds a bump made inside a transaction until the commit', async () => {
    const redis = fakeRedis();
    bindReferencePublisher(redis as never);
    const subscriber = new ReferenceCacheSubscriber();
    const runner = { isTransactionActive: true };

    await subscriber.afterUpdate({ metadata: policiesTable, queryRunner: runner } as never);
    expect(redis.store.get('depgate:gen:policies')).toBeUndefined();

    // A savepoint release fires the commit event while the outer transaction is still open.
    await subscriber.afterTransactionCommit({ queryRunner: runner } as never);
    expect(redis.store.get('depgate:gen:policies')).toBeUndefined();

    runner.isTransactionActive = false;
    await subscriber.afterTransactionCommit({ queryRunner: runner } as never);
    expect(redis.store.get('depgate:gen:policies')).toBe('1');
  });

  it('drops a pending bump when the transaction rolls back', async () => {
    const redis = fakeRedis();
    bindReferencePublisher(redis as never);
    const subscriber = new ReferenceCacheSubscriber();
    const runner = { isTransactionActive: true };

    await subscriber.afterInsert({ metadata: policiesTable, queryRunner: runner } as never);
    runner.isTransactionActive = false;
    subscriber.afterTransactionRollback({ queryRunner: runner } as never);
    await subscriber.afterTransactionCommit({ queryRunner: runner } as never);
    expect(redis.store.get('depgate:gen:policies')).toBeUndefined();
  });

  it('bumps at once when the write is not inside a transaction', async () => {
    const redis = fakeRedis();
    bindReferencePublisher(redis as never);
    await new ReferenceCacheSubscriber().afterRemove({ metadata: policiesTable, queryRunner: null } as never);
    expect(redis.store.get('depgate:gen:policies')).toBe('1');
  });

  it('reloads after the maximum age even when no bump was seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    bindReferencePublisher(fakeRedis() as never);
    let loads = 0;
    const load = async () => ++loads;

    await readReference('policies', load);
    vi.setSystemTime(Date.now() + config.gateway.referenceMaxAgeMs - 1000);
    await readReference('policies', load);
    expect(loads).toBe(1);

    vi.setSystemTime(Date.now() + 2000);
    await readReference('policies', load);
    expect(loads).toBe(2);
  });
});

describe('reference entries', () => {
  afterEach(() => {
    bindReferencePublisher(null);
    resetReferenceCache();
  });

  it('loads each key once until the kind is bumped', async () => {
    bindReferencePublisher(fakeRedis() as never);
    const loads: string[] = [];
    const load = (key: string) => async () => {
      loads.push(key);
      return `${key}:${loads.length}`;
    };

    expect(await readReferenceEntry('malicious', 'a', load('a'))).toBe('a:1');
    expect(await readReferenceEntry('malicious', 'a', load('a'))).toBe('a:1');
    expect(await readReferenceEntry('malicious', 'b', load('b'))).toBe('b:2');
    await bumpReference('malicious');
    expect(await readReferenceEntry('malicious', 'a', load('a'))).toBe('a:3');
    expect(loads).toEqual(['a', 'b', 'a']);
  });

  it('shares one load between concurrent misses and does not keep a failure', async () => {
    bindReferencePublisher(fakeRedis() as never);
    await readReferenceEntry('exceptions', 'npm\0other', async () => 'warm');
    let loads = 0;
    const failing = async () => {
      loads += 1;
      throw new Error('database down');
    };

    const results = await Promise.allSettled([
      readReferenceEntry('exceptions', 'npm\0left-pad', failing),
      readReferenceEntry('exceptions', 'npm\0left-pad', failing),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(loads).toBe(1);
    expect(await readReferenceEntry('exceptions', 'npm\0left-pad', async () => 'ok')).toBe('ok');
  });

  it('loads again when a kept value is no longer valid', async () => {
    bindReferencePublisher(fakeRedis() as never);
    let loads = 0;
    let expired = false;
    const load = async () => ++loads;
    const opts = { isValid: () => !expired };

    expect(await readReferenceEntry('exceptions', 'k', load, opts)).toBe(1);
    expect(await readReferenceEntry('exceptions', 'k', load, opts)).toBe(1);
    expired = true;
    expect(await readReferenceEntry('exceptions', 'k', load, opts)).toBe(2);
  });

  it('keeps nothing without Redis', async () => {
    let loads = 0;
    const load = async () => ++loads;
    await readReferenceEntry('malicious', 'a', load);
    await readReferenceEntry('malicious', 'a', load);
    expect(loads).toBe(2);
  });

  it('bumps exceptions with policies, whose deletion removes their exceptions', () => {
    expect(referenceKindsFor('policies')).toEqual(['policies', 'exceptions']);
    expect(referenceKindsFor('exceptions')).toEqual(['exceptions']);
    expect(referenceKindsFor('malicious_packages')).toEqual(['malicious']);
  });
});
