import { Counter, Gauge, Histogram, type Metric } from 'prom-client';

/** requirements_event_streaming.md R-D14, plus the losses §5.2 and L5 say are counted. */

export const eventsPublishedTotal = new Counter({
  name: 'depgate_events_published_total',
  help: 'Events recorded, by category and type',
  labelNames: ['category', 'type'],
  registers: [],
});

export const streamSentTotal = new Counter({
  name: 'depgate_stream_sent_total',
  help: 'Events a Log Streaming destination accepted',
  labelNames: ['destination'],
  registers: [],
});

export const streamDroppedTotal = new Counter({
  name: 'depgate_stream_dropped_total',
  help: 'Events not delivered to a destination: buffer_full, rejected, unknown_type, local_write, redis_unavailable',
  labelNames: ['destination', 'reason'],
  registers: [],
});

export const streamLagSeconds = new Gauge({
  name: 'depgate_stream_lag_seconds',
  help: "Age of a destination's oldest unacknowledged event",
  labelNames: ['destination'],
  registers: [],
});

export const streamBatchSeconds = new Histogram({
  name: 'depgate_stream_batch_seconds',
  help: 'Time to send one batch to a destination',
  labelNames: ['destination'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [],
});

export const summaryWritesLostTotal = new Counter({
  name: 'depgate_summary_writes_lost_total',
  help: 'Dashboard counts and package usage keys dropped because Redis was unavailable',
  labelNames: ['kind'],
  registers: [],
});

export const auditRowsLostTotal = new Counter({
  name: 'depgate_audit_rows_lost_total',
  help: 'Audit Log rows that could not be written',
  labelNames: ['type'],
  registers: [],
});

export const EVENT_METRICS: Metric[] = [
  eventsPublishedTotal,
  streamSentTotal,
  streamDroppedTotal,
  streamLagSeconds,
  streamBatchSeconds,
  summaryWritesLostTotal,
  auditRowsLostTotal,
];
