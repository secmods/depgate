import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { Registry, Counter, Histogram } from 'prom-client';
import { MONITOR_METRICS } from '../services/monitor-metrics.js';
import { JOB_METRICS } from '../services/jobs/metrics.js';
import { AUTH_METRICS } from '../services/auth-metrics.js';
import { EVENT_METRICS } from '../services/events/metrics.js';
import { ARTIFACT_CACHE_METRICS } from '../services/artifact-cache/metrics.js';
import { refreshJobGauges } from './jobs.js';
import { config } from '../config.js';

export type PackageCheckOutcome = 'ok' | 'not_found' | 'upstream_error' | 'rate_limited' | 'invalid';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      recordDecision: (decision: string) => void;
      recordRequest: (path: string, status: number) => void;
      recordPackageCheck: (ecosystem: string, outcome: PackageCheckOutcome, seconds?: number) => void;
      /** Prometheus exposition text, for the management port. */
      render: () => Promise<{ contentType: string; body: string }>;
    };
  }
}

const metricsPlugin: FastifyPluginAsync = async (fastify) => {
  const register = new Registry();

  const decisionsTotal = new Counter({
    name: 'depgate_decisions_total',
    help: 'Total number of gateway decisions by type',
    labelNames: ['decision'],
    registers: [register],
  });

  const requestsTotal = new Counter({
    name: 'depgate_requests_total',
    help: 'Total HTTP requests by path and status',
    labelNames: ['path', 'status'],
    registers: [register],
  });

  const packageChecksTotal = new Counter({
    name: 'depgate_package_checks_total',
    help: 'Package checks by ecosystem and outcome',
    labelNames: ['ecosystem', 'outcome'],
    registers: [register],
  });

  const packageCheckDuration = new Histogram({
    name: 'depgate_package_check_duration_seconds',
    help: 'Time to answer a package check',
    labelNames: ['ecosystem'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2.5, 5, 10, 15],
    registers: [register],
  });

  for (const metric of MONITOR_METRICS) register.registerMetric(metric);
  for (const metric of JOB_METRICS) register.registerMetric(metric);
  for (const metric of AUTH_METRICS) register.registerMetric(metric);
  for (const metric of EVENT_METRICS) register.registerMetric(metric);
  for (const metric of ARTIFACT_CACHE_METRICS) register.registerMetric(metric);

  fastify.decorate('metrics', {
    recordDecision(decision: string) {
      decisionsTotal.inc({ decision });
    },
    recordRequest(path: string, status: number) {
      requestsTotal.inc({ path, status: String(status) });
    },
    recordPackageCheck(ecosystem: string, outcome: PackageCheckOutcome, seconds?: number) {
      packageChecksTotal.inc({ ecosystem, outcome });
      if (seconds != null) packageCheckDuration.observe({ ecosystem }, seconds);
    },
    async render() {
      await refreshJobGauges();
      return { contentType: register.contentType, body: await register.metrics() };
    },
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const path = (request as { routerPath?: string }).routerPath ?? request.routeOptions?.url ?? request.url;
    requestsTotal.inc({ path, status: String(reply.statusCode) });
    done();
  });

  // With a management port, metrics stay on the private network only.
  if (config.managementPort) return;

  fastify.get('/metrics', { schema: { tags: ['Health'], security: [] } }, async (_request, reply) => {
    const { contentType, body } = await fastify.metrics.render();
    reply.header('Content-Type', contentType);
    return reply.send(body);
  });
};

export default fp(metricsPlugin);
