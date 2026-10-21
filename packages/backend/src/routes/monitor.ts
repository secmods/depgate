import { Readable } from 'node:stream';
import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyReply } from 'fastify';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import {
  MonitorError,
  approvePackages,
  getMonitorPolicy,
  listMonitorPolicies,
  listPackages,
  monitorCsv,
  monitorImpact,
  monitorPolicySummary,
  parseLastSeenWithin,
  reasonGroups,
  restartMonitoring,
  startRecheck,
  type PackageFilters,
  type StatusFilter,
} from '../services/monitor-service.js';

const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];
const STATUSES: StatusFilter[] = ['will_block', 'partly', 'approved', 'all'];
const UUID = '^[0-9a-fA-F-]{36}$';

type PackageQuery = {
  policyId: string;
  reasonKey?: string;
  ecosystem?: string;
  status?: StatusFilter;
  lastSeenWithin?: string;
  search?: string;
  repository?: string;
  sort?: 'downloads' | 'last_seen';
  limit?: string;
  offset?: string;
  granularity?: 'package' | 'version';
};

const packageQuerySchema = {
  type: 'object',
  required: ['policyId'],
  properties: {
    policyId: { type: 'string', pattern: UUID },
    reasonKey: { type: 'string' },
    ecosystem: { type: 'string', enum: ECOSYSTEMS },
    status: { type: 'string', enum: STATUSES },
    lastSeenWithin: { type: 'string' },
    search: { type: 'string' },
    repository: { type: 'string', maxLength: 64 },
    sort: { type: 'string', enum: ['downloads', 'last_seen'] },
    limit: { type: 'string' },
    offset: { type: 'string' },
    granularity: { type: 'string', enum: ['package', 'version'] },
  },
} as const;

function filtersFrom(query: PackageQuery): PackageFilters {
  return {
    policyId: query.policyId,
    reasonKey: query.reasonKey || undefined,
    ecosystem: query.ecosystem || undefined,
    status: query.status ?? 'will_block',
    lastSeenDays: parseLastSeenWithin(query.lastSeenWithin),
    search: query.search || undefined,
    repository: query.repository || undefined,
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof MonitorError) return reply.status(err.status).send({ error: err.message });
  throw err;
}

