import { Counter, type Metric } from 'prom-client';

/**
 * Monitor mode counters. Module-level so the recorder can count without the Fastify
 * instance; the metrics plugin adds them to its registry.
 */
export const monitorMatchesTotal = new Counter({
  name: 'depgate_monitor_matches_total',
  help: 'Downloads a monitoring policy would have blocked, by ecosystem',
  labelNames: ['ecosystem'],
  registers: [],
});

export const monitorRecordErrorsTotal = new Counter({
  name: 'depgate_monitor_record_errors_total',
  help: 'Monitor matches that could not be recorded (Redis or database errors)',
  registers: [],
});

export const monitorRowsCappedTotal = new Counter({
  name: 'depgate_monitor_rows_capped_total',
  help: 'New versions not stored because the policy reached its monitor row limit',
  labelNames: ['policy'],
  registers: [],
});

export const MONITOR_METRICS: Metric<string>[] = [monitorMatchesTotal, monitorRecordErrorsTotal, monitorRowsCappedTotal];
