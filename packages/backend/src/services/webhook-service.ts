import { DataSource } from 'typeorm';
import { WebhookTarget } from '../db/entities/WebhookTarget.js';
import { WebhookDelivery } from '../db/entities/WebhookDelivery.js';
import { readReference } from './reference-cache.js';
import { currentRepository } from './request-context.js';
import { uuidv7 } from './jobs/ids.js';
import { deliverStreamBatch, dispatchDeliveries } from './webhook-delivery.js';

export type WebhookEvent =
  | 'package_blocked'
  | 'namespace_collision'
  | 'malware_requested'
  | 'dependency_confusion_blocked';

/** Events a webhook can subscribe to (requirements_event_streaming.md §8.5). */
export const WEBHOOK_EVENTS: WebhookEvent[] = [
  'package_blocked',
  'namespace_collision',
  'malware_requested',
  'dependency_confusion_blocked',
];

/** Accepted on create and update for one release, then refused; never sent. integrity_violation: removed 2026-10-18. */
export const DEPRECATED_EVENTS = ['policy_violation', 'integrity_violation'];

/** What a webhook with no events listed receives (webhooks saved before events could be chosen). */
export const DEFAULT_SUBSCRIPTION: WebhookEvent[] = ['package_blocked'];

/** What a new webhook subscribes to when the form sends no events (§8.5). */
export const NEW_WEBHOOK_EVENTS: WebhookEvent[] = ['package_blocked', 'malware_requested', 'dependency_confusion_blocked'];

export type WebhookPayload = {
  event: WebhookEvent;
  timestamp: string;
  [key: string]: unknown;
};

export function subscribedTo(target: Pick<WebhookTarget, 'events'>, event: string): boolean {
  const events = target.events?.length ? target.events : DEFAULT_SUBSCRIPTION;
  return events.includes(event);
}

/**
 * Webhook events read from the main event stream by the `webhooks` consumer group (W1). A separate entry
 * point from `deliverWebhooks`, so test setups can stub outbound delivery.
 */
export function deliverFromStream(db: DataSource, items: Array<{ eventId: string; payload: Record<string, unknown> }>): Promise<void> {
  return deliverStreamBatch(db, items);
}

/**
 * The inline path, used when the event stream is unavailable (W6) and by redelivery tests:
 * records the event once per subscribed webhook and queues its delivery. A disabled webhook gets a
 * `skipped` row, so Security can redeliver it after turning the webhook back on. The caller does not wait.
 */
export async function deliverWebhooks(db: DataSource, payload: WebhookPayload): Promise<void> {
  // Read before the first await: the request context is only guaranteed on the calling tick.
  const repository = payload.repository ?? currentRepository();
  if (repository !== undefined) payload = { ...payload, repository };
  if (DEPRECATED_EVENTS.includes(payload.event)) return;
  const targets = await readReference('webhooks', () => db.getRepository(WebhookTarget).find());
  const subscribed = targets.filter((target) => subscribedTo(target, payload.event));
  if (subscribed.length === 0) return;

  const eventId = uuidv7();
  const repo = db.getRepository(WebhookDelivery);
  const rows = await repo.save(
    subscribed.map((target) =>
      repo.create({
        eventId,
        targetId: target.id,
        event: payload.event,
        payload,
        status: target.isEnabled ? 'pending' : 'skipped',
        lastError: target.isEnabled ? null : 'Webhook disabled',
        attempts: 0,
      })
    )
  );
  await dispatchDeliveries(db, rows);
}
