import { FastifyPluginAsync } from 'fastify';
import { In } from 'typeorm';
import { JobRun } from '../db/entities/JobRun.js';
import { getQueue, QUEUE_NAMES, type QueueName } from '../services/jobs/queue.js';
import { runNow, SCHEDULED_JOBS, schedulerId, type ScheduledJob } from '../services/jobs/scheduled.js';
import { jobIds, scrubError } from '../services/jobs/ids.js';
import { getRequestContext, logAudit } from '../services/audit-service.js';

const DAY_MS = 86_400_000;

/** Email addresses in an error are shown as `a***@example.com`. */
export function maskEmails(text: string): string {
  return text.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2');
}

function isQueue(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

/** Settings → Jobs (Security only): queue depth, schedules and their last runs, failed jobs to retry or discard. */
const jobsRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });

  fastify.get('/api/admin/jobs', { onRequest: [requireSecurity], schema: { tags: ['Jobs'] } }, async (_request, reply) => {
    const available = QUEUE_NAMES.some((name) => getQueue(name));
    const queues = await Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const queue = getQueue(name);
        if (!queue) return { name, available: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
        try {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          return { name, available: true, waiting: counts.waiting ?? 0, active: counts.active ?? 0, delayed: counts.delayed ?? 0, failed: counts.failed ?? 0 };
        } catch {
          return { name, available: false, waiting: 0, active: 0, delayed: 0, failed: 0 };
        }
      })
    );
    const scheduled = getQueue('scheduled');
    const recent = await fastify.db.getRepository(JobRun).find({
      where: { job: In([...SCHEDULED_JOBS]) },
      order: { startedAt: 'DESC' },
      take: 200,
    });
    const schedules = await Promise.all(
      SCHEDULED_JOBS.map(async (job) => {
        const scheduler = scheduled ? await scheduled.getJobScheduler(schedulerId(job)).catch(() => undefined) : undefined;
        const runs = recent.filter((run) => run.job === job).slice(0, 10);
        return {
          job,
          everyMs: scheduler?.every ? Number(scheduler.every) : null,
          nextRunAt: scheduler?.next ? new Date(Number(scheduler.next)).toISOString() : null,
          runs: runs.map((run) => ({
            id: run.id,
            trigger: run.trigger,
            status: run.status,
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            result: run.result,
            error: run.error ? maskEmails(run.error) : null,
          })),
        };
      })
    );
    return reply.send({ available, queues, schedules });
  });

  fastify.get<{ Querystring: { queue?: string } }>(
    '/api/admin/jobs/failed',
    { onRequest: [requireSecurity], schema: { tags: ['Jobs'] } },
    async (request, reply) => {
      const names = request.query.queue ? [request.query.queue] : [...QUEUE_NAMES];
      if (names.some((name) => !isQueue(name))) return reply.status(400).send({ error: `queue must be one of ${QUEUE_NAMES.join(', ')}` });
      const since = Date.now() - 7 * DAY_MS;
      const items: Array<Record<string, unknown>> = [];
      for (const name of names as QueueName[]) {
        const queue = getQueue(name);
        if (!queue) continue;
        const jobs = await queue.getFailed(0, 199).catch(() => []);
        for (const job of jobs) {
          if (!job || (job.finishedOn ?? job.timestamp) < since) continue;
          items.push({
            queue: name,
            id: job.id,
            job: job.name,
            attempts: job.attemptsMade,
            maxAttempts: job.opts.attempts ?? 1,
            error: maskEmails(scrubError(job.failedReason ?? '')),
            failedAt: new Date(job.finishedOn ?? job.timestamp).toISOString(),
            ids: jobIds(job.data),
          });
        }
      }
      items.sort((a, b) => String(b.failedAt).localeCompare(String(a.failedAt)));
      return reply.send({ items });
    }
  );

  fastify.post<{ Params: { queue: string; id: string } }>(
    '/api/admin/jobs/:queue/:id/retry',
    { onRequest: [requireSecurity], schema: { tags: ['Jobs'] } },
    async (request, reply) => {
      const { queue: name, id } = request.params;
      if (!isQueue(name)) return reply.status(404).send({ error: 'Queue not found' });
      const job = await getQueue(name)?.getJob(id);
      if (!job) return reply.status(404).send({ error: 'Job not found' });
      if ((await job.getState()) !== 'failed') return reply.status(409).send({ error: 'Only a failed job can be retried' });
      await job.retry('failed');
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, { requesterIp: reqIp, userAgent, requester, ecosystem: 'config', packageName: `jobs/${name}`, decision: 'CONFIG_UPDATED', conditionReasons: [`Retried job ${job.name} (${id})`] });
      return reply.status(202).send({ retried: true });
    }
  );

  fastify.delete<{ Params: { queue: string; id: string } }>(
    '/api/admin/jobs/:queue/:id',
    { onRequest: [requireSecurity], schema: { tags: ['Jobs'] } },
    async (request, reply) => {
      const { queue: name, id } = request.params;
      if (!isQueue(name)) return reply.status(404).send({ error: 'Queue not found' });
      const job = await getQueue(name)?.getJob(id);
      if (!job) return reply.status(404).send({ error: 'Job not found' });
      if ((await job.getState()) !== 'failed') return reply.status(409).send({ error: 'Only a failed job can be discarded' });
      await job.remove();
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, { requesterIp: reqIp, userAgent, requester, ecosystem: 'config', packageName: `jobs/${name}`, decision: 'CONFIG_UPDATED', conditionReasons: [`Discarded failed job ${job.name} (${id})`] });
      return reply.status(204).send();
    }
  );

  /** Run a scheduled job now. 409 while a run of it is queued or active anywhere. */
  fastify.post<{ Params: { job: string } }>(
    '/api/admin/jobs/scheduled/:job/run',
    { onRequest: [requireSecurity], schema: { tags: ['Jobs'] } },
    async (request, reply) => {
      const job = request.params.job as ScheduledJob;
      if (!(SCHEDULED_JOBS as readonly string[]).includes(job)) return reply.status(404).send({ error: 'Unknown job' });
      const { reqIp, userAgent, requester } = getRequestContext(request);
      const audited = job === 'malicious-feed-sync' || job === 'epss-sync';
      const queued = await runNow(job, audited ? { requesterIp: reqIp, userAgent, requester } : {});
      if ('conflict' in queued) return reply.status(409).send({ error: 'Already running' });
      if ('unavailable' in queued) return reply.status(503).send({ error: 'The job queue is unavailable; try again shortly' });
      logAudit(fastify.db, { requesterIp: reqIp, userAgent, requester, ecosystem: 'config', packageName: `jobs/${job}`, decision: 'CONFIG_UPDATED', conditionReasons: ['Run now'] });
      return reply.status(202).send({ queued: true, jobId: queued.jobId });
    }
  );
};

export default jobsRoutes;
