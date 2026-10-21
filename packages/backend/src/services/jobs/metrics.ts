import { Counter, Gauge, Histogram, type Metric } from 'prom-client';

export const jobsFailedTotal = new Counter({
  name: 'depgate_jobs_failed_total',
  help: 'Failed job attempts. final="true" when no retry follows',
  labelNames: ['queue', 'job', 'final'],
  registers: [],
});

export const jobsFallbackTotal = new Counter({
  name: 'depgate_jobs_fallback_total',
  help: 'Jobs that could not be queued and ran in-process instead (webhooks, email) or were skipped',
  labelNames: ['queue'],
  registers: [],
});

export const jobDurationSeconds = new Histogram({
  name: 'depgate_job_duration_seconds',
  help: 'Time a job attempt took',
  labelNames: ['queue', 'job'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
  registers: [],
});

export const ledgerRowsLostTotal = new Counter({
  name: 'depgate_ledger_rows_lost_total',
  help: 'Decision Ledger rows that could not be written',
  labelNames: ['decision'],
  registers: [],
});

/** Filled on scrape by the jobs plugin: queue depth and Redis memory. */
export const queueJobsGauge = new Gauge({
  name: 'depgate_queue_jobs',
  help: 'Jobs per queue and state',
  labelNames: ['queue', 'state'],
  registers: [],
});

export const redisMemoryGauge = new Gauge({
  name: 'depgate_redis_memory_bytes',
  help: 'Redis memory: used and maxmemory (0 means no limit)',
  labelNames: ['kind'],
  registers: [],
});

export const JOB_METRICS: Metric[] = [
  jobsFailedTotal,
  jobsFallbackTotal,
  jobDurationSeconds,
  ledgerRowsLostTotal,
  queueJobsGauge,
  redisMemoryGauge,
];
