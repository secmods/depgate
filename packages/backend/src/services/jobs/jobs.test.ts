import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { jobIds, recheckJobId, runNowJobId, scrubError, uuidv7, webhookJobId } from './ids.js';
import {
  enqueue,
  isFinalFailure,
  logFailure,
  parseWorkerSetting,
  queueSpec,
  retryDelay,
  RetryLaterError,
} from './queue.js';
import { jobsFailedTotal, jobsFallbackTotal } from './metrics.js';
import { buildRequest, classifyResponse, parseRetryAfter } from '../webhook-delivery.js';

async function counter(metric: typeof jobsFailedTotal, labels: Record<string, string>): Promise<number> {
  const values = (await metric.get()).values;
  return values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;
}

describe('job IDs', () => {
  it('uuidv7 is a valid, time-ordered UUID', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('never contains ":" (BullMQ refuses it) and is stable per input', () => {
    for (const id of [webhookJobId('d1'), runNowJobId('malicious-feed-sync'), recheckJobId('p1', 't1')]) {
      expect(id).not.toContain(':');
    }
    expect(webhookJobId('d1')).toBe(webhookJobId('d1'));
    expect(runNowJobId('namespace-collision-check')).toBe('run-namespace-collision-check');
  });

  it('logs only the IDs of job data, and scrubs credentials from errors', () => {
    expect(jobIds({ deliveryId: 'd', targetId: 't', payload: { secret: 'x' }, email: 'a@b.c' })).toEqual({ deliveryId: 'd', targetId: 't' });
    expect(scrubError('connect https://user:hunter2@hooks.example/x failed')).toBe('connect https://***@hooks.example/x failed');
    expect(scrubError('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(scrubError('x'.repeat(900))).toHaveLength(500);
  });
});

describe('webhook delivery rules', () => {
  it('classifies HTTP statuses: 2xx delivered; 408, 425, 429, 5xx retried; other 4xx final', () => {
    expect(classifyResponse(204).kind).toBe('delivered');
    for (const status of [408, 425, 429, 500, 502, 503]) expect(classifyResponse(status).kind, String(status)).toBe('retry');
    for (const status of [400, 401, 403, 404, 410, 422]) expect(classifyResponse(status).kind, String(status)).toBe('fail');
  });

  it('honours Retry-After in seconds or as a date, capped at 1 hour', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Mon, 12 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('86400', now)).toBe(3_600_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(classifyResponse(429, '7')).toMatchObject({ kind: 'retry', retryAfterMs: 7000 });
    expect(retryDelay('webhooks', 1, new RetryLaterError('HTTP 429', 7000))).toBe(7000);
  });

  it('backs off exponentially when the receiver gives no Retry-After', () => {
    const spec = queueSpec('webhooks');
    expect(retryDelay('webhooks', 1)).toBe(spec.backoff(1));
    expect(retryDelay('webhooks', 3)).toBe(spec.backoff(1) * 4);
  });

  it('signs the body including the event id and attempt, and sends both as headers', () => {
    const request = buildRequest({ secret: 's3cret' }, { event: 'package_blocked', packageName: 'lodash' }, 'evt-1', 2);
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({ event: 'package_blocked', id: 'evt-1', attempt: 2 });
    expect(request.headers['X-DepGate-Event-Id']).toBe('evt-1');
    expect(request.headers['X-DepGate-Delivery-Attempt']).toBe('2');
    const expected = crypto.createHmac('sha256', 's3cret').update(request.body).digest('hex');
    expect(request.headers['X-DepGate-Signature']).toBe(`sha256=${expected}`);
    expect(buildRequest({ secret: null }, {}, 'e', 1).headers['X-DepGate-Signature']).toBeUndefined();
  });
});

describe('queue behaviour', () => {
  it('a final failure is attempts used up, or an unrecoverable error', () => {
    const job = (attemptsMade: number) => ({ attemptsMade, opts: { attempts: 3 } });
    expect(isFinalFailure(job(1), new Error('x'))).toBe(false);
    expect(isFinalFailure(job(3), new Error('x'))).toBe(true);
    const unrecoverable = Object.assign(new Error('HTTP 400'), { name: 'UnrecoverableError' });
    expect(isFinalFailure(job(1), unrecoverable)).toBe(true);
  });

  it('WORKERS picks the queues a replica works on', () => {
    expect([...parseWorkerSetting('all')]).toEqual(['webhooks', 'scheduled', 'email', 'monitor']);
    expect(parseWorkerSetting('none').size).toBe(0);
    expect([...parseWorkerSetting('webhooks, scheduled, bogus')]).toEqual(['webhooks', 'scheduled']);
  });

  it('enqueue answers null (fall back in-process) when the queues are not running, and counts it', async () => {
    const before = await counter(jobsFallbackTotal, { queue: 'webhooks' });
    expect(await enqueue('webhooks', 'deliver', { deliveryId: 'd' })).toBeNull();
    expect(await counter(jobsFallbackTotal, { queue: 'webhooks' })).toBe(before + 1);
  });

  it('logs a retried attempt at warn and a final failure at error, with the job fields and no secret', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const job = {
      name: 'deliver',
      id: 'wh-d1',
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { deliveryId: 'd1', targetId: 't1', token: 'not-logged' },
    };
    const err = new Error('connect to https://bob:pw@hooks.example failed');
    const beforeRetry = await counter(jobsFailedTotal, { queue: 'webhooks', job: 'deliver', final: 'false' });
    logFailure(log, 'webhooks', job as never, err);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'webhooks', job: 'deliver', jobId: 'wh-d1', attempt: 1, maxAttempts: 3, deliveryId: 'd1', targetId: 't1', retryInMs: expect.any(Number) }),
      'Job attempt failed; retrying'
    );
    expect(JSON.stringify(log.warn.mock.calls[0][0])).not.toContain('pw@');
    expect(JSON.stringify(log.warn.mock.calls[0][0])).not.toContain('not-logged');
    expect(await counter(jobsFailedTotal, { queue: 'webhooks', job: 'deliver', final: 'false' })).toBe(beforeRetry + 1);

    logFailure(log, 'webhooks', { ...job, attemptsMade: 3 } as never, err);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3, maxAttempts: 3 }), 'Job failed');
  });

  it('every queue removes completed jobs and keeps failed ones 7 days, at most 500', async () => {
    const { defaultJobOptions, QUEUE_NAMES } = await import('./queue.js');
    for (const name of QUEUE_NAMES) {
      expect(defaultJobOptions(name)).toMatchObject({ removeOnComplete: true, removeOnFail: { age: 7 * 86_400, count: 500 } });
    }
  });
});
