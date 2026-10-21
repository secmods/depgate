import crypto from 'node:crypto';
import type { DataSource } from 'typeorm';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { In, MoreThan } from 'typeorm';
import { WebhookTarget } from '../db/entities/WebhookTarget.js';
import { WebhookDelivery } from '../db/entities/WebhookDelivery.js';
import { config } from '../config.js';
import { bumpReference } from './reference-cache.js';
import { logAudit } from './audit-service.js';
import { enqueue, jobsRedis, queuePrefix, registerHandler, retryDelay, RetryLaterError } from './jobs/queue.js';
import { scrubError, uuidv7, webhookJobId } from './jobs/ids.js';
import { readReference } from './reference-cache.js';
import { dgKey } from './events/summary.js';

/**
 * Webhook delivery (requirements_job_queue.md §6): one `deliver` job per event and webhook,
 * retried with backoff, recorded in `webhook_deliveries`. A webhook whose deliveries keep failing
 * is disabled after WEBHOOK_DISABLE_AFTER_FAILURES of them in a row.
 */

export type DeliveryOutcome =
  | { kind: 'delivered'; statusCode: number }
  | { kind: 'retry'; statusCode: number | null; error: string; retryAfterMs?: number }
  | { kind: 'fail'; statusCode: number | null; error: string };

const MAX_RETRY_AFTER_MS = 3_600_000;
/** Requests per second to one receiver host, across the cluster. */
const HOST_RATE_PER_SECOND = 5;

/** `Retry-After` as seconds or an HTTP date, in ms from now, capped at 1 hour. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/** 2xx delivered. Timeouts, connection errors, 408, 425, 429 and 5xx are retried. Other 4xx: the receiver said no. */
export function classifyResponse(status: number, retryAfter?: string | null): DeliveryOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered', statusCode: status };
  const error = `HTTP ${status}`;
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'retry', statusCode: status, error, retryAfterMs: parseRetryAfter(retryAfter) };
  }
  return { kind: 'fail', statusCode: status, error };
}

export function signPayload(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** The body and headers of one attempt. `id` and `attempt` are part of the signed body. */
export function buildRequest(
  target: Pick<WebhookTarget, 'secret'>,
  payload: Record<string, unknown>,
  eventId: string,
  attempt: number
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({ ...payload, id: eventId, attempt });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-DepGate-Event-Id': eventId,
    'X-DepGate-Delivery-Attempt': String(attempt),
  };
  const secret = target.secret ?? '';
  if (secret) headers['X-DepGate-Signature'] = `sha256=${signPayload(secret, body)}`;
  return { body, headers };
}

