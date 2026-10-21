import type { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { JobRun } from '../../db/entities/JobRun.js';
import { MaliciousSyncStatus } from '../../db/entities/MaliciousSyncStatus.js';
import { config } from '../../config.js';
import { runCollisionCheck } from '../namespace-collisions.js';
import { claimMaliciousSync, runClaimedMaliciousSync } from '../malicious-sync-status.js';
import { purgeMonitorHits } from '../monitor-service.js';
import { EpssSyncStatus } from '../../db/entities/EpssSyncStatus.js';
import { EPSS_STATUS_ID, claimEpssSync, runClaimedEpssSync } from '../epss.js';
import { enqueue, getQueue, jobsRedis, queuePrefix, registerHandler, type JobLog } from './queue.js';
import { acquireRunMutex, mutexHeld } from './mutex.js';
import { runNowJobId, scrubError } from './ids.js';
import { purgeEvents } from '../events/retention.js';
import { recordEvent } from '../events/record.js';

/**
 * Cluster-wide schedules (requirements_job_queue.md §7). One job scheduler per job, upserted by every
 * replica with the same ID; a Redis mutex keeps a scheduled run and a "run now" from overlapping.
 */

export const SCHEDULED_JOBS = [
  'namespace-collision-check',
  'malicious-feed-sync',
  'monitor-retention-purge',
  'epss-sync',
  'event-retention-purge',
] as const;

/** Schedules removed from the product. Dropped on startup so a cluster that already registered them stops. */
const RETIRED_JOBS = ['event-migration'] as const;
export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

export type JobTrigger = 'scheduled' | 'manual' | 'startup';

type Context = { db: DataSource; log: JobLog };

type Definition = {
  intervalMs: () => number;
  run: (ctx: Context, job: Job) => Promise<Record<string, unknown>>;
};

const HOUR = 3_600_000;

const DEFINITIONS: Record<ScheduledJob, Definition> = {
  'namespace-collision-check': {
    intervalMs: () => config.namespace.collisionIntervalHours * HOUR,
    run: async ({ db }) => ({ ...(await runCollisionCheck(db)) }),
  },
  'malicious-feed-sync': {
    intervalMs: () => config.malicious.syncIntervalHours * HOUR,
    run: async ({ db, log }, job) => {
      const trigger = job.data?.trigger === 'manual' ? 'manual' : 'scheduled';
      if (!(await claimMaliciousSync(db, trigger))) return { skipped: 'Another sync is in progress' };
      const result = await runClaimedMaliciousSync({
        db,
        log,
        trigger,
        requesterIp: (job.data?.requesterIp as string | undefined) ?? null,
        userAgent: (job.data?.userAgent as string | undefined) ?? null,
        requester: (job.data?.requester as string | undefined) ?? null,
      });
      return { mode: result.mode, added: result.added, removed: result.removed, total: result.total };
    },
  },
  'monitor-retention-purge': {
    intervalMs: () => config.monitor.purgeIntervalMinutes * 60_000,
    run: async ({ db }) => {
      const monitor = await purgeMonitorHits(db);
      const deliveries = await db.query(
        `DELETE FROM webhook_deliveries WHERE created_at < now() - make_interval(days => $1)`,
        [config.jobs.webhookDeliveryRetentionDays]
      );
      const runs = await db.query(`DELETE FROM job_runs WHERE started_at < now() - make_interval(days => $1)`, [
        config.jobs.jobRunRetentionDays,
      ]);
      return { monitor, webhookDeliveries: affected(deliveries), jobRuns: affected(runs) };
    },
  },
  'epss-sync': {
    intervalMs: () => (config.epss.enabled ? config.epss.syncIntervalHours * HOUR : 0),
    run: async ({ db }, job) => {
      const trigger = job.data?.trigger === 'manual' ? 'manual' : job.data?.trigger === 'startup' ? 'startup' : 'scheduled';
      if (!(await claimEpssSync(db, trigger))) return { skipped: 'Another sync is in progress' };
      const result = await runClaimedEpssSync({
        db,
        trigger,
        requesterIp: (job.data?.requesterIp as string | undefined) ?? null,
        userAgent: (job.data?.userAgent as string | undefined) ?? null,
        requester: (job.data?.requester as string | undefined) ?? null,
      });
      return { rowCount: result.rowCount, scoreDate: result.scoreDate, source: result.source, unchanged: result.unchanged };
    },
  },
  'event-retention-purge': {
    intervalMs: () => HOUR,
    run: async ({ db }) => ({ ...(await purgeEvents(db)) }),
  },
};

/**
 * One event per finished run (requirements_event_streaming.md §6.3 job events), built from the run record.
 * Not stored again: job_runs and Jobs & Feeds are the record.
 */
function publishJobRun(
  db: DataSource,
  run: { id: string; job: string; jobId: string | null; trigger: string; status: 'succeeded' | 'failed' | 'skipped'; startedAt: Date },
  result: Record<string, unknown> | null,
  error: string | null
): void {
  const type = run.status === 'failed' ? 'JOB_FAILED' : run.status === 'skipped' ? 'JOB_SKIPPED' : 'JOB_SUCCEEDED';
  recordEvent(db, {
    type,
    job: run.job,
    actor: { kind: 'system', name: 'DepGate' },
    target: { kind: 'job', name: run.job },
    reasons: error ? [error] : null,
    details: {
      runId: run.id,
      jobId: run.jobId,
      trigger: run.trigger,
      durationMs: Date.now() - run.startedAt.getTime(),
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    },
  });
}

function affected(raw: unknown): number {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === 'number') return raw[1];
  return 0;
}

