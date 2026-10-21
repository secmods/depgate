import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';

const DASHBOARD_ECOSYSTEMS = ['npm', 'pypi', 'maven', 'go', 'nuget', 'cargo', 'composer', 'rubygems'] as const;

/**
 * Figures come from the hourly summary tables (requirements_event_streaming.md §5.3), not from ledger rows:
 * allowed downloads are counted, never stored one by one. An hour bucket counts when it overlaps the range.
 */
function fromHour(from: Date): Date {
  return new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
}

function getFromDate(range: string): Date {
  const now = new Date();
  switch (range) {
    case '24h':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
}

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['Security'] });

  fastify.get<{
    Querystring: { range?: string };
  }>(
    '/api/admin/dashboard/stats',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Dashboard'],
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['24h', '7d', '30d'], description: 'Time range for stats' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              allow: { type: 'number' },
              block: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const range = request.query.range ?? '30d';
      const from = fromHour(getFromDate(range));
      const rows: Array<{ decision: string; count: string }> = await fastify.db.query(
        `SELECT decision, SUM(count)::bigint AS count FROM decision_counts_hourly
          WHERE hour >= $1 AND decision IN ('ALLOW', 'BLOCK_ENFORCE') GROUP BY decision`,
        [from]
      );
      const allow = Number(rows.find((row) => row.decision === 'ALLOW')?.count ?? 0);
      const block = Number(rows.find((row) => row.decision === 'BLOCK_ENFORCE')?.count ?? 0);
      const total = allow + block;

      return reply.send({
        total,
        allow,
        block,
      });
    }
  );

  fastify.get<{
    Querystring: { range?: string };
  }>(
    '/api/admin/dashboard/charts',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Dashboard'],
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: ['24h', '7d', '30d'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              topPackagesAllowed: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ecosystem: { type: 'string' },
                    packageName: { type: 'string' },
                    count: { type: 'number' },
                  },
                },
              },
              topPackagesBlocked: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ecosystem: { type: 'string' },
                    packageName: { type: 'string' },
                    count: { type: 'number' },
                  },
                },
              },
              byEcosystem: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ecosystem: { type: 'string' },
                    total: { type: 'number' },
                    allow: { type: 'number' },
                    block: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const range = request.query.range ?? '30d';
      const from = fromHour(getFromDate(range));
      const topN = 20;
      const top = (decision: string) =>
        fastify.db.query(
          `SELECT ecosystem, package_name AS "packageName", SUM(count)::bigint AS count FROM package_counts_hourly
            WHERE hour >= $1 AND decision = $2
            GROUP BY ecosystem, package_name ORDER BY count DESC, package_name LIMIT $3`,
          [from, decision, topN]
        ) as Promise<Array<{ ecosystem: string; packageName: string; count: string }>>;

      const [topAllowed, topBlocked, byEcosystem] = await Promise.all([
        top('ALLOW'),
        top('BLOCK_ENFORCE'),
        fastify.db.query(
          `SELECT ecosystem,
                  SUM(count)::bigint AS total,
                  SUM(count) FILTER (WHERE decision = 'ALLOW')::bigint AS allow,
                  SUM(count) FILTER (WHERE decision = 'BLOCK_ENFORCE')::bigint AS block
             FROM decision_counts_hourly
            WHERE hour >= $1 AND decision IN ('ALLOW', 'BLOCK_ENFORCE') AND ecosystem = ANY($2::text[])
            GROUP BY ecosystem ORDER BY total DESC`,
          [from, [...DASHBOARD_ECOSYSTEMS]]
        ) as Promise<Array<Record<string, unknown>>>,
      ]);

      const toNum = (r: { count?: unknown }) => ({ ...r, count: Number(r.count ?? 0) });
      const toEcoNum = (r: Record<string, unknown>) => ({
        ...r,
        total: Number(r.total ?? 0),
        allow: Number(r.allow ?? 0),
        block: Number(r.block ?? 0),
      });

      return reply.send({
        topPackagesAllowed: topAllowed.map(toNum),
        topPackagesBlocked: topBlocked.map(toNum),
        byEcosystem: byEcosystem.map(toEcoNum),
      });
    }
  );
};

export default fp(dashboardRoutes);
