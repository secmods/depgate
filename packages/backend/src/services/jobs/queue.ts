import Redis from 'ioredis';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { config } from '../../config.js';
import { jobDurationSeconds, jobsFailedTotal, jobsFallbackTotal } from './metrics.js';
import { jobIds, scrubError } from './ids.js';

/**
 * Background jobs on BullMQ (requirements_job_queue.md). Every replica can add jobs and, unless
 * WORKERS says otherwise, process them. Completed jobs are removed at once; failed ones are logged,
 * counted, and kept for 7 days (at most 500 per queue) so Security can retry them.
 */

export const QUEUE_NAMES = ['webhooks', 'scheduled', 'email', 'monitor'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type JobLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** A handler. `token` is the worker lock token, for `job.moveToDelayed`. */
export type JobHandler = (job: Job, token?: string) => Promise<unknown>;

/** Thrown by a handler to retry after a given delay (for example HTTP 429 with Retry-After). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number
  ) {
    super(message);
    this.name = 'RetryLaterError';
  }
}

type QueueSpec = {
  concurrency: number;
  attempts: number;
  limiter?: { max: number; duration: number };
  /** Delay before retry `attemptsMade` (1 after the first failure). */
  backoff: (attemptsMade: number) => number;
};

const DAY_SECONDS = 86_400;

export function queueSpec(queue: QueueName): QueueSpec {
  switch (queue) {
    case 'webhooks':
      return {
        concurrency: 10,
        attempts: config.jobs.webhookMaxAttempts,
        backoff: (n) => config.jobs.webhookBackoffMs * 2 ** Math.max(n - 1, 0),
      };
    case 'email':
      return {
        concurrency: 2,
        attempts: 5,
        limiter: { max: 1, duration: 1000 },
        backoff: (n) => config.jobs.emailBackoffMs * 2 ** Math.max(n - 1, 0),
      };
    case 'monitor':
      return { concurrency: 2, attempts: 3, backoff: (n) => 30_000 * n };
    case 'scheduled':
      return { concurrency: 1, attempts: 3, backoff: (n) => 60_000 * n };
  }
}

/** The delay BullMQ waits before the next attempt: Retry-After when the handler gave one, else the queue's backoff. */
export function retryDelay(queue: QueueName, attemptsMade: number, err?: Error): number {
  if (err instanceof RetryLaterError || (err && typeof (err as RetryLaterError).retryAfterMs === 'number')) {
    return Math.min(Math.max((err as RetryLaterError).retryAfterMs, 0), 3_600_000);
  }
  return queueSpec(queue).backoff(attemptsMade);
}

export function defaultJobOptions(queue: QueueName): JobsOptions {
  return {
    attempts: queueSpec(queue).attempts,
    backoff: { type: 'custom' },
    removeOnComplete: true,
    removeOnFail: { age: 7 * DAY_SECONDS, count: 500 },
  };
}

/** Whether this attempt was the last one: attempts used up, or a failure that is never retried. */
export function isFinalFailure(job: Pick<Job, 'attemptsMade' | 'opts'>, err: Error): boolean {
  return err.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
}

type Runtime = {
  prefix: string;
  producer: Redis;
  workerConnection: Redis | null;
  queues: Map<QueueName, Queue>;
  workers: Worker[];
  log: JobLog;
};

const handlers = new Map<QueueName, Map<string, JobHandler>>();
let runtime: Runtime | null = null;

/** Handlers can be registered before the queues start (module load) and in tests. */
export function registerHandler(queue: QueueName, name: string, handler: JobHandler): void {
  let map = handlers.get(queue);
  if (!map) {
    map = new Map();
    handlers.set(queue, map);
  }
  map.set(name, handler);
}

export function handlerFor(queue: QueueName, name: string): JobHandler | undefined {
  return handlers.get(queue)?.get(name);
}

export function parseWorkerSetting(value: string): Set<QueueName> {
  const text = value.trim().toLowerCase();
  if (text === '' || text === 'all') return new Set(QUEUE_NAMES);
  if (text === 'none') return new Set();
  return new Set(text.split(',').map((part) => part.trim()).filter((part): part is QueueName => (QUEUE_NAMES as readonly string[]).includes(part)));
}

export function jobsRunning(): boolean {
  return runtime !== null;
}

export function getQueue(name: QueueName): Queue | null {
  return runtime?.queues.get(name) ?? null;
}

export function queuePrefix(): string {
  return runtime?.prefix ?? config.jobs.prefix;
}

/** The producer connection, for small coordination keys such as run mutexes. */
export function jobsRedis(): Redis | null {
  return runtime?.producer ?? null;
}

const ADD_TIMEOUT_MS = 2000;

/**
 * Adds a job. Returns its ID, or null when the queues are not running or Redis did not answer:
 * the caller then falls back to doing the work in-process (Q8). Never throws.
 */
