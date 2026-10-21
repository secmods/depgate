import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { deliverFromStream, deliverWebhooks } from '../services/webhook-service.js';
import { warnRemovedSettings } from '../services/audit-service.js';
import { flushAllLedgers } from '../services/events/record.js';
import { startSummaryPusher, stopSummaryPusher } from '../services/events/summary.js';
import { checkRedisVersion, startEventProducer, stopEventProducer } from '../services/events/streams.js';
import { EventWorker, eventsWorkerEnabled, webhooksWorkerEnabled } from '../services/events/consumer.js';
import { upcomingPurge } from '../services/events/retention.js';
import { config } from '../config.js';

/**
 * Events (requirements_event_streaming.md): the producer and summary counters on every replica; stream
 * consumers, the summary flush and the webhook consumer on replicas whose WORKERS include `events` / `webhooks`.
 */
const eventsPlugin: FastifyPluginAsync = async (fastify) => {
  const version = await checkRedisVersion(fastify.redis);
  fastify.log.info({ redis: version }, 'Redis version supported for event streams');
  try {
    const reply = (await fastify.redis.config('GET', 'maxmemory-policy')) as string[];
    if (reply?.[1]?.startsWith('allkeys-')) {
      fastify.log.warn(
        { evictionPolicy: reply[1] },
        'Redis maxmemory-policy evicts any key: the event stream buffers could be evicted. Set maxmemory-policy noeviction'
      );
    }
  } catch {
    /* managed Redis may refuse CONFIG; the jobs plugin already warns */
  }
  warnRemovedSettings(fastify.log);

  startSummaryPusher(fastify.redis);
  await startEventProducer({ db: fastify.db, log: fastify.log, inlineWebhooks: deliverWebhooks });

  const destinations = eventsWorkerEnabled();
  const webhooks = webhooksWorkerEnabled();
  const worker =
    destinations || webhooks
      ? new EventWorker(fastify.db, fastify.log, {
          destinations,
          webhooks: webhooks ? (items) => deliverFromStream(fastify.db, items) : null,
        })
      : null;

  fastify.addHook('onReady', async () => {
    await worker?.start();
    try {
      const notice = await upcomingPurge(fastify.db);
      if (notice) {
        const parts = [
          notice.ledger?.entries ? `${notice.ledger.entries} Decision Ledger entries older than ${notice.ledger.retentionDays} days (LEDGER_RETENTION_DAYS=0 keeps them)` : null,
          notice.audit?.entries ? `${notice.audit.entries} Audit Log entries older than ${notice.audit.retentionDays} days (AUDIT_RETENTION_DAYS=0 keeps them)` : null,
        ].filter(Boolean);
        fastify.log.warn({ date: notice.date }, `On ${notice.date.slice(0, 10)} the retention purge deletes ${parts.join(' and ')}`);
      }
    } catch {
      /* the tables are new; nothing to warn about yet */
    }
  });

  fastify.addHook('onClose', async () => {
    await worker?.stop();
    await stopEventProducer();
    await stopSummaryPusher();
    // SIGTERM writes what the ledger buffer still holds (L5).
    await flushAllLedgers();
  });

  fastify.log.info(
    { destinations, webhooks, bulkStreamMaxLen: config.events.streamMaxLen },
    'Event streams ready'
  );
};

export default fp(eventsPlugin, { name: 'events' });
