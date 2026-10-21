import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, getCircuitBreaker, retryAfterSeconds } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker('test', { threshold: 3, resetMs: 100 });
  });

  it('starts closed', () => {
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('opens after threshold failures', () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(true);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canExecute()).toBe(false);
  });

  it('resets on success', () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('getCircuitBreaker returns same instance for same key', () => {
    const a = getCircuitBreaker('shared');
    const b = getCircuitBreaker('shared');
    expect(a).toBe(b);
  });
});

describe('CircuitBreaker window and trial request', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays closed while most requests still succeed', () => {
    const cb = new CircuitBreaker('busy', { threshold: 5, resetMs: 10_000 });
    for (let i = 0; i < 20; i++) cb.recordSuccess();
    for (let i = 0; i < 6; i++) cb.recordFailure();
    expect(cb.getState()).toBe('closed');
  });

  it('opens when failures reach the threshold and half of the window', () => {
    const cb = new CircuitBreaker('flaky', { threshold: 5, resetMs: 10_000 });
    for (let i = 0; i < 5; i++) cb.recordSuccess();
    for (let i = 0; i < 4; i++) cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('forgets failures older than the window', () => {
    const cb = new CircuitBreaker('slow-trickle', { threshold: 5, resetMs: 10_000, windowMs: 10_000 });
    for (let i = 0; i < 4; i++) cb.recordFailure();
    vi.advanceTimersByTime(11_000);
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    expect(cb.getStats().failures).toBe(1);
  });

  it('lets exactly one trial request through when half-open', () => {
    const cb = new CircuitBreaker('trial', { threshold: 1, resetMs: 10_000 });
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(cb.canExecute()).toBe(true);
    expect(cb.canExecute()).toBe(false);
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('opens again when the trial request fails', () => {
    const cb = new CircuitBreaker('trial-fails', { threshold: 1, resetMs: 10_000 });
    cb.recordFailure();
    vi.advanceTimersByTime(10_000);
    expect(cb.canExecute()).toBe(true);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    expect(cb.canExecute()).toBe(false);
  });

  it('allows another trial when the first never reports back', () => {
    const cb = new CircuitBreaker('trial-lost', { threshold: 1, resetMs: 10_000 });
    cb.recordFailure();
    vi.advanceTimersByTime(10_000);
    expect(cb.canExecute()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(cb.canExecute()).toBe(true);
  });

  it('does not extend the open period with late failures', () => {
    const cb = new CircuitBreaker('late', { threshold: 1, resetMs: 10_000 });
    cb.recordFailure();
    vi.advanceTimersByTime(9_000);
    cb.recordFailure();
    vi.advanceTimersByTime(1_000);
    expect(cb.canExecute()).toBe(true);
  });

  it('says how long until it lets a request through again', () => {
    const cb = new CircuitBreaker('retry-after', { threshold: 1, resetMs: 10_000 });
    expect(cb.retryAfterMs()).toBe(0);
    cb.recordFailure();
    vi.advanceTimersByTime(3_000);
    expect(cb.retryAfterMs()).toBe(7_000);
    vi.advanceTimersByTime(7_000);
    expect(cb.retryAfterMs()).toBe(0);
    // The trial request is out: a short wait, since it usually settles quickly.
    expect(cb.canExecute()).toBe(true);
    vi.advanceTimersByTime(4_000);
    expect(cb.retryAfterMs()).toBe(1_000);
    vi.advanceTimersByTime(5_500);
    expect(cb.retryAfterMs()).toBe(500);
  });
});

describe('retryAfterSeconds', () => {
  it('reads the seconds an open-breaker error carries, and nothing from other errors', () => {
    expect(retryAfterSeconds(Object.assign(new Error('open'), { retryAfterSeconds: 4 }))).toBe(4);
    expect(retryAfterSeconds(new Error('timed out'))).toBeUndefined();
    expect(retryAfterSeconds(Object.assign(new Error('done'), { retryAfterSeconds: 0 }))).toBeUndefined();
    expect(retryAfterSeconds(null)).toBeUndefined();
  });
});
