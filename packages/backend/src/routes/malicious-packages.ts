import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { MaliciousFeedState } from '../db/entities/MaliciousFeedState.js';
import { MaliciousPackage, MaliciousOverrideStatus } from '../db/entities/MaliciousPackage.js';
import { MaliciousSyncStatus } from '../db/entities/MaliciousSyncStatus.js';
import { FEED_STATE_ID } from '../services/malicious-feed.js';
import { claimMaliciousSync, runClaimedMaliciousSync } from '../services/malicious-sync-status.js';
import { findMaliciousEntry } from '../services/malicious-sync.js';
import { runNow } from '../services/jobs/scheduled.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { STORED_VERSION_MAX_LENGTH, versionSpecError } from '../services/version-range.js';

const VALID_OVERRIDE_STATUSES: MaliciousOverrideStatus[] = ['BLOCK', 'ALLOW'];
const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'crates.io', 'rubygems'];

const maliciousPackagesRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });

  fastify.get(
    '/api/admin/malicious-packages/metadata',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Malicious Packages'],
        response: {
          200: {
            type: 'object',
            properties: {
              lastSyncAt: { type: 'string', nullable: true },
              syncStatus: {
                type: 'object',
                nullable: true,
                properties: {
                  status: { type: 'string', enum: ['running', 'completed', 'failed'] },
                  startedAt: { type: 'string' },
                  phase: { type: 'string', nullable: true },
                  ecosystem: { type: 'string', nullable: true },
                  fetched: { type: 'number', nullable: true },
                  added: { type: 'number', nullable: true },
                  total: { type: 'number', nullable: true },
                  removed: { type: 'number', nullable: true },
                  updated: { type: 'number', nullable: true },
                  error: { type: 'string', nullable: true },
                  mode: { type: 'string', nullable: true },
                },
              },
              feed: {
                type: 'object',
                nullable: true,
                properties: {
                  watermark: { type: 'string' },
                  schemaVersion: { type: 'string' },
                  upstreamRepo: { type: 'string', nullable: true },
                  upstreamCommit: { type: 'string', nullable: true },
                  changesSince: { type: 'string' },
                  changesWindowDays: { type: 'number' },
                  totalRecords: { type: 'number' },
                  appliedAt: { type: 'string' },
                  ecosystems: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const row = await fastify.db.getRepository(MaliciousFeedState).findOne({ where: { id: FEED_STATE_ID } });
      const run = await fastify.db.getRepository(MaliciousSyncStatus).findOne({ where: { id: FEED_STATE_ID } });
      const syncStatus = run && run.status !== 'idle'
        ? {
            status: run.status,
            startedAt: isoTimestamp(run.startedAt) ?? new Date(0).toISOString(),
            phase: run.phase,
            ecosystem: run.ecosystem,
            added: run.added,
            removed: run.removed,
            updated: run.updated,
            total: run.total,
            error: run.error,
            mode: run.mode,
          }
        : null;
      const lastSyncAt = isoTimestamp(run?.lastSuccessAt) ?? isoTimestamp(row?.appliedAt);
      const appliedAt = row?.appliedAt;
      const feed = row
        ? {
            watermark: row.watermark,
            schemaVersion: row.schemaVersion,
            upstreamRepo: row.upstreamRepo,
            upstreamCommit: row.upstreamCommit,
            changesSince: row.changesSince,
            changesWindowDays: row.changesWindowDays,
            totalRecords: row.totalRecords,
            appliedAt: appliedAt instanceof Date ? appliedAt.toISOString() : String(appliedAt),
            ecosystems: row.ecosystems,
          }
        : null;
      return reply.send({ lastSyncAt, syncStatus, feed });
    }
  );

  fastify.get<{
    Querystring: { ecosystem?: string; name?: string; limit?: string; offset?: string; source?: string; status?: string };
  }>(
    '/api/admin/malicious-packages',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Malicious Packages'],
        querystring: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string' },
            name: { type: 'string' },
            limit: { type: 'string' },
            offset: { type: 'string' },
            source: { type: 'string', enum: ['all', 'custom', 'feed'] },
            status: { type: 'string', enum: ['BLOCK', 'ALLOW'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    ecosystem: { type: 'string' },
                    reason: { type: 'string', nullable: true },
                    sourceUrl: { type: 'string', nullable: true },
                    source: { type: 'string' },
                    versionRange: { type: 'string', nullable: true },
                    overrideStatus: { type: 'string' },
                    overrideReason: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                  },
                },
              },
              total: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { ecosystem, name, limit: limitStr, offset: offsetStr, source, status } = request.query;
      const limit = Math.min(Math.max(parseInt(limitStr ?? '50', 10) || 50, 1), 200);
      const offset = Math.max(parseInt(offsetStr ?? '0', 10) || 0, 0);

      const repo = fastify.db.getRepository(MaliciousPackage);
      const qb = repo.createQueryBuilder('m');

      if (source === 'custom') qb.andWhere("m.source = 'custom'");
      else if (source === 'feed') qb.andWhere("m.source = 'default'");
      if (status === 'BLOCK' || status === 'ALLOW') qb.andWhere('m.override_status = :status', { status });
      if (ecosystem) qb.andWhere('m.ecosystem = :ecosystem', { ecosystem });
      if (name) qb.andWhere('m.name ILIKE :name', { name: `%${name}%` });

      const [items, total] = await qb
        .orderBy('m.created_at', 'DESC')
        .skip(offset)
        .take(limit)
        .getManyAndCount();

      return reply.send({
        items: items.map((m) => ({
          id: m.id,
          name: m.name,
          ecosystem: m.ecosystem,
          reason: m.reason,
          sourceUrl: m.sourceUrl,
          source: m.source,
          versionRange: m.versionRange,
          overrideStatus: m.overrideStatus,
          overrideReason: m.overrideReason,
          createdAt: m.createdAt.toISOString(),
        })),
        total,
      });
    }
  );

  fastify.post<{
    Body: { name: string; ecosystem: string; versionRange?: string };
  }>(
    '/api/admin/malicious-packages',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Malicious Packages'],
        body: {
          type: 'object',
          required: ['name', 'ecosystem'],
          properties: {
            name: { type: 'string' },
            ecosystem: { type: 'string', enum: ECOSYSTEMS },
            versionRange: { type: 'string' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              ecosystem: { type: 'string' },
              versionRange: { type: 'string', nullable: true },
            },
          },
          409: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { name, ecosystem, versionRange } = request.body;
      const versionError = versionSpecError(versionRange, [ecosystem], STORED_VERSION_MAX_LENGTH);
      if (versionError) return reply.status(400).send({ error: versionError });
      const repo = fastify.db.getRepository(MaliciousPackage);
      // Any spelling of the name: a feed entry `Foo.Bar` becomes custom rather than shadowed by a second row.
      const existing = await findMaliciousEntry(fastify.db, ecosystem, name);
      if (existing) {
        if (existing.source === 'custom') {
          return reply.status(409).send({ error: 'Custom malicious entry already exists' });
        }
        existing.source = 'custom';
        existing.versionRange = versionRange ?? null;
        existing.reason = null;
        existing.sourceUrl = null;
        await repo.save(existing);
        const { reqIp, userAgent, requester } = getRequestContext(request);
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester,
          ecosystem: existing.ecosystem,
          packageName: existing.name,
          resolvedVersion: existing.versionRange,
          decision: 'MALICIOUS_OVERRIDE_TO_CUSTOM',
        });
        return reply.status(201).send({
          id: existing.id,
          name: existing.name,
          ecosystem: existing.ecosystem,
          versionRange: existing.versionRange,
        });
      }
      const pkg = repo.create({
        name,
        ecosystem,
        versionRange: versionRange ?? null,
        source: 'custom',
        overrideStatus: 'BLOCK',
      });
      const saved = await repo.save(pkg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: saved.ecosystem,
        packageName: saved.name,
        resolvedVersion: saved.versionRange,
        decision: 'MALICIOUS_ADDED',
      });
      return reply.status(201).send({
        id: saved.id,
        name: saved.name,
        ecosystem: saved.ecosystem,
        versionRange: saved.versionRange,
      });
    }
  );

  fastify.put<{
    Params: { id: string };
    Body: { name?: string; ecosystem?: string; versionRange?: string };
  }>(
    '/api/admin/malicious-packages/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Malicious Packages'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            ecosystem: { type: 'string', enum: ECOSYSTEMS },
            versionRange: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              ecosystem: { type: 'string' },
              versionRange: { type: 'string', nullable: true },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { name, ecosystem, versionRange } = request.body;
      const pkg = await fastify.db.getRepository(MaliciousPackage).findOne({ where: { id } });
      if (!pkg) return reply.status(404).send({ error: 'Malicious package not found' });
      if (pkg.source !== 'custom') {
        return reply.status(403).send({ error: 'Only custom malicious packages can be edited' });
      }
      if (name != null) pkg.name = name;
      if (ecosystem != null) pkg.ecosystem = ecosystem;
      if (versionRange !== undefined) {
        const versionError = versionSpecError(versionRange, [pkg.ecosystem], STORED_VERSION_MAX_LENGTH);
        if (versionError) return reply.status(400).send({ error: versionError });
        pkg.versionRange = versionRange ?? null;
      }
      await fastify.db.getRepository(MaliciousPackage).save(pkg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: pkg.ecosystem,
        packageName: pkg.name,
        resolvedVersion: pkg.versionRange,
        decision: 'MALICIOUS_UPDATED',
      });
      return reply.send({
        id: pkg.id,
        name: pkg.name,
        ecosystem: pkg.ecosystem,
        versionRange: pkg.versionRange,
      });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/malicious-packages/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Malicious Packages'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          204: { type: 'null' },
          403: { type: 'object', properties: { error: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const pkg = await fastify.db.getRepository(MaliciousPackage).findOne({ where: { id } });
      if (!pkg) return reply.status(404).send({ error: 'Malicious package not found' });
      if (pkg.source !== 'custom') {
        return reply.status(403).send({ error: 'Only custom malicious packages can be deleted' });
      }
      await fastify.db.getRepository(MaliciousPackage).remove(pkg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: pkg.ecosystem,
        packageName: pkg.name,
        resolvedVersion: pkg.versionRange,
        decision: 'MALICIOUS_DELETED',
      });
      return reply.status(204).send();
    }
  );

  fastify.put<{
    Params: { id: string };
    Body: { overrideStatus: MaliciousOverrideStatus; overrideReason?: string };
  }>(
    '/api/admin/malicious-packages/:id/override',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Malicious Packages'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['overrideStatus'],
          properties: {
            overrideStatus: { type: 'string', enum: VALID_OVERRIDE_STATUSES },
            overrideReason: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              ecosystem: { type: 'string' },
              overrideStatus: { type: 'string' },
              overrideReason: { type: 'string', nullable: true },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { overrideStatus, overrideReason } = request.body;
      const pkg = await fastify.db.getRepository(MaliciousPackage).findOne({ where: { id } });
      if (!pkg) return reply.status(404).send({ error: 'Malicious package not found' });
      pkg.overrideStatus = overrideStatus;
      pkg.overrideReason = overrideReason ?? null;
      await fastify.db.getRepository(MaliciousPackage).save(pkg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: pkg.ecosystem,
        packageName: pkg.name,
        resolvedVersion: overrideReason ?? undefined,
        decision: `MALICIOUS_OVERRIDE_${overrideStatus}`,
        conditionReasons: overrideReason ? [overrideReason] : null,
      });
      return reply.send({
        id: pkg.id,
        name: pkg.name,
        ecosystem: pkg.ecosystem,
        overrideStatus: pkg.overrideStatus,
        overrideReason: pkg.overrideReason,
      });
    }
  );

  fastify.post(
    '/api/admin/malicious-packages/sync',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Malicious Packages'],
        response: {
          202: {
            type: 'object',
            properties: {
              started: { type: 'boolean' },
            },
          },
          409: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { reqIp, userAgent, requester } = getRequestContext(request);
      const queued = await runNow('malicious-feed-sync', { requesterIp: reqIp, userAgent, requester });
      if ('conflict' in queued) return reply.status(409).send({ error: 'Sync already in progress' });
      if ('queued' in queued) {
        fastify.log.info({ jobId: queued.jobId }, 'Malicious feed sync queued (manual API)');
        return reply.status(202).send({ started: true });
      }

      // The queue is unavailable: run in this process, guarded by the database claim as before.
      const claimed = await claimMaliciousSync(fastify.db, 'manual');
      if (!claimed) {
        return reply.status(409).send({ error: 'Sync already in progress' });
      }

      fastify.log.info('Malicious feed sync triggered (manual API, background)');
      const db = fastify.db;
      const log = fastify.log;

      setImmediate(async () => {
        try {
          const result = await runClaimedMaliciousSync({
            db,
            log,
            trigger: 'manual',
            requesterIp: reqIp,
            userAgent,
            requester,
          });
          log.info({ mode: result.mode, added: result.added, total: result.total }, 'Malicious feed sync completed via API');
        } catch (err) {
          log.error(err, 'Malicious feed sync failed');
        }
      });

      return reply.status(202).send({ started: true });
    }
  );
};

function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

export default fp(maliciousPackagesRoutes);