export async function enqueue(
  queue: QueueName,
  name: string,
  data: Record<string, unknown>,
  opts: JobsOptions = {}
): Promise<string | null> {
  const target = getQueue(queue);
  if (!target) {
    jobsFallbackTotal.inc({ queue });
    return null;
  }
  try {
    const job = await Promise.race([
      target.add(name, data, { ...defaultJobOptions(queue), ...opts }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Queue did not answer')), ADD_TIMEOUT_MS)),
    ]);
    return job.id ?? null;
  } catch (err) {
    jobsFallbackTotal.inc({ queue });
    runtime?.log.warn({ err: scrubError(String((err as Error)?.message ?? err)), queue, job: name }, 'Could not queue job; running it in-process');
    return null;
  }
}

export function logFailure(log: JobLog, queue: QueueName, job: Job | undefined, err: Error): void {
  if (!job) return;
  const final = isFinalFailure(job, err);
  jobsFailedTotal.inc({ queue, job: job.name, final: String(final) });
  const fields = {
    queue,
    job: job.name,
    jobId: job.id,
    attempt: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    error: scrubError(err.message ?? String(err)),
    ...jobIds(job.data),
  };
  if (final) log.error(fields, 'Job failed');
  else log.warn({ ...fields, retryInMs: retryDelay(queue, job.attemptsMade, err) }, 'Job attempt failed; retrying');
}

function processorFor(queue: QueueName) {
  return async (job: Job, token?: string) => {
    const handler = handlerFor(queue, job.name);
    if (!handler) throw new Error(`No handler for ${queue}/${job.name}`);
    const end = jobDurationSeconds.startTimer({ queue, job: job.name });
    try {
      return await handler(job, token);
    } finally {
      end();
    }
  };
}

export type StartOptions = {
  log: JobLog;
  url?: string;
  prefix?: string;
  workers?: Set<QueueName>;
};

/** Connects the queues and starts the workers this replica runs. */
export async function startJobs(opts: StartOptions): Promise<void> {
  if (runtime) return;
  const url = opts.url ?? config.jobs.redisUrl;
  const prefix = opts.prefix ?? config.jobs.prefix;
  const producer = new Redis(url, { protocol: 2, maxRetriesPerRequest: 1, enableOfflineQueue: true, lazyConnect: false });
  producer.on('error', (err) => opts.log.warn({ err: scrubError(err.message) }, 'Queue Redis error'));
  const queues = new Map<QueueName, Queue>();
  for (const name of QUEUE_NAMES) {
    const queue = new Queue(name, { connection: producer, prefix, defaultJobOptions: defaultJobOptions(name) });
    queue.on('error', (err) => opts.log.warn({ err: scrubError(err.message), queue: name }, 'Queue error'));
    queues.set(name, queue);
  }
  const wanted = opts.workers ?? parseWorkerSetting(config.jobs.workers);
  const workerConnection = wanted.size ? new Redis(url, { protocol: 2, maxRetriesPerRequest: null }) : null;
  workerConnection?.on('error', (err) => opts.log.warn({ err: scrubError(err.message) }, 'Worker Redis error'));
  const workers: Worker[] = [];
  for (const name of QUEUE_NAMES) {
    if (!wanted.has(name)) continue;
    workers.push(createWorker(name, workerConnection!, prefix, opts.log));
  }
  runtime = { prefix, producer, workerConnection, queues, workers, log: opts.log };
}

/** A worker for one queue. Also used by tests to stand in for another replica. */
export function createWorker(name: QueueName, connection: Redis, prefix: string, log: JobLog): Worker {
  const spec = queueSpec(name);
  const worker = new Worker(name, processorFor(name), {
    connection,
    prefix,
    concurrency: spec.concurrency,
    limiter: spec.limiter,
    lockDuration: config.jobs.lockDurationMs,
    stalledInterval: config.jobs.lockDurationMs,
    settings: { backoffStrategy: (attemptsMade, _type, err) => retryDelay(name, attemptsMade, err) },
  });
  worker.on('failed', (job, err) => logFailure(log, name, job, err));
  worker.on('error', (err) => log.warn({ err: scrubError(err.message), queue: name }, 'Worker error'));
  return worker;
}

const SHUTDOWN_GRACE_MS = 30_000;

/** Workers stop taking jobs and finish the active ones for up to 30 s; the rest go back to the queue. */
export async function stopJobs(graceMs = SHUTDOWN_GRACE_MS): Promise<void> {
  const current = runtime;
  if (!current) return;
  runtime = null;
  await Promise.all(
    current.workers.map(async (worker) => {
      const closed = worker.close().then(() => true);
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs).unref?.());
      if (!(await Promise.race([closed, timeout]))) await worker.close(true).catch(() => undefined);
    })
  );
  await Promise.all([...current.queues.values()].map((queue) => queue.close().catch(() => undefined)));
  current.workerConnection?.disconnect();
  current.producer.disconnect();
}