export async function postWebhook(
  url: string,
  request: { body: string; headers: Record<string, string> }
): Promise<DeliveryOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(config.gateway.webhookTimeoutMs),
    });
    // The body is not kept: a receiver's answer may hold anything.
    await res.body?.cancel().catch(() => undefined);
    return classifyResponse(res.status, res.headers.get('retry-after'));
  } catch (err) {
    const message = err instanceof Error ? (err.name === 'TimeoutError' ? 'Timed out' : err.message) : String(err);
    return { kind: 'retry', statusCode: null, error: scrubError(message) };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

/** Whether this second's budget for the host is spent. Fails open: a Redis hiccup never stops delivery. */
async function overHostLimit(host: string): Promise<boolean> {
  const redis = jobsRedis();
  if (!redis) return false;
  const key = `${queuePrefix()}:whrl:${host}:${Math.floor(Date.now() / 1000)}`;
  try {
    const replies = await redis.multi().incr(key).expire(key, 2).exec();
    return Number(replies?.[0]?.[1] ?? 0) > HOST_RATE_PER_SECOND;
  } catch {
    return false;
  }
}

async function markDelivered(db: DataSource, delivery: WebhookDelivery, attempt: number, statusCode: number): Promise<void> {
  await db.getRepository(WebhookDelivery).update(
    { id: delivery.id },
    { status: 'delivered', attempts: attempt, lastStatusCode: statusCode, lastError: null, deliveredAt: new Date(), nextAttemptAt: null }
  );
  await db.query(
    `UPDATE webhook_targets SET consecutive_failures = 0, last_error = NULL WHERE id = $1 AND consecutive_failures <> 0`,
    [delivery.targetId]
  );
}

/** A delivery that failed for good: counted against the webhook, which is disabled at the threshold. */
async function markFailed(db: DataSource, delivery: WebhookDelivery, attempt: number, outcome: DeliveryOutcome & { kind: 'retry' | 'fail' }): Promise<void> {
  await db.getRepository(WebhookDelivery).update(
    { id: delivery.id },
    { status: 'failed', attempts: attempt, lastStatusCode: outcome.statusCode, lastError: outcome.error.slice(0, 500), nextAttemptAt: null }
  );
  const rows: Array<{ consecutive_failures: number; is_enabled: boolean; url: string }> = await db.query(
    `UPDATE webhook_targets SET consecutive_failures = consecutive_failures + 1, last_error = $2, last_failure_at = now()
      WHERE id = $1 RETURNING consecutive_failures, is_enabled, url`,
    [delivery.targetId, outcome.error.slice(0, 500)]
  );
  const row = (Array.isArray(rows[0]) ? (rows[0] as unknown[])[0] : rows[0]) as
    | { consecutive_failures: number; is_enabled: boolean; url: string }
    | undefined;
  const limit = config.jobs.webhookDisableAfterFailures;
  if (!row || !row.is_enabled || limit <= 0 || row.consecutive_failures < limit) return;
  const reason = `Disabled after ${row.consecutive_failures} consecutive failed deliveries; last error: ${outcome.error}`.slice(0, 500);
  const disabled = await db.query(
    `UPDATE webhook_targets SET is_enabled = false, disabled_at = now(), disabled_reason = $2
      WHERE id = $1 AND is_enabled = true RETURNING id`,
    [delivery.targetId, reason]
  );
  const changed = Array.isArray(disabled[0]) ? (disabled[0] as unknown[]).length : disabled.length;
  if (!changed) return;
  await bumpReference('webhooks');
  logAudit(db, {
    requester: 'DepGate',
    ecosystem: 'webhook',
    packageName: row.url,
    decision: 'WEBHOOK_UPDATED',
    conditionReasons: [reason],
  });
}

type Loaded = { delivery: WebhookDelivery; target: WebhookTarget } | { skipped: string; delivery: WebhookDelivery } | null;

async function load(db: DataSource, deliveryId: string): Promise<Loaded> {
  const delivery = await db.getRepository(WebhookDelivery).findOne({ where: { id: deliveryId } });
  if (!delivery) return null;
  const target = await db.getRepository(WebhookTarget).findOne({ where: { id: delivery.targetId } });
  if (!target) return { skipped: 'Webhook deleted', delivery };
  if (!target.isEnabled) return { skipped: 'Webhook disabled', delivery };
  return { delivery, target };
}

async function markSkipped(db: DataSource, delivery: WebhookDelivery, reason: string): Promise<void> {
  await db.getRepository(WebhookDelivery).update({ id: delivery.id }, { status: 'skipped', lastError: reason, nextAttemptAt: null });
}

/** One attempt outside the queue (fallback when Redis is unavailable): no retry, so a failure is final. */
export async function deliverInline(db: DataSource, deliveryId: string): Promise<DeliveryOutcome | null> {
  const loaded = await load(db, deliveryId);
  if (!loaded) return null;
  if ('skipped' in loaded) {
    await markSkipped(db, loaded.delivery, loaded.skipped);
    return null;
  }
  const outcome = await postWebhook(loaded.target.url, buildRequest(loaded.target, loaded.delivery.payload, loaded.delivery.eventId, 1));
  if (outcome.kind === 'delivered') await markDelivered(db, loaded.delivery, 1, outcome.statusCode);
  else await markFailed(db, loaded.delivery, 1, outcome);
  return outcome;
}

/** Queues the deliveries; when the queue is unavailable they are sent once, in-process. */
export async function dispatchDeliveries(db: DataSource, deliveries: WebhookDelivery[]): Promise<void> {
  for (const delivery of deliveries) {
    if (delivery.status !== 'pending') continue;
    const jobId = await enqueue(
      'webhooks',
      'deliver',
      { deliveryId: delivery.id, eventId: delivery.eventId, targetId: delivery.targetId },
      { jobId: webhookJobId(delivery.id) }
    );
    if (!jobId) await deliverInline(db, delivery.id).catch(() => undefined);
  }
}

/** New deliveries of earlier events (same event IDs and payloads) to their webhook. */
export async function redeliver(db: DataSource, source: WebhookDelivery[]): Promise<WebhookDelivery[]> {
  if (source.length === 0) return [];
  const repo = db.getRepository(WebhookDelivery);
  const created = await repo.save(
    source.map((row) =>
      repo.create({ eventId: row.eventId, targetId: row.targetId, event: row.event, payload: row.payload, status: 'pending', attempts: 0 })
    )
  );
  await dispatchDeliveries(db, created);
  return created;
}

const REDELIVERED = 'Skipped; redelivered';

/** Skipped events of the last 7 days, delivered again after the webhook is back on. */
export async function redeliverSkipped(db: DataSource, targetId: string): Promise<number> {
  const rows = await db.getRepository(WebhookDelivery).find({
    where: { targetId, status: 'skipped', createdAt: MoreThan(new Date(Date.now() - 7 * 86_400_000)) },
    order: { createdAt: 'ASC' },
    take: 1000,
  });
  // An event redelivered once is not redelivered again by a second click.
  const fresh = rows.filter((row) => row.lastError !== REDELIVERED);
  const ids = fresh.map((row) => row.id);
  if (ids.length) await db.getRepository(WebhookDelivery).update({ id: In(ids) }, { lastError: REDELIVERED });
  return (await redeliver(db, fresh)).length;
}

/** "Send test event": one attempt, not recorded and not counted toward disabling. */
export async function sendTestEvent(target: WebhookTarget): Promise<DeliveryOutcome> {
  const eventId = crypto.randomUUID();
  return postWebhook(
    target.url,
    buildRequest(target, { event: 'test', timestamp: new Date().toISOString(), message: 'Test event from DepGate' }, eventId, 1)
  );
}

/** The worker for `webhooks/deliver`. */
export function registerWebhookJobs(db: DataSource): void {
  registerHandler('webhooks', 'deliver', async (job: Job, token?: string) => {
    const loaded = await load(db, String(job.data.deliveryId));
    if (!loaded) return { skipped: 'Delivery not found' };
    if ('skipped' in loaded) {
      await markSkipped(db, loaded.delivery, loaded.skipped);
      return { skipped: loaded.skipped };
    }
    if (token && (await overHostLimit(hostOf(loaded.target.url)))) {
      await job.moveToDelayed(Date.now() + 1000, token);
      throw new DelayedError();
    }
    // A delivery whose first attempt the stream consumer made continues the count (W4).
    const attempt = job.attemptsMade + 1 + Number(job.data.attemptOffset ?? 0);
    const outcome = await postWebhook(
      loaded.target.url,
      buildRequest(loaded.target, loaded.delivery.payload, loaded.delivery.eventId, attempt)
    );
    if (outcome.kind === 'delivered') {
      await markDelivered(db, loaded.delivery, attempt, outcome.statusCode);
      return { statusCode: outcome.statusCode };
    }
    const final = outcome.kind === 'fail' || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (final) {
      await markFailed(db, loaded.delivery, attempt, outcome);
      if (outcome.kind === 'fail') throw new UnrecoverableError(outcome.error);
      throw new Error(outcome.error);
    }
    const err =
      outcome.retryAfterMs !== undefined ? new RetryLaterError(outcome.error, outcome.retryAfterMs) : new Error(outcome.error);
    await db.getRepository(WebhookDelivery).update(
      { id: loaded.delivery.id },
      {
        attempts: attempt,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + retryDelay('webhooks', attempt, err)),
      }
    );
    throw err;
  });
}

