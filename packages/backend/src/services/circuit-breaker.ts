import { config } from '../config.js';

const DEFAULT_FAILURE_THRESHOLD = 5;
/** Failures and successes older than this are forgotten. */
const DEFAULT_WINDOW_MS = 10_000;
/** Share of requests in the window that must have failed, with at least `threshold` failures. */
const DEFAULT_FAILURE_RATE = 0.5;
const TRIAL_RETRY_AFTER_MS = 1000;

type State = 'closed' | 'open' | 'half-open';

/**
 * Opens when, within the last `windowMs`, at least `threshold` requests failed and they are at least
 * `failureRate` of all requests. A short burst of connection errors on a busy remote does not open it
 * while most requests still succeed. Open for `resetMs`, then one trial request: success closes it,
 * failure opens it again. Callers record one result per request, not per retry attempt.
 */
export class CircuitBreaker {
  private state: State = 'closed';
  /** One bucket per second of the window: [second, failures, successes]. */
  private buckets: Array<[number, number, number]> = [];
  private openedAt = 0;
  private trialStartedAt = 0;
  private readonly key: string;
  private readonly threshold: number;
  private readonly resetMs: number;
  private readonly windowMs: number;
  private readonly failureRate: number;

  constructor(
    key: string,
    opts?: { threshold?: number; resetMs?: number; windowMs?: number; failureRate?: number }
  ) {
    this.key = key;
    this.threshold = opts?.threshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.resetMs = opts?.resetMs ?? config.circuitBreaker.resetMs;
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.failureRate = opts?.failureRate ?? DEFAULT_FAILURE_RATE;
  }

  getState(): State {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
      this.trialStartedAt = 0;
    }
    return this.state;
  }

  /**
   * Half-open lets one trial request through. If its result is never recorded, another trial is
   * allowed after `resetMs`.
   */
  canExecute(): boolean {
    const state = this.getState();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const now = Date.now();
    if (this.trialStartedAt && now - this.trialStartedAt < this.resetMs) return false;
    this.trialStartedAt = now;
    return true;
  }

  /**
   * How long a refused caller should wait, in ms; 0 when `canExecute` would let it through. While
   * the half-open trial is out this is at most TRIAL_RETRY_AFTER_MS: the trial usually settles in
   * far less than `resetMs`, and a success closes the breaker at once.
   */
  retryAfterMs(): number {
    const state = this.getState();
    const now = Date.now();
    if (state === 'open') return Math.max(this.resetMs - (now - this.openedAt), 0);
    if (state === 'half-open' && this.trialStartedAt) {
      return Math.min(Math.max(this.resetMs - (now - this.trialStartedAt), 0), TRIAL_RETRY_AFTER_MS);
    }
    return 0;
  }

  recordSuccess(): void {
    if (this.state !== 'closed') {
      this.reset();
      return;
    }
    this.bucket(Date.now())[2] += 1;
  }

  recordFailure(): void {
    const now = Date.now();
    const state = this.getState();
    // Late failures of requests sent before it opened do not extend the open period.
    if (state === 'open') return;
    if (state === 'half-open') {
      this.open(now);
      return;
    }
    this.bucket(now)[1] += 1;
    const { failed, succeeded } = this.totals();
    if (failed >= this.threshold && failed / (failed + succeeded) >= this.failureRate) this.open(now);
  }

  getStats(): { state: State; failures: number } {
    this.prune(Date.now());
    return { state: this.getState(), failures: this.totals().failed };
  }

  private open(now: number): void {
    this.state = 'open';
    this.openedAt = now;
    this.trialStartedAt = 0;
    this.buckets = [];
  }

  private reset(): void {
    this.state = 'closed';
    this.trialStartedAt = 0;
    this.buckets = [];
  }

  private bucket(now: number): [number, number, number] {
    this.prune(now);
    const second = Math.floor(now / 1000);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last[0] === second) return last;
    const fresh: [number, number, number] = [second, 0, 0];
    this.buckets.push(fresh);
    return fresh;
  }

  private totals(): { failed: number; succeeded: number } {
    let failed = 0;
    let succeeded = 0;
    for (const [, f, s] of this.buckets) {
      failed += f;
      succeeded += s;
    }
    return { failed, succeeded };
  }

  private prune(now: number): void {
    const oldest = Math.floor((now - this.windowMs) / 1000);
    while (this.buckets.length && this.buckets[0][0] <= oldest) this.buckets.shift();
  }
}

/** Whole seconds to put in Retry-After for an error raised because a circuit breaker was open. */
export function retryAfterSeconds(err: unknown): number | undefined {
  const value = (err as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(
  key: string,
  opts?: { threshold?: number; resetMs?: number; windowMs?: number; failureRate?: number }
): CircuitBreaker {
  let cb = breakers.get(key);
  if (!cb) {
    cb = new CircuitBreaker(key, opts);
    breakers.set(key, cb);
  }
  return cb;
}
