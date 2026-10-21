import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { WebhookTarget } from '../db/entities/WebhookTarget.js';
import { WebhookDelivery, type WebhookDeliveryStatus } from '../db/entities/WebhookDelivery.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { DEPRECATED_EVENTS, NEW_WEBHOOK_EVENTS, WEBHOOK_EVENTS } from '../services/webhook-service.js';
import { redeliver, redeliverSkipped, sendTestEvent } from '../services/webhook-delivery.js';
import { config } from '../config.js';

/** What the API takes: the current events, plus deprecated ones for one release (they are dropped). */
const ACCEPTED_EVENTS = [...WEBHOOK_EVENTS, ...DEPRECATED_EVENTS];
const STATUSES: WebhookDeliveryStatus[] = ['pending', 'delivered', 'failed', 'skipped'];

const webhookSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    url: { type: 'string' },
    secretConfigured: { type: 'boolean' },
    events: { type: 'array', items: { type: 'string' } },
    deprecatedEvents: { type: 'array', items: { type: 'string' } },
    isEnabled: { type: 'boolean' },
    consecutiveFailures: { type: 'number' },
    disableAfterFailures: { type: 'number' },
    lastError: { type: 'string', nullable: true },
    lastFailureAt: { type: 'string', nullable: true },
    disabledAutomatically: { type: 'boolean' },
    disabledAt: { type: 'string', nullable: true },
    disabledReason: { type: 'string', nullable: true },
    deprecations: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
  },
} as const;

function view(w: WebhookTarget, deprecations: string[] = []) {
  const events = w.events ?? [];
  return {
    id: w.id,
    url: w.url,
    secretConfigured: !!w.secret,
    events: events.filter((event) => !DEPRECATED_EVENTS.includes(event)),
    deprecatedEvents: events.filter((event) => DEPRECATED_EVENTS.includes(event)),
    isEnabled: w.isEnabled,
    consecutiveFailures: w.consecutiveFailures ?? 0,
    disableAfterFailures: config.jobs.webhookDisableAfterFailures,
    lastError: w.lastError ?? null,
    lastFailureAt: w.lastFailureAt ? w.lastFailureAt.toISOString() : null,
    disabledAutomatically: !w.isEnabled && !!w.disabledReason,
    disabledAt: w.disabledAt ? w.disabledAt.toISOString() : null,
    disabledReason: w.disabledReason ?? null,
    deprecations,
    createdAt: w.createdAt.toISOString(),
  };
}

/** Deprecated events are accepted but not stored; the response says so. */
function cleanEvents(events: string[] | undefined): { events?: string[]; deprecations: string[] } {
  if (events === undefined) return { deprecations: [] };
  const dropped = events.filter((event) => DEPRECATED_EVENTS.includes(event));
  return {
    events: events.filter((event) => !DEPRECATED_EVENTS.includes(event)),
    deprecations: dropped.map((event) => `${event} is no longer sent and was not saved; it will be refused in the next release`),
  };
}

const webhooksRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });
  const targets = () => fastify.db.getRepository(WebhookTarget);

  fastify.get(
    '/api/admin/webhooks',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'], response: { 200: { type: 'array', items: webhookSchema } } } },
    async (_request, reply) => {
      const list = await targets().find({ order: { createdAt: 'DESC' } });
      return reply.send(list.map((w) => view(w)));
    }
  );

  fastify.post<{ Body: { url?: string; secret?: string; events?: string[]; isEnabled?: boolean } }>(
    '/api/admin/webhooks',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Webhooks'],
        body: {
          type: 'object',
          required: ['url'],
          properties: {
            url: { type: 'string' },
            secret: { type: 'string', nullable: true },
            events: { type: 'array', items: { type: 'string', enum: ACCEPTED_EVENTS } },
            isEnabled: { type: 'boolean' },
          },
        },
        response: { 201: webhookSchema },
      },
    },
    async (request, reply) => {
      const { url, secret, isEnabled } = request.body ?? {};
      if (!url) return reply.status(400).send({ error: 'url required' });
      const { events, deprecations } = cleanEvents(request.body?.events);
      const saved = await targets().save(
        targets().create({
          url: url.trim(),
          secret: secret?.trim() || null,
          events: events ?? [...NEW_WEBHOOK_EVENTS],
          isEnabled: isEnabled ?? true,
        })
      );
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'webhook',
        packageName: saved.url,
        decision: 'WEBHOOK_CREATED',
        conditionReasons: saved.events ?? [],
      });
      return reply.status(201).send(view(saved, deprecations));
    }
  );

  fastify.put<{ Params: { id: string }; Body: { url?: string; secret?: string; events?: string[]; isEnabled?: boolean } }>(
    '/api/admin/webhooks/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Webhooks'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            secret: { type: 'string', nullable: true },
            events: { type: 'array', items: { type: 'string', enum: ACCEPTED_EVENTS } },
            isEnabled: { type: 'boolean' },
          },
        },
        response: { 200: webhookSchema, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const target = await targets().findOne({ where: { id: request.params.id } });
      if (!target) return reply.status(404).send({ error: 'Webhook not found' });
      const { events, deprecations } = cleanEvents(body.events);
      if (body.url !== undefined) target.url = body.url.trim();
      if (body.secret !== undefined) target.secret = body.secret?.trim() || null;
      // Saving a webhook drops a deprecated event it still had stored.
      target.events = (events ?? target.events ?? []).filter((event) => !DEPRECATED_EVENTS.includes(event));
      const reEnabled = body.isEnabled === true && !target.isEnabled;
      if (body.isEnabled !== undefined) target.isEnabled = body.isEnabled;
      if (reEnabled) {
        target.consecutiveFailures = 0;
        target.disabledAt = null;
        target.disabledReason = null;
      }
      await targets().save(target);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'webhook',
        packageName: target.url,
        decision: 'WEBHOOK_UPDATED',
        conditionReasons: [...(target.events ?? []), ...(reEnabled ? ['Turned on again'] : [])],
      });
      return reply.send(view(target, deprecations));
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/webhooks/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Webhooks'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 204: { type: 'null' }, 404: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const target = await targets().findOne({ where: { id: request.params.id } });
      if (!target) return reply.status(404).send({ error: 'Webhook not found' });
      await targets().remove(target);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'webhook',
        packageName: target.url,
        decision: 'WEBHOOK_DELETED',
      });
      return reply.status(204).send();
    }
  );

  /** One test request, answered at once. Not recorded and not counted toward disabling. */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/webhooks/:id/test',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } },
    async (request, reply) => {
      const target = await targets().findOne({ where: { id: request.params.id } });
      if (!target) return reply.status(404).send({ error: 'Webhook not found' });
      const outcome = await sendTestEvent(target);
      return reply.send({
        ok: outcome.kind === 'delivered',
        statusCode: outcome.statusCode,
        error: outcome.kind === 'delivered' ? null : outcome.error,
      });
    }
  );

  /** Delivery history of one webhook, newest first. */
  fastify.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string; offset?: string } }>(
    '/api/admin/webhooks/:id/deliveries',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } },
    async (request, reply) => {
      const target = await targets().findOne({ where: { id: request.params.id } });
      if (!target) return reply.status(404).send({ error: 'Webhook not found' });
      const status = request.query.status as WebhookDeliveryStatus | undefined;
      if (status && !STATUSES.includes(status)) return reply.status(400).send({ error: `status must be one of ${STATUSES.join(', ')}` });
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);
      const [rows, total] = await fastify.db.getRepository(WebhookDelivery).findAndCount({
        where: { targetId: target.id, ...(status ? { status } : {}) },
        order: { createdAt: 'DESC' },
        take: limit,
        skip: offset,
      });
      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          eventId: row.eventId,
          event: row.event,
          status: row.status,
          attempts: row.attempts,
          lastStatusCode: row.lastStatusCode,
          lastError: row.lastError,
          createdAt: row.createdAt.toISOString(),
          deliveredAt: row.deliveredAt?.toISOString() ?? null,
          nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
          payload: row.payload,
        })),
        total,
      });
    }
  );

  /** Sends the event again, with the same event ID, as a new delivery. */
  fastify.post<{ Params: { id: string; deliveryId: string } }>(
    '/api/admin/webhooks/:id/deliveries/:deliveryId/redeliver',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } },
    async (request, reply) => {
      const row = await fastify.db
        .getRepository(WebhookDelivery)
        .findOne({ where: { id: request.params.deliveryId, targetId: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Delivery not found' });
      const target = await targets().findOne({ where: { id: row.targetId } });
      if (!target?.isEnabled) return reply.status(409).send({ error: 'Turn the webhook on before redelivering' });
      const [created] = await redeliver(fastify.db, [row]);
      return reply.status(202).send({ queued: true, deliveryId: created.id, eventId: created.eventId });
    }
  );

  /** After turning a webhook back on: deliver the events skipped in the last 7 days. */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/webhooks/:id/redeliver-skipped',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } },
    async (request, reply) => {
      const target = await targets().findOne({ where: { id: request.params.id } });
      if (!target) return reply.status(404).send({ error: 'Webhook not found' });
      if (!target.isEnabled) return reply.status(409).send({ error: 'Turn the webhook on before redelivering' });
      const queued = await redeliverSkipped(fastify.db, target.id);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'webhook',
        packageName: target.url,
        decision: 'WEBHOOK_UPDATED',
        conditionReasons: [`Redelivered ${queued} skipped events`],
      });
      return reply.status(202).send({ queued });
    }
  );
};

export default fp(webhooksRoutes);