/* ---------- Webhooks on the event pipeline (requirements_event_streaming.md §8.4) ---------- */

/** Events whose identical repeats within the window are coalesced (W3). */
const COALESCED_EVENTS = new Set(['package_blocked', 'malware_requested']);
const FIRST_ATTEMPT_CONCURRENCY = 10;

type StreamItem = { eventId: string; payload: Record<string, unknown> };

function coalesceHash(targetId: string, payload: Record<string, unknown>): string {
  const parts = [
    targetId,
    payload.event,
    payload.ecosystem,
    payload.packageName,
    payload.version ?? payload.resolvedVersion ?? '',
    payload.policyId ?? '',
    payload.repository ?? '',
  ];
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

function gateKey(targetId: string, hash: string): string {
  return dgKey(`whco:${targetId}:${hash}`);
}

/**
 * The first identical event of a window is sent at once and schedules one follow-up for the window's end;
 * later ones only count (W3). Shared by every consumer replica through Redis. Returns whether to send now.
 */
async function admitCoalesced(targetId: string, item: StreamItem): Promise<boolean> {
  const window = config.events.webhookCoalesceSeconds;
  const redis = jobsRedis();
  if (!(window > 0) || !redis || !COALESCED_EVENTS.has(String(item.payload.event))) return true;
  const hash = coalesceHash(targetId, item.payload);
  const gate = gateKey(targetId, hash);
  const now = new Date().toISOString();
  try {
    const set = await redis.set(gate, now, 'EX', window + 60, 'NX');
    if (set === 'OK') {
      await enqueue(
        'webhooks',
        'coalesced',
        { targetId, gate, eventId: item.eventId, payload: item.payload },
        { jobId: `whco-${targetId}-${hash}`, delay: window * 1000, attempts: 3 }
      );
      return true;
    }
    await redis
      .multi()
      .hincrby(`${gate}:n`, 'count', 1)
      .hset(`${gate}:n`, 'lastSeen', now)
      .expire(`${gate}:n`, window + 60)
      .exec();
    return false;
  } catch {
    // Redis trouble: no coalescing, every event is sent (W3).
    return true;
  }
}

/**
 * Keys in the order Postgres `jsonb` keeps them (shorter first, then bytewise), nested objects too. Payloads
 * sent from the queue were always read back from `webhook_deliveries.payload`, so this is the byte order
 * receivers already get (W8); the stream consumer sends its first attempt in the same order.
 */
export function jsonbOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => {
    const la = Buffer.byteLength(a);
    const lb = Buffer.byteLength(b);
    return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = jsonbOrder((value as Record<string, unknown>)[key]);
  return out;
}

async function sendFirstAttempts(db: DataSource, deliveries: WebhookDelivery[], targets: Map<string, WebhookTarget>): Promise<void> {
  const delivered: Array<{ id: string; statusCode: number; targetId: string }> = [];
  const queue = [...deliveries];
  const work = async () => {
    for (let delivery = queue.shift(); delivery; delivery = queue.shift()) {
      const target = targets.get(delivery.targetId);
      if (!target) continue;
      if (await overHostLimit(hostOf(target.url))) {
        const jobId = await enqueue('webhooks', 'deliver', { deliveryId: delivery.id, eventId: delivery.eventId, targetId: delivery.targetId }, { jobId: webhookJobId(delivery.id), delay: 1000 });
        if (!jobId) await deliverInline(db, delivery.id).catch(() => undefined);
        continue;
      }
      const payload = jsonbOrder(delivery.payload) as Record<string, unknown>;
      const outcome = await postWebhook(target.url, buildRequest(target, payload, delivery.eventId, 1));
      if (outcome.kind === 'delivered') {
        delivered.push({ id: delivery.id, statusCode: outcome.statusCode, targetId: delivery.targetId });
        continue;
      }
      const maxAttempts = config.jobs.webhookMaxAttempts;
      if (outcome.kind === 'fail' || maxAttempts <= 1) {
        await markFailed(db, delivery, 1, outcome);
        continue;
      }
      // Only a failed attempt becomes a queued job, with today's retry schedule (W4).
      const err = outcome.retryAfterMs !== undefined ? new RetryLaterError(outcome.error, outcome.retryAfterMs) : new Error(outcome.error);
      const delay = retryDelay('webhooks', 1, err);
      await db.getRepository(WebhookDelivery).update(
        { id: delivery.id },
        { attempts: 1, lastStatusCode: outcome.statusCode, lastError: outcome.error.slice(0, 500), nextAttemptAt: new Date(Date.now() + delay) }
      );
      const jobId = await enqueue(
        'webhooks',
        'deliver',
        { deliveryId: delivery.id, eventId: delivery.eventId, targetId: delivery.targetId, attemptOffset: 1 },
        { jobId: webhookJobId(delivery.id), delay, attempts: maxAttempts - 1 }
      );
      if (!jobId) await markFailed(db, delivery, 1, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FIRST_ATTEMPT_CONCURRENCY, deliveries.length) }, work));
  if (delivered.length === 0) return;
  // One UPDATE per batch for the delivered rows (W2).
  await db.query(
    `UPDATE webhook_deliveries d SET status = 'delivered', attempts = 1, last_status_code = v.code, last_error = NULL,
            delivered_at = now(), next_attempt_at = NULL
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::int[]) AS code) v
      WHERE d.id = v.id`,
    [delivered.map((row) => row.id), delivered.map((row) => row.statusCode)]
  );
  await db.query(`UPDATE webhook_targets SET consecutive_failures = 0, last_error = NULL WHERE id = ANY($1::uuid[]) AND consecutive_failures <> 0`, [
    [...new Set(delivered.map((row) => row.targetId))],
  ]);
}

