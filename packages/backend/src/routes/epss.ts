import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ROLE_SECURITY, ROLE_USER } from '../auth/roles.js';
import { config } from '../config.js';
import { getRequestContext } from '../services/audit-service.js';
import { runNow } from '../services/jobs/scheduled.js';
import {
  bindEpssLogger,
  claimEpssSync,
  lookupEpss,
  readEpssStatus,
  refreshEpssCves,
  runClaimedEpssSync,
} from '../services/epss.js';
import { isCveId } from '../services/epss-feed.js';

const REFRESH_MAX = 20;

const statusSchema = {
  type: 'object',
  properties: {
    state: { type: 'string' },
    trigger: { type: 'string', nullable: true },
    startedAt: { type: 'string', nullable: true },
    finishedAt: { type: 'string', nullable: true },
    lastSuccessAt: { type: 'string', nullable: true },
    scoreDate: { type: 'string', nullable: true },
    modelVersion: { type: 'string', nullable: true },
    rowCount: { type: 'number', nullable: true },
    lastError: { type: 'string', nullable: true },
    feedSource: { type: 'string', nullable: true },
    enabled: { type: 'boolean' },
    stale: { type: 'boolean' },
    staleAfterHours: { type: 'number' },
  },
} as const;

/** EPSS data (requirements_epss.md §8): sync status, a manual sync, and one CVE's score for tooltips. */
const epssRoutes: FastifyPluginAsync = async (fastify) => {
  bindEpssLogger(fastify.log);
  const requireRead = fastify.authenticate({ roles: [ROLE_USER, ROLE_SECURITY] });
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });

  fastify.get(
    '/api/admin/epss/status',
    { onRequest: [requireRead], schema: { tags: ['EPSS'], response: { 200: statusSchema } } },
    async (_request, reply) => reply.send(await readEpssStatus(fastify.db))
  );

  fastify.post(
    '/api/admin/epss/sync',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['EPSS'],
        response: {
          202: { type: 'object', properties: { started: { type: 'boolean' }, jobId: { type: 'string', nullable: true } } },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          409: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      if (!config.epss.enabled) return reply.status(400).send({ error: 'EPSS is turned off (EPSS_ENABLED=false)' });
      const { reqIp, userAgent, requester } = getRequestContext(request);
      const queued = await runNow('epss-sync', { requesterIp: reqIp, userAgent, requester });
      if ('conflict' in queued) return reply.status(409).send({ error: 'An EPSS sync is already running' });
      if ('queued' in queued) return reply.status(202).send({ started: true, jobId: queued.jobId });

      // No job queue: run here, guarded by the database claim.
      if (!(await claimEpssSync(fastify.db, 'manual'))) {
        return reply.status(409).send({ error: 'An EPSS sync is already running' });
      }
      setImmediate(() => {
        runClaimedEpssSync({ db: fastify.db, trigger: 'manual', requester, requesterIp: reqIp, userAgent }).catch((err) =>
          fastify.log.warn(err, 'EPSS sync failed')
        );
      });
      return reply.status(202).send({ started: true, jobId: null });
    }
  );

  fastify.post<{ Body: { cves?: unknown } }>(
    '/api/admin/epss/refresh',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['EPSS'],
        summary: `Refresh up to ${REFRESH_MAX} CVEs from the FIRST API`,
        body: { type: 'object', required: ['cves'], properties: { cves: { type: 'array', items: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const raw = Array.isArray(request.body?.cves) ? request.body.cves.map(String) : [];
      const cves = [...new Set(raw.map((id) => id.trim().toUpperCase()))];
      if (cves.length === 0 || cves.length > REFRESH_MAX) {
        return reply.status(400).send({ error: `Give between 1 and ${REFRESH_MAX} CVE ids` });
      }
      const invalid = cves.find((id) => !isCveId(id));
      if (invalid) return reply.status(400).send({ error: `"${invalid}" is not a CVE id` });
      try {
        const updated = await refreshEpssCves(fastify.db, cves);
        return reply.send({ updated: [...updated].map(([cve, value]) => ({ cve, ...value })) });
      } catch (err) {
        return reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  fastify.get<{ Params: { cve: string } }>(
    '/api/admin/epss/:cve',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['EPSS'],
        params: { type: 'object', required: ['cve'], properties: { cve: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              cve: { type: 'string' },
              score: { type: 'number' },
              percentile: { type: 'number' },
              scoreDate: { type: 'string', nullable: true },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const cve = request.params.cve.trim().toUpperCase();
      if (!isCveId(cve)) return reply.status(400).send({ error: `"${request.params.cve}" is not a CVE id` });
      const { scores, scoreDate } = await lookupEpss(fastify.db, [cve]);
      const value = scores.get(cve);
      if (!value) return reply.status(404).send({ error: `No EPSS score for ${cve}` });
      return reply.send({ cve, score: value.score, percentile: value.percentile, scoreDate });
    }
  );
};

export default fp(epssRoutes);