export function schedulerId(job: ScheduledJob): string {
  return `sched-${job}`;
}

function mutexKey(job: ScheduledJob): string {
  return `${queuePrefix()}:mutex:${job}`;
}

/** Runs the job under its mutex and records the run. A run that finds another one active is recorded as skipped. */
export function registerScheduledJobs(ctx: Context): void {
  for (const name of SCHEDULED_JOBS) {
    registerHandler('scheduled', name, async (job: Job) => {
      const trigger: JobTrigger = (job.data?.trigger as JobTrigger | undefined) ?? 'scheduled';
      const runs = ctx.db.getRepository(JobRun);
      const redis = jobsRedis();
      const mutex = redis ? await acquireRunMutex(redis, mutexKey(name)) : { release: async () => undefined };
      if (!mutex) {
        const skipped = await runs.save(
          runs.create({
            job: name,
            jobId: job.id ?? null,
            trigger,
            status: 'skipped',
            startedAt: new Date(),
            finishedAt: new Date(),
            result: { skipped: 'Another run is in progress' },
          })
        );
        publishJobRun(ctx.db, { ...skipped, status: 'skipped' }, skipped.result, null);
        return { skipped: 'Another run is in progress' };
      }
      const run = await runs.save(
        runs.create({ job: name, jobId: job.id ?? null, trigger, status: 'running', startedAt: new Date() })
      );
      try {
        const result = await DEFINITIONS[name].run(ctx, job);
        await runs.update({ id: run.id }, { status: 'succeeded', finishedAt: new Date(), result: result as never });
        publishJobRun(ctx.db, { ...run, status: 'succeeded' }, result, null);
        return result;
      } catch (err) {
        const error = scrubError(err instanceof Error ? err.message : String(err));
        await runs.update({ id: run.id }, { status: 'failed', finishedAt: new Date(), error });
        publishJobRun(ctx.db, { ...run, status: 'failed' }, null, error);
        throw err;
      } finally {
        await mutex.release();
      }
    });
  }
}

/**
 * Creates or updates the cluster's schedules. A scheduler that already has the configured interval is
 * left alone, so a restart never moves the next run or starts an extra one. Interval 0 removes it.
 */
export async function upsertSchedules(log: JobLog): Promise<void> {
  const queue = getQueue('scheduled');
  if (!queue) return;
  for (const name of RETIRED_JOBS) {
    const removed = await queue.removeJobScheduler(`sched-${name}`).catch(() => false);
    if (removed) log.info({ job: name }, 'Retired job schedule removed');
    for (const id of [`startup-${name}`, runNowJobId(name)]) {
      const waiting = await queue.getJob(id).catch(() => undefined);
      if (waiting && (await waiting.getState()) !== 'active') await waiting.remove().catch(() => undefined);
    }
  }
  for (const name of SCHEDULED_JOBS) {
    const every = DEFINITIONS[name].intervalMs();
    const id = schedulerId(name);
    if (!(every > 0)) {
      await queue.removeJobScheduler(id).catch(() => undefined);
      continue;
    }
    const existing = await queue.getJobScheduler(id).catch(() => undefined);
    if (existing && Number(existing.every) === every) continue;
    await queue.upsertJobScheduler(
      id,
      { every, startDate: Date.now() + every },
      { name, data: { trigger: 'scheduled' } }
    );
    log.info({ job: name, everyMs: every }, 'Job schedule set');
  }
}

/** The malicious feed and EPSS scores are loaded at startup only when they have never been loaded successfully. */
export async function scheduleStartupJobs(db: DataSource): Promise<void> {
  if (config.malicious.syncIntervalHours >= 1) {
    const status = await db.getRepository(MaliciousSyncStatus).find({ take: 1 });
    if (!status[0]?.lastSuccessAt) {
      await enqueue('scheduled', 'malicious-feed-sync', { trigger: 'startup' }, { jobId: 'startup-malicious-feed-sync' });
    }
  }
  if (config.epss.enabled && config.epss.syncIntervalHours > 0) {
    const epss = await db.getRepository(EpssSyncStatus).findOne({ where: { id: EPSS_STATUS_ID } });
    if (!epss?.lastSuccessAt) await enqueue('scheduled', 'epss-sync', { trigger: 'startup' }, { jobId: 'startup-epss-sync' });
  }
}

export type RunNowResult = { queued: true; jobId: string } | { conflict: string } | { unavailable: true };

/** A manual run: refused while a run of the same job is queued or active anywhere in the cluster. */
export async function runNow(name: ScheduledJob, data: Record<string, unknown> = {}): Promise<RunNowResult> {
  const queue = getQueue('scheduled');
  const redis = jobsRedis();
  if (!queue || !redis) return { unavailable: true };
  if (await mutexHeld(redis, mutexKey(name))) return { conflict: 'Already running' };
  const id = runNowJobId(name);
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') {
      return { conflict: 'Already running' };
    }
    // A failed run kept for the Jobs page would otherwise make BullMQ ignore the new one with the same ID.
    await existing.remove().catch(() => undefined);
  }
  const jobId = await enqueue('scheduled', name, { ...data, trigger: 'manual' }, { jobId: id, attempts: 1 });
  return jobId ? { queued: true, jobId } : { unavailable: true };
}