/**
 * A batch of webhook events from the main stream (W1, W2): match subscriptions on the event name, coalesce
 * bursts, insert every delivery row in one statement, then make each first attempt directly.
 */
export async function deliverStreamBatch(db: DataSource, items: StreamItem[]): Promise<void> {
  const all = await readReference('webhooks', () => db.getRepository(WebhookTarget).find());
  const targets = new Map(all.map((target) => [target.id, target]));
  const repo = db.getRepository(WebhookDelivery);
  const rows: WebhookDelivery[] = [];
  for (const item of items) {
    const event = String(item.payload.event ?? '');
    for (const target of all) {
      const events = target.events?.length ? target.events : ['package_blocked'];
      if (!events.includes(event)) continue;
      if (target.isEnabled && !(await admitCoalesced(target.id, item))) continue;
      rows.push(
        repo.create({
          eventId: item.eventId || uuidv7(),
          targetId: target.id,
          event,
          payload: item.payload,
          status: target.isEnabled ? 'pending' : 'skipped',
          lastError: target.isEnabled ? null : 'Webhook disabled',
          attempts: 0,
        })
      );
    }
  }
  if (rows.length === 0) return;
  const inserted = await repo.createQueryBuilder().insert().into(WebhookDelivery).values(rows as never[]).returning(['id']).execute();
  inserted.identifiers.forEach((identifier, i) => {
    if (identifier?.id) rows[i].id = identifier.id as string;
  });
  await sendFirstAttempts(db, rows.filter((row) => row.status === 'pending' && row.id), targets);
}

