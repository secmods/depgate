import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  fetchFromUpstream,
  fetchStreamFromUpstream,
  probeServingRemote,
  resetUnavailableLog,
  sendUpstreamFailure,
  UpstreamUnavailableError,
} from './upstream-provider.js';
import { compareAllOrder, type RemoteTarget } from './repository-resolve.js';
import { getCircuitBreaker } from './circuit-breaker.js';
import { fakeEventDb } from '../test-support/event-db.js';
import { allScopeError, exceptionCovers, policyCovers, scopeContext } from './repository-scope.js';

/**
 * Repository security R1 (stop on errors), R2 (order of `all`) and R5 (scope follows the serving
 * remote). See requirements_repository_security.md.
 */

function target(id: string, key: string, url: string, source: 'public' | 'internal' = 'public'): RemoteTarget {
  return { id, key, url, timeoutMs: 500, retryCount: 0, authType: null, authEncrypted: null, source };
}

const PRIVATE = target('11111111-1111-4111-8111-111111111111', 'acme-private', 'https://private.test/npm', 'internal');
const PUBLIC = target('22222222-2222-4222-8222-222222222222', 'default', 'https://public.test/npm');

const events = fakeEventDb();
const db: DataSource = events.db;

describe('R1: a virtual repository stops at a failing remote', () => {
  const originalFetch = global.fetch;
  let asked: string[];

  beforeEach(async () => {
    asked = [];
    await events.flush();
    events.ledger.length = 0;
    resetUnavailableLog();
    for (const remote of [PRIVATE, PUBLIC]) getCircuitBreaker(`upstream:${remote.id}`).recordSuccess();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function upstream(behaviour: Record<string, 'error' | number>) {
    global.fetch = (async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const host = new URL(url).hostname;
      const action = behaviour[host] ?? 200;
      if (action === 'error') throw new Error('connect ECONNREFUSED');
      return new Response(JSON.stringify({ from: host }), { status: action, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  it('moves on after a 404 (the package is not on the first remote)', async () => {
    upstream({ 'private.test': 404 });
    const result = await fetchFromUpstream(db, 'npm', 'lodash', { targets: [PRIVATE, PUBLIC] });
    expect(result.status).toBe(200);
    expect(result.source?.key).toBe('default');
  });

  it('does not ask the next remote when the first fails (metadata)', async () => {
    upstream({ 'private.test': 'error' });
    await expect(fetchFromUpstream(db, 'npm', '@acme/billing', { targets: [PRIVATE, PUBLIC] })).rejects.toBeInstanceOf(
      UpstreamUnavailableError
    );
    expect(asked.some((url) => url.includes('public.test'))).toBe(false);
  });

  it('does not ask the next remote when the first fails (download)', async () => {
    upstream({ 'private.test': 'error' });
    const error = await fetchStreamFromUpstream(db, 'npm', '@acme/billing/-/billing-1.0.0.tgz', {
      targets: [PRIVATE, PUBLIC],
    }).catch((err) => err);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as Error).message).toContain('npm/acme-private');
    expect(asked.some((url) => url.includes('public.test'))).toBe(false);
  });

  it('treats an open circuit breaker as a failure, not a reason to skip the remote', async () => {
    upstream({});
    const breaker = getCircuitBreaker(`upstream:${PRIVATE.id}`);
    for (let i = 0; i < 20; i += 1) breaker.recordFailure();
    await expect(fetchFromUpstream(db, 'npm', '@acme/billing', { targets: [PRIVATE, PUBLIC] })).rejects.toThrow(
      /circuit breaker open/
    );
    expect(asked).toEqual([]);
    breaker.recordSuccess();
  });

  it('answers an open breaker with 503 and Retry-After, and other failures with 502', async () => {
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const log = { debug: vi.fn(), error: vi.fn() };
    const reply = {
      log,
      header(name: string, value: string) {
        sent.headers[name] = value;
        return this;
      },
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return this;
      },
    };

    upstream({ 'private.test': 'error' });
    const failed = await fetchFromUpstream(db, 'npm', '@acme/billing', { targets: [PRIVATE, PUBLIC] }).catch((err) => err);
    sendUpstreamFailure(reply as never, failed, 'Failed to fetch packument');
    expect(sent.status).toBe(502);
    expect(sent.headers).toEqual({});
    expect(log.error).toHaveBeenCalledWith(failed, 'Failed to fetch packument');

    log.error.mockClear();
    const breaker = getCircuitBreaker(`upstream:${PRIVATE.id}`);
    for (let i = 0; i < 20; i += 1) breaker.recordFailure();
    const open = await fetchFromUpstream(db, 'npm', '@acme/billing', { targets: [PRIVATE, PUBLIC] }).catch((err) => err);
    sendUpstreamFailure(reply as never, open, 'Failed to fetch packument');
    expect(sent.status).toBe(503);
    expect(Number(sent.headers['Retry-After'])).toBeGreaterThan(0);
    expect(sent.body).toEqual({ error: expect.stringContaining('circuit breaker open') });
    // The refusal repeats for every request until the breaker closes: no error line, no stack.
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith({ reason: expect.stringContaining('circuit breaker open') }, 'Failed to fetch packument');
    breaker.recordSuccess();
  });

  it('returns a 5xx answer as it is instead of trying the next remote', async () => {
    upstream({ 'private.test': 503 });
    const result = await fetchFromUpstream(db, 'npm', '@acme/billing', { targets: [PRIVATE, PUBLIC] });
    expect(result.status).toBe(503);
    expect(asked.some((url) => url.includes('public.test'))).toBe(false);
  });

  it('writes one ledger row per failing remote per minute', async () => {
    upstream({ 'private.test': 'error' });
    for (let i = 0; i < 3; i += 1) {
      await fetchFromUpstream(db, 'npm', 'x', { targets: [PRIVATE, PUBLIC] }).catch(() => undefined);
    }
    await events.flush();
    const rows = events.ledger.filter((row) => row.decision === 'UPSTREAM_UNAVAILABLE');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ecosystem: 'npm', packageName: 'acme-private' });
  });

  it('probes remotes in order and reports the first that has the file', async () => {
    upstream({ 'private.test': 404 });
    expect((await probeServingRemote(db, 'npm', 'lodash/-/lodash-1.0.0.tgz', [PRIVATE, PUBLIC]))?.key).toBe('default');
    upstream({});
    expect((await probeServingRemote(db, 'npm', 'x', [PRIVATE, PUBLIC]))?.key).toBe('acme-private');
    upstream({ 'private.test': 404, 'public.test': 404 });
    expect(await probeServingRemote(db, 'npm', 'x', [PRIVATE, PUBLIC])).toBeNull();
  });

  it('a probe stops at a failing remote too', async () => {
    upstream({ 'private.test': 'error' });
    await expect(probeServingRemote(db, 'npm', 'x', [PRIVATE, PUBLIC])).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(asked.some((url) => url.includes('public.test'))).toBe(false);
  });
});

describe('R2: order of all', () => {
  it('saved positions first, then the remotes nobody placed, by key', () => {
    const rows = [
      { key: 'zz-new', allPosition: null },
      { key: 'default', allPosition: 1 },
      { key: 'acme-private', allPosition: 0 },
      { key: 'beta', allPosition: null },
    ];
    expect([...rows].sort(compareAllOrder).map((row) => row.key)).toEqual(['acme-private', 'default', 'beta', 'zz-new']);
  });

  it('with no saved positions keeps the order before R2: by key', () => {
    const rows = [
      { key: 'default', allPosition: null },
      { key: 'acme-private', allPosition: null },
    ];
    expect([...rows].sort(compareAllOrder).map((row) => row.key)).toEqual(['acme-private', 'default']);
  });
});

describe('R5: policies follow the serving remote', () => {
  const ALL = 'all-id';
  const scopeOf = (...ids: string[]) => new Set(ids);

  it('a policy on a remote covers it through a virtual repository when that remote serves', () => {
    const ctx = { requestId: ALL, sourceId: PUBLIC.id, memberIds: [PRIVATE.id, PUBLIC.id] };
    expect(policyCovers(scopeOf(PUBLIC.id), ctx)).toBe(true);
    expect(policyCovers(scopeOf(PRIVATE.id), ctx)).toBe(false);
    expect(policyCovers(null, ctx)).toBe(true);
  });

  it('an unknown serving remote never skips a policy on a member, and never applies an exception on one', () => {
    const ctx = { requestId: ALL, sourceId: null, memberIds: [PRIVATE.id, PUBLIC.id] };
    expect(policyCovers(scopeOf(PRIVATE.id), ctx)).toBe(true);
    expect(exceptionCovers(scopeOf(PRIVATE.id), ctx)).toBe(false);
    expect(policyCovers(scopeOf('elsewhere'), ctx)).toBe(false);
  });

  it('a custom virtual repository named in the scope covers everything through it', () => {
    const ctx = { requestId: 'frontend', sourceId: PRIVATE.id, memberIds: [PRIVATE.id, PUBLIC.id] };
    expect(policyCovers(scopeOf('frontend'), ctx)).toBe(true);
    expect(exceptionCovers(scopeOf('frontend'), ctx)).toBe(true);
  });

  it('looks up the serving remote only when a scope names a member but not the URL repository', async () => {
    const servingSource = vi.fn(async () => PUBLIC);
    const requestId = async () => ALL;
    await scopeContext([null, scopeOf(ALL)], requestId, [PRIVATE, PUBLIC], servingSource);
    expect(servingSource).not.toHaveBeenCalled();
    const ctx = await scopeContext([scopeOf(PUBLIC.id)], requestId, [PRIVATE, PUBLIC], servingSource);
    expect(servingSource).toHaveBeenCalledTimes(1);
    expect(ctx.sourceId).toBe(PUBLIC.id);
  });

  it('a repository with one remote is served by it without a lookup', async () => {
    const servingSource = vi.fn(async () => null);
    const ctx = await scopeContext([scopeOf(PUBLIC.id)], async () => 'frontend', [PUBLIC], servingSource);
    expect(servingSource).not.toHaveBeenCalled();
    expect(ctx.sourceId).toBe(PUBLIC.id);
  });

  it('`all` cannot be a scope', () => {
    expect(allScopeError([{ id: 'x', ecosystem: 'npm', key: 'all', type: 'virtual' }])).toMatch(
      /npm\/all cannot be chosen.*All repositories instead/
    );
    expect(allScopeError([{ id: 'y', ecosystem: 'npm', key: 'frontend', type: 'virtual' }])).toBeNull();
  });
});