function fileSafe(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'policy';
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Monitor mode report, approvals, export and restart. Security only. */
const monitorRoutes: FastifyPluginAsync = async (fastify) => {
  const security = fastify.authenticate({ roles: ['Security'] });

  fastify.get<{ Querystring: { status?: 'monitoring' | 'enforced' } }>(
    '/api/admin/monitor/policies',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        summary: 'Monitoring policies with what each would block',
        querystring: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['monitoring', 'enforced'] } },
        },
      },
    },
    async (request, reply) => {
      const items = await listMonitorPolicies(fastify.db, fastify.redis, request.query.status ?? 'monitoring');
      return reply.send({ items });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/admin/monitor/policies/:id',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        summary: "One policy's monitoring summary, for its details page",
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await monitorPolicySummary(fastify.db, fastify.redis, request.params.id));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.get<{ Params: { id: string }; Querystring: { lastSeenWithin?: string } }>(
    '/api/admin/monitor/policies/:id/reasons',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
        querystring: { type: 'object', properties: { lastSeenWithin: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      try {
        await getMonitorPolicy(fastify.db, request.params.id);
        const items = await reasonGroups(fastify.db, request.params.id, parseLastSeenWithin(request.query.lastSeenWithin));
        return reply.send({ items });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/admin/monitor/policies/:id/impact',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
      },
    },
    async (request, reply) => {
      try {
        const policy = await getMonitorPolicy(fastify.db, request.params.id);
        return reply.send(await monitorImpact(fastify.db, policy));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.get<{ Querystring: PackageQuery }>(
    '/api/admin/monitor/packages',
    { onRequest: [security], schema: { tags: ['Policies'], querystring: packageQuerySchema } },
    async (request, reply) => {
      try {
        await getMonitorPolicy(fastify.db, request.query.policyId);
        const limit = Math.min(Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0);
        const page = await listPackages(fastify.db, filtersFrom(request.query), {
          sort: request.query.sort ?? 'downloads',
          limit,
          offset,
        });
        return reply.send({ ...page, limit, offset });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.get<{ Querystring: PackageQuery }>(
    '/api/admin/monitor/packages.csv',
    { onRequest: [security], schema: { tags: ['Policies'], querystring: packageQuerySchema } },
    async (request, reply) => {
      try {
        const policy = await getMonitorPolicy(fastify.db, request.query.policyId);
        const filters = filtersFrom(request.query);
        const granularity = request.query.granularity ?? 'package';
        const filename = `depgate-monitoring-${fileSafe(policy.name)}-${timestamp()}.csv`;
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        reply.header('Cache-Control', 'no-store');
        return reply.send(Readable.from(prefixBom(monitorCsv(fastify.db, filters, granularity))));
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.post<{
    Body: {
      policyId: string;
      items: { ecosystem: string; packageName: string; versions: string[] }[];
      expiresAt: string;
      reason: string;
    };
  }>(
    '/api/admin/monitor/approve',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        summary: 'Approve packages for one policy (policy-scoped exceptions)',
        body: {
          type: 'object',
          required: ['policyId', 'items', 'expiresAt', 'reason'],
          properties: {
            policyId: { type: 'string', pattern: UUID },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              items: {
                type: 'object',
                required: ['ecosystem', 'packageName', 'versions'],
                properties: {
                  ecosystem: { type: 'string', enum: ECOSYSTEMS },
                  packageName: { type: 'string', minLength: 1, maxLength: 512 },
                  versions: { type: 'array', minItems: 1, items: { type: 'string', maxLength: 256 } },
                },
              },
            },
            expiresAt: { type: 'string', format: 'date-time' },
            reason: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const policy = await getMonitorPolicy(fastify.db, request.body.policyId);
        const user = request.user as { username?: string; name?: string; sub?: string } | undefined;
        const approvedBy = user?.username ?? user?.name ?? user?.sub ?? 'unknown';
        const audits = await approvePackages(fastify.db, policy, {
          items: request.body.items,
          expiresAt: new Date(request.body.expiresAt),
          reason: request.body.reason,
          approvedBy,
        });
        const { reqIp, userAgent, requester } = getRequestContext(request);
        for (const { action, exception } of audits) {
          logAudit(fastify.db, {
            requesterIp: reqIp,
            userAgent,
            requester,
            ecosystem: exception.ecosystem,
            packageName: `${exception.packageName}@${exception.version}`,
            resolvedVersion: exception.version,
            decision: action,
            policyId: policy.id,
            policyName: policy.name,
            conditionReasons: [`Approved for policy "${policy.name}": ${exception.reason ?? ''}`.trim()],
          });
        }
        return reply.status(200).send({
          items: audits.map(({ action, exception }) => ({
            id: exception.id,
            action: action === 'EXCEPTION_ADDED' ? 'created' : 'widened',
            ecosystem: exception.ecosystem,
            packageName: exception.packageName,
            version: exception.version,
            expiresAt: exception.expiresAt.toISOString(),
            policyId: policy.id,
          })),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/monitor/policies/:id/restart',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        summary: 'Restart monitoring: clear recorded rows and reset "Monitoring since"',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
      },
    },
    async (request, reply) => {
      try {
        const policy = await getMonitorPolicy(fastify.db, request.params.id);
        const cleared = await restartMonitoring(fastify.db, policy);
        const { reqIp, userAgent, requester } = getRequestContext(request);
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester,
          ecosystem: 'policy',
          packageName: policy.name,
          decision: 'POLICY_UPDATED',
          policyId: policy.id,
          policyName: policy.name,
          conditionReasons: [`Monitoring restarted (${cleared} rows cleared)`],
        });
        return reply.send({ cleared, modeChangedAt: policy.modeChangedAt?.toISOString() ?? null });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );

  /** Start the recheck again after it failed (the report shows "Recheck failed, retry"). */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/monitor/policies/:id/recheck',
    {
      onRequest: [security],
      schema: {
        tags: ['Policies'],
        summary: 'Recheck the recorded downloads against the current rule',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: UUID } } },
      },
    },
    async (request, reply) => {
      try {
        const policy = await getMonitorPolicy(fastify.db, request.params.id);
        if (policy.mode !== 'monitor') return reply.status(400).send({ error: 'Only a policy in monitor mode is rechecked' });
        await startRecheck({ db: fastify.db, redis: fastify.redis, log: fastify.log }, policy);
        return reply.status(202).send({ recheck: true });
      } catch (err) {
        return sendError(reply, err);
      }
    }
  );
};

/** A byte-order mark so spreadsheet apps read the file as UTF-8, like the UI's own exports. */
async function* prefixBom(rows: AsyncGenerator<string>): AsyncGenerator<string> {
  yield '\uFEFF';
  yield* rows;
}

export default fp(monitorRoutes);