/** The follow-up of a coalesced burst: one delivery with the count, first and last time (W3). */
export function registerCoalescedJob(db: DataSource): void {
  registerHandler('webhooks', 'coalesced', async (job: Job) => {
    const redis = jobsRedis();
    if (!redis) throw new Error('Queue Redis unavailable');
    const gate = String(job.data.gate);
    const replies = await redis.multi().get(gate).hgetall(`${gate}:n`).del(`${gate}:n`).del(gate).exec();
    const firstSeen = (replies?.[0]?.[1] as string | null) ?? null;
    const counter = (replies?.[1]?.[1] as Record<string, string> | null) ?? {};
    const count = Number(counter.count ?? 0);
    if (!(count > 0)) return { followUp: false };
    const target = await db.getRepository(WebhookTarget).findOne({ where: { id: String(job.data.targetId) } });
    if (!target) return { followUp: false, skipped: 'Webhook deleted' };
    const payload: Record<string, unknown> = {
      ...(job.data.payload as Record<string, unknown>),
      timestamp: new Date().toISOString(),
      occurrences: count + 1,
      firstSeen: firstSeen ?? (job.data.payload as Record<string, unknown>).timestamp,
      lastSeen: counter.lastSeen ?? new Date().toISOString(),
    };
    const repo = db.getRepository(WebhookDelivery);
    const row = await repo.save(
      repo.create({
        eventId: uuidv7(),
        targetId: target.id,
        event: String(payload.event),
        payload,
        status: target.isEnabled ? 'pending' : 'skipped',
        lastError: target.isEnabled ? null : 'Webhook disabled',
        attempts: 0,
      })
    );
    if (row.status === 'pending') await sendFirstAttempts(db, [row], new Map([[target.id, target]]));
    return { followUp: true, occurrences: count + 1 };
  });
}
