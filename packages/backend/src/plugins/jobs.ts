import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { getQueue, jobsRedis, QUEUE_NAMES, startJobs, stopJobs } from '../services/jobs/queue.js';
import { registerScheduledJobs, scheduleStartupJobs, upsertSchedules } from '../services/jobs/scheduled.js';
import { registerCoalescedJob, registerWebhookJobs } from '../services/webhook-delivery.js';
import { registerEmailJobs } from '../services/email-jobs.js';
import { registerMonitorJobs } from '../services/monitor-service.js';
import { queueJobsGauge, redisMemoryGauge } from '../services/jobs/metrics.js';

/** `noeviction`, another policy, or null when Redis refused CONFIG (managed Redis). */
let evictionPolicy: string | null | undefined;

export function redisEvictionPolicy(): string | null | undefined {
  return evictionPolicy;
}

/** Queue depth and Redis memory, read when /metrics is scraped. */
export async function refreshJobGauges(): Promise<void> {
  for (const name of QUEUE_NAMES) {
    const queue = getQueue(name);
    if (!queue) continue;
    try {
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, value] of Object.entries(counts)) queueJobsGauge.set({ queue: name, state }, value);
    } catch {
      /* skipped for this scrape */
    }
  }
  const redis = jobsRedis();
  if (!redis) return;
  try {
    const info = await redis.info('memory');
    const read = (field: string) => Number(info.match(new RegExp(`^${field}:(\\d+)`, 'm'))?.[1] ?? 0);
    redisMemoryGauge.set({ kind: 'used' }, read('used_memory'));
    redisMemoryGauge.set({ kind: 'max' }, read('maxmemory'));
  } catch {
    /* skipped for this scrape */
  }
}

/**
 * Background jobs (requirements_job_queue.md): one shared BullMQ queue set on Redis. Replaces the
 * per-replica timers of the malicious feed sync, Monitor retention purge and namespace collision check.
 */
const jobsPlugin: FastifyPluginAsync = async (fastify) => {
  registerWebhookJobs(fastify.db);
  registerCoalescedJob(fastify.db);
  registerScheduledJobs({ db: fastify.db, log: fastify.log });
  registerEmailJobs(fastify.db);
  registerMonitorJobs({ db: fastify.db, redis: fastify.redis });

  await startJobs({ log: fastify.log });

  fastify.addHook('onReady', async () => {
    const redis = jobsRedis();
    try {
      const reply = (await redis?.config('GET', 'maxmemory-policy')) as string[] | undefined;
      evictionPolicy = reply?.[1] ?? null;
      if (evictionPolicy && evictionPolicy !== 'noeviction') {
        fastify.log.warn(
          { evictionPolicy },
          'Redis maxmemory-policy is not noeviction: queued jobs could be dropped when memory is full. Set maxmemory-policy noeviction'
        );
      }
    } catch {
      evictionPolicy = null;
      fastify.log.warn('Could not read the Redis eviction policy (CONFIG refused); make sure it is noeviction');
    }
    try {
      await upsertSchedules(fastify.log);
      await scheduleStartupJobs(fastify.db);
    } catch (err) {
      fastify.log.warn(err, 'Could not set job schedules; they are set on the next start');
    }
  });

  fastify.addHook('onClose', async () => {
    await stopJobs();
  });
};

export default fp(jobsPlugin, { name: 'jobs' });
