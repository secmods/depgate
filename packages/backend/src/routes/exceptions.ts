import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { Exception } from '../db/entities/Exception.js';
import { Policy } from '../db/entities/Policy.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { STORED_VERSION_MAX_LENGTH, versionSpecError } from '../services/version-range.js';
import { canonicalPackageName } from '../services/package-name.js';
import {
  describeScope,
  parseScopeIds,
  refsFor,
  repositoryRefMap,
  validateRepositoryScope,
  type RepositoryRef,
} from '../services/repository-scope.js';

const ecosystems = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const exceptionItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    packageName: { type: 'string' },
    ecosystem: { type: 'string' },
    version: { type: 'string' },
    expiresAt: { type: 'string' },
    reason: { type: 'string', nullable: true },
    approvedBy: { type: 'string' },
    createdAt: { type: 'string' },
    /** null: covers every policy. Set: an approval for that policy only. */
    policyId: { type: 'string', nullable: true },
    policyName: { type: 'string', nullable: true },
    /** Empty: every repository. */
    repositoryIds: { type: 'array', items: { type: 'string' } },
    repositories: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, ecosystem: { type: 'string' }, key: { type: 'string' }, type: { type: 'string' } },
      },
    },
  },
} as const;

function exceptionView(e: Exception, policyName: string | null, refs: Map<string, RepositoryRef>) {
  return {
    id: e.id,
    packageName: e.packageName,
    ecosystem: e.ecosystem,
    version: e.version,
    expiresAt: e.expiresAt.toISOString(),
    reason: e.reason,
    approvedBy: e.approvedBy,
    createdAt: e.createdAt.toISOString(),
    policyId: e.policyId ?? null,
    policyName: e.policyId ? policyName : null,
    repositoryIds: e.repositoryIds ?? [],
    repositories: refsFor(e.repositoryIds, refs),
  };
}

const exceptionsRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });

  fastify.get(
    '/api/admin/exceptions',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Exceptions'],
        querystring: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string', enum: ecosystems },
            package: { type: 'string' },
            expired: { type: 'string', enum: ['true', 'false'] },
            /** all: exceptions for every policy (default). scoped: every policy's approvals. any: both. A policy id: that policy's approvals. */
            appliesTo: { type: 'string' },
            /** Exceptions that apply on this repository: limited to it, or to every repository. */
            repositoryId: { type: 'string', format: 'uuid' },
            limit: { type: 'string' },
            offset: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: exceptionItemSchema },
              total: { type: 'number' },
              active: { type: 'number' },
              expired: { type: 'number' },
            },
          },
          400: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { ecosystem, package: pkg, expired, appliesTo, repositoryId, limit: limitStr, offset: offsetStr } = request.query as {
        repositoryId?: string;
        ecosystem?: string;
        package?: string;
        expired?: string;
        appliesTo?: string;
        limit?: string;
        offset?: string;
      };
      const scope = appliesTo || 'all';
      if (scope !== 'all' && scope !== 'any' && scope !== 'scoped' && !UUID.test(scope)) {
        return reply.status(400).send({ error: 'appliesTo must be all, scoped, any, or a policy id' });
      }
      const offset = Math.max(parseInt(offsetStr ?? '0', 10) || 0, 0);
      const limit = limitStr == null || limitStr === ''
        ? null
        : Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 200);
      const repo = fastify.db.getRepository(Exception);
      const qb = repo.createQueryBuilder('e').orderBy('e.expiresAt', 'DESC');

      if (scope === 'all') qb.andWhere('e.policyId IS NULL');
      else if (scope === 'scoped') qb.andWhere('e.policyId IS NOT NULL');
      else if (scope !== 'any') qb.andWhere('e.policyId = :policyId', { policyId: scope });
      if (ecosystem) qb.andWhere('e.ecosystem = :ecosystem', { ecosystem });
      if (pkg) qb.andWhere('e.packageName ILIKE :pkg', { pkg: `%${pkg}%` });
      if (repositoryId) {
        qb.andWhere('(jsonb_array_length(e.repository_ids) = 0 OR e.repository_ids @> :scopeIdJson::jsonb)', {
          scopeIdJson: JSON.stringify([repositoryId]),
        });
      }
      if (expired === 'true') qb.andWhere('e.expiresAt <= :now', { now: new Date() });
      else if (expired === 'false') qb.andWhere('e.expiresAt > :now', { now: new Date() });

      const total = await qb.clone().getCount();
      const active = expired === 'true'
        ? 0
        : expired === 'false'
          ? total
          : await qb.clone().andWhere('e.expiresAt > :cardNow', { cardNow: new Date() }).getCount();
      if (limit != null) qb.skip(offset).take(limit);
      const items = await qb.getMany();
      const policyIds = [...new Set(items.map((e) => e.policyId).filter((id): id is string => !!id))];
      const names = new Map(
        policyIds.length
          ? (await fastify.db.getRepository(Policy).find({ where: policyIds.map((id) => ({ id })), select: { id: true, name: true } })).map(
              (p) => [p.id, p.name] as const
            )
          : []
      );
      const refs = await repositoryRefMap(fastify.db, items);
      return reply.send({
        items: items.map((e) => exceptionView(e, e.policyId ? names.get(e.policyId) ?? null : null, refs)),
        total,
        active,
        expired: total - active,
      });
    }
  );

  fastify.post<{
    Body: {
      packageName: string;
      ecosystem: string;
      version: string;
      expiresAt: string;
      reason?: string;
      policyId?: string | null;
      repositoryIds?: string[] | null;
    };
  }>(
    '/api/admin/exceptions',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Exceptions'],
        body: {
          type: 'object',
          required: ['packageName', 'ecosystem', 'version', 'expiresAt'],
          properties: {
            packageName: { type: 'string' },
            ecosystem: { type: 'string', enum: ecosystems },
            version: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            reason: { type: 'string', nullable: true },
            policyId: { type: 'string', nullable: true },
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: { 201: exceptionItemSchema },
      },
    },
    async (request, reply) => {
      const { ecosystem, version, expiresAt, reason, policyId } = request.body;
      const packageName = canonicalPackageName(ecosystem, request.body.packageName);
      const versionError = versionSpecError(version, [ecosystem], STORED_VERSION_MAX_LENGTH);
      if (versionError) return reply.status(400).send({ error: versionError });
      const parsedScope = parseScopeIds(request.body.repositoryIds);
      if (parsedScope.error) return reply.status(400).send({ error: parsedScope.error });
      const scope = await validateRepositoryScope(fastify.db, parsedScope.ids ?? [], [ecosystem]);
      if ('error' in scope) return reply.status(400).send({ error: scope.error.replace("this policy's", "this exception's") });
      let policy: Policy | null = null;
      if (policyId) {
        if (!UUID.test(policyId)) return reply.status(400).send({ error: 'policyId must be a policy id' });
        policy = await fastify.db.getRepository(Policy).findOne({ where: { id: policyId } });
        if (!policy) return reply.status(400).send({ error: 'Policy not found' });
        if (policy.decision !== 'BLOCK') return reply.status(400).send({ error: 'Only a Block policy can have approvals' });
      }
      const user = (request as { user?: { sub?: string; username?: string; name?: string } }).user;
      const approvedBy = user?.username ?? user?.name ?? user?.sub ?? 'unknown';

      const exp = fastify.db.getRepository(Exception).create({
        packageName,
        ecosystem,
        version: version || '*',
        expiresAt: new Date(expiresAt),
        reason: reason ?? null,
        approvedBy,
        policyId: policy?.id ?? null,
        repositoryIds: parsedScope.ids ?? [],
      });
      await fastify.db.getRepository(Exception).save(exp);
      const notes = [...(reason ? [reason] : []), ...(scope.refs.length ? [`Scoped to ${describeScope(scope.refs)}`] : [])];
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem,
        packageName: `${packageName}@${version || '*'}`,
        resolvedVersion: version || '*',
        decision: 'EXCEPTION_ADDED',
        policyId: policy?.id ?? null,
        policyName: policy?.name ?? null,
        conditionReasons: notes.length ? notes : null,
      });
      return reply
        .status(201)
        .send(exceptionView(exp, policy?.name ?? null, new Map(scope.refs.map((ref) => [ref.id, ref]))));
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/exceptions/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Exceptions'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const repo = fastify.db.getRepository(Exception);
      const found = await repo.findOne({ where: { id } });
      if (!found) return reply.status(404).send({ error: 'Exception not found' });
      const pkgId = `${found.packageName}@${found.version}`;
      const scopedTo = found.policyId
        ? await fastify.db.getRepository(Policy).findOne({ where: { id: found.policyId }, select: { id: true, name: true } })
        : null;
      await repo.remove(found);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: found.ecosystem,
        packageName: pkgId,
        resolvedVersion: found.version,
        decision: 'EXCEPTION_REVOKED',
        policyId: scopedTo?.id ?? null,
        policyName: scopedTo?.name ?? null,
      });
      return reply.status(204).send();
    }
  );
};

export default fp(exceptionsRoutes);
