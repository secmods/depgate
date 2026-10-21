import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { Exception } from '../db/entities/Exception.js';
import { WaiverRequest, WaiverRequestStatus } from '../db/entities/WaiverRequest.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { exceptionReason, parseFutureExpiry } from '../services/waiver-request.js';
import { canonicalPackageName } from '../services/package-name.js';
import { STORED_VERSION_MAX_LENGTH, versionSpecError } from '../services/version-range.js';
import {
  describeScope,
  parseScopeIds,
  refsFor,
  repositoryRefMap,
  validateRepositoryScope,
  type RepositoryRef,
} from '../services/repository-scope.js';

const ecosystems = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];
const statuses: WaiverRequestStatus[] = ['pending', 'approved', 'rejected'];

function requestUser(request: { user?: unknown }): { sub?: string; role?: string; username?: string; name?: string } | undefined {
  const user = request.user;
  if (!user || typeof user !== 'object') return undefined;
  return user as { sub?: string; role?: string; username?: string; name?: string };
}

function actor(user?: { sub?: string; username?: string; name?: string }): { id: string; name: string } {
  const id = user?.sub ?? 'unknown';
  return { id, name: user?.username ?? user?.name ?? id };
}

function toDto(row: WaiverRequest, refs: Map<string, RepositoryRef> = new Map()) {
  return {
    id: row.id,
    packageName: row.packageName,
    ecosystem: row.ecosystem,
    version: row.version,
    requestedExpiresAt: row.requestedExpiresAt.toISOString(),
    approvedExpiresAt: row.approvedExpiresAt ? row.approvedExpiresAt.toISOString() : null,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requestedBy,
    reviewedBy: row.reviewedBy,
    reviewNote: row.reviewNote,
    exceptionId: row.exceptionId,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    repositoryIds: row.repositoryIds ?? [],
    repositories: refsFor(row.repositoryIds, refs),
  };
}

async function dtoOf(db: Parameters<typeof repositoryRefMap>[0], row: WaiverRequest) {
  return toDto(row, await repositoryRefMap(db, [row]));
}

/** Parse and check a waiver's repositories against its ecosystem, or an error message. */
async function scopeFor(
  db: Parameters<typeof repositoryRefMap>[0],
  value: unknown,
  ecosystem: string
): Promise<{ ids?: string[]; refs: RepositoryRef[] } | { error: string }> {
  const parsed = parseScopeIds(value);
  if (parsed.error) return { error: parsed.error };
  if (parsed.ids === undefined) return { refs: [] };
  const checked = await validateRepositoryScope(db, parsed.ids, [ecosystem]);
  if ('error' in checked) return { error: checked.error.replace("this policy's", "this waiver's") };
  return { ids: parsed.ids, refs: checked.refs };
}

const waiverDtoSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    packageName: { type: 'string' },
    ecosystem: { type: 'string' },
    version: { type: 'string' },
    requestedExpiresAt: { type: 'string' },
    approvedExpiresAt: { type: 'string', nullable: true },
    reason: { type: 'string' },
    status: { type: 'string', enum: statuses },
    requestedBy: { type: 'string' },
    reviewedBy: { type: 'string', nullable: true },
    reviewNote: { type: 'string', nullable: true },
    exceptionId: { type: 'string', nullable: true },
    createdAt: { type: 'string' },
    reviewedAt: { type: 'string', nullable: true },
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

