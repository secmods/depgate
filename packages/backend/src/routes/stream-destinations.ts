import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import type { DataSource } from 'typeorm';
import { StreamDestination } from '../db/entities/StreamDestination.js';
import {
  DESTINATION_TYPES,
  describeChanges,
  encryptSecrets,
  publicView,
  resolveDestination,
  validateDestination,
  type DestinationInput,
  type ResolvedDestination,
} from '../services/events/destinations/config.js';
import { createSender } from '../services/events/destinations/senders.js';
import { jsonLine, type StreamEvent } from '../services/events/destinations/formatters.js';
import { buildEnvelope } from '../services/events/envelope.js';
import { recordEvent } from '../services/events/record.js';
import { destroyGroups, ensureGroups } from '../services/events/consumer.js';
import { refreshSelection } from '../services/events/streams.js';
import { clearStatus, readStatus } from '../services/events/status.js';
import { bumpReference } from '../services/reference-cache.js';
import { currentActor } from '../services/request-context.js';
import { selects } from '../services/events/catalog.js';

/** Log Streaming destinations (requirements_event_streaming.md §10.3, §11). Security only, like webhooks. */

const bodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 128 },
    type: { type: 'string', enum: DESTINATION_TYPES },
    enabled: { type: 'boolean' },
    settings: { type: 'object', additionalProperties: { type: ['string', 'number', 'null'] } },
    secrets: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
    selection: {
      type: 'object',
      properties: { features: { type: 'array', items: { type: 'string' } }, events: { type: 'array', items: { type: 'string' } } },
    },
  },
};

/** Average events a day over the last 7 days, from the hourly counts, for the volume badges and banner. */
async function dailyVolume(db: DataSource): Promise<Record<string, number>> {
  const rows: Array<{ decision: string; count: string }> = await db.query(
    `SELECT decision, SUM(count)::bigint AS count FROM decision_counts_hourly
      WHERE hour >= now() - interval '7 days' AND decision IN ('ALLOW', 'BLOCK_MONITOR', 'BLOCK_ENFORCE') GROUP BY decision`
  );
  return Object.fromEntries(rows.map((row) => [row.decision, Math.round(Number(row.count) / 7)]));
}

const streamDestinationRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });
  const repo = () => fastify.db.getRepository(StreamDestination);

  const audit = (type: string, dest: Pick<ResolvedDestination, 'id' | 'name' | 'type'>, reasons: string[]) =>
    recordEvent(fastify.db, {
      type,
      actor: currentActor(),
      target: { kind: 'stream_destination', id: dest.id, name: dest.name },
      summary: `${type === 'STREAM_DESTINATION_CREATED' ? 'Created' : type === 'STREAM_DESTINATION_DELETED' ? 'Deleted' : 'Updated'} ${dest.type} destination ${dest.name}`,
      reasons,
      details: { destinationType: dest.type },
    });

  /** Groups first, then the broadcast, so no replica publishes for a destination without its group (§8.2). */
  const applyGroups = async (dest: ResolvedDestination) => {
    await ensureGroups(fastify.redis, dest);
    await bumpReference('stream_destinations');
    await refreshSelection();
  };

  fastify.get('/api/admin/stream-destinations', { onRequest: [requireSecurity], schema: { tags: ['Webhooks'], summary: 'Log Streaming destinations' } }, async (_request, reply) => {
    const rows = await repo().find({ order: { createdAt: 'ASC' } });
    const volume = await dailyVolume(fastify.db).catch(() => ({} as Record<string, number>));
    const items = await Promise.all(
      rows.map(async (row) => ({
        ...publicView(row),
        health: await readStatus(fastify.redis, row.id, row.enabled).catch(() => null),
      }))
    );
    const highVolume = ['ALLOW', 'BLOCK_MONITOR'].filter((type) =>
      rows.some((row) => row.enabled && selects(resolveDestination(row).selection, type === 'ALLOW' ? 'decisions' : 'monitoring', type))
    );
    return reply.send({
      items,
      volume,
      highVolume: {
        types: highVolume,
        estimatePerDay: highVolume.reduce((n, type) => n + (volume[type] ?? 0), 0),
      },
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/admin/stream-destinations/:id', { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } }, async (request, reply) => {
    const row = await repo().findOne({ where: { id: request.params.id } });
    if (!row) return reply.status(404).send({ error: 'Destination not found' });
    return reply.send({ ...publicView(row), health: await readStatus(fastify.redis, row.id, row.enabled).catch(() => null) });
  });

  fastify.post<{ Body: DestinationInput }>(
    '/api/admin/stream-destinations',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'], body: bodySchema } },
    async (request, reply) => {
      const valid = validateDestination(request.body ?? {});
      if (typeof valid === 'string') return reply.status(400).send({ error: valid });
      if (valid.type === 'jsonl' && (await repo().count({ where: { type: 'jsonl' } })) > 0) {
        return reply.status(409).send({ error: 'There is already a JSON lines destination' });
      }
      const id = randomUUID();
      const resolved: ResolvedDestination = { id, ...valid };
      await applyGroups(resolved).catch((err) => request.log.warn(err, 'Could not create the stream groups; the worker creates them'));
      const row = await repo().save(
        repo().create({ id, name: valid.name, type: valid.type, enabled: valid.enabled, settings: valid.settings, secretsEnc: encryptSecrets(valid.secrets), selection: valid.selection })
      );
      await bumpReference('stream_destinations');
      await refreshSelection();
      audit('STREAM_DESTINATION_CREATED', resolved, describeChanges(null, resolved));
      return reply.status(201).send(publicView(row));
    }
  );

  fastify.put<{ Params: { id: string }; Body: DestinationInput }>(
    '/api/admin/stream-destinations/:id',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'], body: bodySchema } },
    async (request, reply) => {
      const row = await repo().findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Destination not found' });
      const before = resolveDestination(row);
      const body = request.body ?? {};
      const valid = validateDestination(
        {
          name: body.name ?? before.name,
          type: body.type ?? before.type,
          enabled: body.enabled ?? before.enabled,
          settings: body.settings ?? before.settings,
          secrets: body.secrets,
          selection: body.selection ?? before.selection,
        },
        before
      );
      if (typeof valid === 'string') return reply.status(400).send({ error: valid });
      const after: ResolvedDestination = { id: row.id, ...valid };
      await applyGroups(after).catch((err) => request.log.warn(err, 'Could not update the stream groups'));
      Object.assign(row, { name: valid.name, enabled: valid.enabled, settings: valid.settings, secretsEnc: encryptSecrets(valid.secrets), selection: valid.selection });
      const saved = await repo().save(row);
      await bumpReference('stream_destinations');
      await refreshSelection();
      audit('STREAM_DESTINATION_UPDATED', after, describeChanges(before, after));
      return reply.send(publicView(saved));
    }
  );

  fastify.delete<{ Params: { id: string } }>('/api/admin/stream-destinations/:id', { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } }, async (request, reply) => {
    const row = await repo().findOne({ where: { id: request.params.id } });
    if (!row) return reply.status(404).send({ error: 'Destination not found' });
    const dest = resolveDestination(row);
    await repo().delete({ id: row.id });
    await bumpReference('stream_destinations');
    await refreshSelection();
    await destroyGroups(fastify.redis, row.id).catch(() => undefined);
    await clearStatus(fastify.redis, row.id).catch(() => undefined);
    audit('STREAM_DESTINATION_DELETED', dest, [`Deleted ${dest.type} destination ${dest.name}`]);
    return reply.status(204).send();
  });

  /**
   * "Send test event" (§10.4): one STREAM_TEST event through the real formatter and transport, outside the
   * stream. Answers the destination's status code and the first 300 characters of its reply.
   */
  const sendTest = async (dest: ResolvedDestination) => {
    const envelope = buildEnvelope({
      type: 'STREAM_TEST',
      actor: currentActor(),
      target: { kind: 'stream_destination', id: dest.id, name: dest.name },
      summary: `Test event from DepGate to ${dest.name}`,
    });
    const json = JSON.stringify(envelope);
    const event: StreamEvent = { entryId: '', key: 'STREAM_TEST', feature: envelope.feature, json };
    if (dest.type === 'jsonl') {
      process.stdout.write(jsonLine(json));
      return { ok: true, status: null, reply: 'Written to standard output of this replica', event: envelope };
    }
    const sender = createSender(dest);
    if (!sender) return { ok: false, status: null, reply: 'Unknown destination type', event: envelope };
    try {
      const outcome = await sender.send([event]);
      const ok = outcome.kind === 'ok' && !outcome.rejected;
      const status = outcome.status ?? null;
      const replyText = outcome.kind === 'ok' ? (outcome.error ?? outcome.reply) : (outcome.reply ?? outcome.error);
      return { ok, status, reply: String(replyText ?? '').slice(0, 300), error: ok ? undefined : (outcome.kind === 'ok' ? outcome.error : outcome.error), event: envelope };
    } finally {
      sender.close();
    }
  };

  fastify.post<{ Body: DestinationInput & { id?: string } }>(
    '/api/admin/stream-destinations/test',
    { onRequest: [requireSecurity], schema: { tags: ['Webhooks'], summary: 'Send a test event with an unsaved configuration' } },
    async (request, reply) => {
      const body = request.body ?? {};
      // Editing a saved destination: secrets left blank in the form are the stored ones.
      const stored = body.id ? await repo().findOne({ where: { id: body.id } }) : null;
      const existing = stored ? resolveDestination(stored) : undefined;
      const valid = validateDestination({ ...body, name: body.name || 'Test' }, existing);
      if (typeof valid === 'string') return reply.status(400).send({ error: valid });
      return reply.send(await sendTest({ id: existing?.id ?? 'unsaved', ...valid }));
    }
  );

  fastify.post<{ Params: { id: string } }>('/api/admin/stream-destinations/:id/test', { onRequest: [requireSecurity], schema: { tags: ['Webhooks'] } }, async (request, reply) => {
    const row = await repo().findOne({ where: { id: request.params.id } });
    if (!row) return reply.status(404).send({ error: 'Destination not found' });
    return reply.send(await sendTest(resolveDestination(row)));
  });
};

export default fp(streamDestinationRoutes);