const waiverRoutes: FastifyPluginAsync = async (fastify) => {
  const requireUser = fastify.authenticate({ roles: ['User', 'Security'] });
  const requireRequester = fastify.authenticate({ roles: ['User'] });
  const requireReviewer = fastify.authenticate({ roles: ['Security'] });

  fastify.get(
    '/api/waiver-requests',
    {
      onRequest: [requireUser],
      schema: {
        tags: ['Waiver requests'],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: statuses },
            ecosystem: { type: 'string', enum: ecosystems },
            package: { type: 'string' },
            limit: { type: 'string' },
            offset: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              items: { type: 'array', items: waiverDtoSchema },
              total: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { status, ecosystem, package: pkg, limit: limitStr, offset: offsetStr } = request.query as {
        status?: WaiverRequestStatus;
        ecosystem?: string;
        package?: string;
        limit?: string;
        offset?: string;
      };
      const offset = Math.max(parseInt(offsetStr ?? '0', 10) || 0, 0);
      const limit = limitStr == null || limitStr === ''
        ? null
        : Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 200);
      const user = requestUser(request);
      const who = actor(user);
      const qb = fastify.db.getRepository(WaiverRequest).createQueryBuilder('w').orderBy('w.createdAt', 'DESC');

      if (user?.role === 'User') {
        qb.andWhere('w.requestedById = :requestedById', { requestedById: who.id });
      }
      if (status) qb.andWhere('w.status = :status', { status });
      if (ecosystem) qb.andWhere('w.ecosystem = :ecosystem', { ecosystem });
      if (pkg) qb.andWhere('w.packageName ILIKE :pkg', { pkg: `%${pkg}%` });

      const total = await qb.clone().getCount();
      if (limit != null) qb.skip(offset).take(limit);
      const items = await qb.getMany();
      const refs = await repositoryRefMap(fastify.db, items);
      return reply.send({ items: items.map((row) => toDto(row, refs)), total });
    }
  );

  fastify.post<{
    Body: {
      packageName: string;
      ecosystem: string;
      version?: string;
      expiresAt: string;
      reason: string;
      repositoryIds?: string[] | null;
    };
  }>(
    '/api/waiver-requests',
    {
      onRequest: [requireRequester],
      schema: {
        tags: ['Waiver requests'],
        body: {
          type: 'object',
          required: ['packageName', 'ecosystem', 'expiresAt', 'reason'],
          properties: {
            packageName: { type: 'string' },
            ecosystem: { type: 'string', enum: ecosystems },
            version: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            reason: { type: 'string' },
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: { 201: waiverDtoSchema },
      },
    },
    async (request, reply) => {
      const ecosystem = request.body.ecosystem;
      const packageName = canonicalPackageName(ecosystem, request.body.packageName?.trim() ?? '');
      const reason = request.body.reason?.trim() ?? '';
      const version = request.body.version?.trim() || '*';
      if (!packageName || !reason) {
        return reply.status(400).send({ error: 'packageName and reason are required' });
      }
      const versionError = versionSpecError(version, [ecosystem], STORED_VERSION_MAX_LENGTH);
      if (versionError) return reply.status(400).send({ error: versionError });
      const requestedExpiresAt = parseFutureExpiry(request.body.expiresAt);
      if (!requestedExpiresAt) {
        return reply.status(400).send({ error: 'expiresAt must be a future date' });
      }
      const scope = await scopeFor(fastify.db, request.body.repositoryIds, ecosystem);
      if ('error' in scope) return reply.status(400).send({ error: scope.error });

      const who = actor(requestUser(request));
      const repo = fastify.db.getRepository(WaiverRequest);
      const duplicate = await repo.findOne({
        where: { requestedById: who.id, ecosystem, packageName, version, status: 'pending' },
      });
      if (duplicate) {
        return reply.status(409).send({ error: 'A pending waiver request already exists for this package' });
      }

      const row = repo.create({
        packageName,
        ecosystem,
        version,
        requestedExpiresAt,
        approvedExpiresAt: null,
        reason,
        repositoryIds: scope.ids ?? [],
        status: 'pending',
        requestedBy: who.name,
        requestedById: who.id,
        reviewedBy: null,
        reviewNote: null,
        exceptionId: null,
        reviewedAt: null,
      });
      await repo.save(row);

      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem,
        packageName: `${packageName}@${version}`,
        resolvedVersion: version,
        decision: 'WAIVER_REQUESTED',
        conditionReasons: scope.refs.length ? [reason, `For ${describeScope(scope.refs)}`] : [reason],
      });
      return reply.status(201).send(toDto(row, new Map(scope.refs.map((ref) => [ref.id, ref]))));
    }
  );

  fastify.patch<{
    Params: { id: string };
    Body: {
      packageName: string;
      ecosystem: string;
      version?: string;
      expiresAt: string;
      reason: string;
      repositoryIds?: string[] | null;
    };
  }>(
    '/api/waiver-requests/:id',
    {
      onRequest: [requireRequester],
      schema: {
        tags: ['Waiver requests'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['packageName', 'ecosystem', 'expiresAt', 'reason'],
          properties: {
            packageName: { type: 'string' },
            ecosystem: { type: 'string', enum: ecosystems },
            version: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
            reason: { type: 'string' },
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: { 200: waiverDtoSchema },
      },
    },
    async (request, reply) => {
      const ecosystem = request.body.ecosystem;
      const packageName = canonicalPackageName(ecosystem, request.body.packageName?.trim() ?? '');
      const reason = request.body.reason?.trim() ?? '';
      const version = request.body.version?.trim() || '*';
      if (!packageName || !reason) {
        return reply.status(400).send({ error: 'packageName and reason are required' });
      }
      const versionError = versionSpecError(version, [ecosystem], STORED_VERSION_MAX_LENGTH);
      if (versionError) return reply.status(400).send({ error: versionError });
      const requestedExpiresAt = parseFutureExpiry(request.body.expiresAt);
      if (!requestedExpiresAt) {
        return reply.status(400).send({ error: 'expiresAt must be a future date' });
      }
      const scope = await scopeFor(fastify.db, request.body.repositoryIds, ecosystem);
      if ('error' in scope) return reply.status(400).send({ error: scope.error });

      const who = actor(requestUser(request));
      const repo = fastify.db.getRepository(WaiverRequest);
      const found = await repo.findOne({ where: { id: request.params.id } });
      if (!found || found.requestedById !== who.id) {
        return reply.status(404).send({ error: 'Waiver request not found' });
      }
      if (found.status === 'approved') {
        return reply.status(409).send({ error: 'Approved waivers cannot be edited' });
      }

      const duplicate = await repo
        .createQueryBuilder('w')
        .where('w.requestedById = :requestedById', { requestedById: who.id })
        .andWhere('w.ecosystem = :ecosystem', { ecosystem })
        .andWhere('w.packageName = :packageName', { packageName })
        .andWhere('w.version = :version', { version })
        .andWhere('w.status = :status', { status: 'pending' })
        .andWhere('w.id != :id', { id: found.id })
        .getOne();
      if (duplicate) {
        return reply.status(409).send({ error: 'A pending waiver request already exists for this package' });
      }

      const updated = await repo.update(
        { id: found.id, requestedById: who.id, status: found.status },
        {
          packageName,
          ecosystem,
          version,
          requestedExpiresAt,
          reason,
          ...(scope.ids !== undefined ? { repositoryIds: scope.ids } : {}),
          status: 'pending',
          reviewedBy: null,
          reviewNote: null,
          reviewedAt: null,
        }
      );
      if (!updated.affected) {
        return reply.status(409).send({ error: 'Approved waivers cannot be edited' });
      }

      found.packageName = packageName;
      found.ecosystem = ecosystem;
      found.version = version;
      found.requestedExpiresAt = requestedExpiresAt;
      found.reason = reason;
      if (scope.ids !== undefined) found.repositoryIds = scope.ids;
      found.status = 'pending';
      found.reviewedBy = null;
      found.reviewNote = null;
      found.reviewedAt = null;

      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem,
        packageName: `${packageName}@${version}`,
        resolvedVersion: version,
        decision: 'WAIVER_UPDATED',
        conditionReasons: [reason],
      });
      return reply.send(await dtoOf(fastify.db, found));
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/waiver-requests/:id',
    {
      onRequest: [requireRequester],
      schema: {
        tags: ['Waiver requests'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const who = actor(requestUser(request));
      const repo = fastify.db.getRepository(WaiverRequest);
      const found = await repo.findOne({ where: { id: request.params.id } });
      if (!found || found.requestedById !== who.id) {
        return reply.status(404).send({ error: 'Waiver request not found' });
      }
      if (found.status === 'approved') {
        return reply.status(409).send({ error: 'Approved waivers cannot be deleted' });
      }

      const removed = await repo.delete({ id: found.id, requestedById: who.id, status: found.status });
      if (!removed.affected) {
        return reply.status(409).send({ error: 'Approved waivers cannot be deleted' });
      }

      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: found.ecosystem,
        packageName: `${found.packageName}@${found.version}`,
        resolvedVersion: found.version,
        decision: 'WAIVER_DELETED',
        conditionReasons: [found.reason],
      });
      return reply.status(204).send();
    }
  );

  fastify.post<{
    Params: { id: string };
    Body: { expiresAt: string; reviewNote?: string | null; repositoryIds?: string[] | null };
  }>(
    '/api/waiver-requests/:id/approve',
    {
      onRequest: [requireReviewer],
      schema: {
        tags: ['Waiver requests'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['expiresAt'],
          properties: {
            expiresAt: { type: 'string', format: 'date-time' },
            reviewNote: { type: 'string', nullable: true },
            /** The reviewer's choice of repositories. Missing: what was requested. Empty: every repository. */
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: { 200: waiverDtoSchema },
      },
    },
    async (request, reply) => {
      const expiresAt = parseFutureExpiry(request.body?.expiresAt);
      if (!expiresAt) {
        return reply.status(400).send({ error: 'expiresAt must be a future date' });
      }
      const repo = fastify.db.getRepository(WaiverRequest);
      const found = await repo.findOne({ where: { id: request.params.id } });
      if (!found) return reply.status(404).send({ error: 'Waiver request not found' });
      if (found.status !== 'pending') {
        return reply.status(409).send({ error: 'Waiver request is no longer pending' });
      }

      const scope = await scopeFor(fastify.db, request.body.repositoryIds, found.ecosystem);
      if ('error' in scope) return reply.status(400).send({ error: scope.error });
      const approvedScope = scope.ids ?? found.repositoryIds ?? [];

      const who = actor(requestUser(request));
      const reviewNote = request.body.reviewNote?.trim() || null;
      const exceptionRepo = fastify.db.getRepository(Exception);
      const exp = exceptionRepo.create({
        packageName: found.packageName,
        ecosystem: found.ecosystem,
        version: found.version,
        expiresAt,
        reason: exceptionReason(found.reason, reviewNote),
        approvedBy: who.name,
        repositoryIds: approvedScope,
      });
      await exceptionRepo.save(exp);

      const reviewedAt = new Date();
      const updated = await repo.update(
        { id: found.id, status: 'pending' },
        {
          status: 'approved',
          approvedExpiresAt: expiresAt,
          reviewedBy: who.name,
          reviewNote,
          exceptionId: exp.id,
          reviewedAt,
          repositoryIds: approvedScope,
        }
      );
      if (!updated.affected) {
        await exceptionRepo.remove(exp);
        return reply.status(409).send({ error: 'Waiver request is no longer pending' });
      }

      found.status = 'approved';
      found.approvedExpiresAt = expiresAt;
      found.reviewedBy = who.name;
      found.reviewNote = reviewNote;
      found.exceptionId = exp.id;
      found.reviewedAt = reviewedAt;
      found.repositoryIds = approvedScope;
      const approvedRefs = await repositoryRefMap(fastify.db, [found]);
      const approvedLabel = describeScope(refsFor(approvedScope, approvedRefs));

      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: found.ecosystem,
        packageName: `${found.packageName}@${found.version}`,
        resolvedVersion: found.version,
        decision: 'WAIVER_APPROVED',
        conditionReasons: reviewNote ? [reviewNote] : null,
        metadata: { exceptionId: exp.id, expiresAt: expiresAt.toISOString() },
      });
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: found.ecosystem,
        packageName: `${found.packageName}@${found.version}`,
        resolvedVersion: found.version,
        decision: 'EXCEPTION_ADDED',
        conditionReasons: approvedScope.length
          ? [exceptionReason(found.reason, reviewNote), `Scoped to ${approvedLabel}`]
          : [exceptionReason(found.reason, reviewNote)],
      });
      return reply.send(toDto(found, approvedRefs));
    }
  );

  fastify.post<{
    Params: { id: string };
    Body?: { reviewNote?: string | null };
  }>(
    '/api/waiver-requests/:id/reject',
    {
      onRequest: [requireReviewer],
      schema: {
        tags: ['Waiver requests'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          properties: {
            reviewNote: { type: 'string', nullable: true },
          },
        },
        response: { 200: waiverDtoSchema },
      },
    },
    async (request, reply) => {
      const repo = fastify.db.getRepository(WaiverRequest);
      const found = await repo.findOne({ where: { id: request.params.id } });
      if (!found) return reply.status(404).send({ error: 'Waiver request not found' });
      if (found.status !== 'pending') {
        return reply.status(409).send({ error: 'Waiver request is no longer pending' });
      }

      const who = actor(requestUser(request));
      const reviewNote = request.body?.reviewNote?.trim() || null;
      const reviewedAt = new Date();
      const updated = await repo.update(
        { id: found.id, status: 'pending' },
        { status: 'rejected', reviewedBy: who.name, reviewNote, reviewedAt }
      );
      if (!updated.affected) {
        return reply.status(409).send({ error: 'Waiver request is no longer pending' });
      }

      found.status = 'rejected';
      found.reviewedBy = who.name;
      found.reviewNote = reviewNote;
      found.reviewedAt = reviewedAt;

      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: found.ecosystem,
        packageName: `${found.packageName}@${found.version}`,
        resolvedVersion: found.version,
        decision: 'WAIVER_REJECTED',
        conditionReasons: reviewNote ? [reviewNote] : [found.reason],
      });
      return reply.send(await dtoOf(fastify.db, found));
    }
  );
};

export default fp(waiverRoutes);
