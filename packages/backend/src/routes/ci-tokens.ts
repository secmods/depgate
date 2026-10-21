import { randomUUID } from 'crypto';
import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { CiToken } from '../db/entities/CiToken.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { parseCiTokenName, parseExpiresIn, parseMetadata } from '../services/ci-token.js';

function actorName(user: unknown): string | null {
  const actor = user as { username?: string; name?: string } | undefined;
  return actor?.username || actor?.name || null;
}

const ciTokenRoutes: FastifyPluginAsync = async (fastify) => {
  const requireService = fastify.authenticate({ roles: ['ServiceAccount'] });
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });

  fastify.post<{
    Body: { name?: string; expiresIn?: string; metadata?: Record<string, unknown> };
  }>(
    '/api/admin/ci-tokens',
    {
      onRequest: [requireService],
      schema: {
        tags: ['CI Tokens'],
        body: {
          type: 'object',
          required: ['name', 'expiresIn'],
          properties: {
            name: { type: 'string', description: 'Pipeline or job name recorded on each download' },
            expiresIn: { type: 'string', description: 'Lifetime: 30m, 2h, or 1d. Maximum 1 day.' },
            metadata: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Build identifiers such as pr_number and build_number',
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              token: { type: 'string', description: 'Shown only once. Put it in the registry URL.' },
              expiresAt: { type: 'string' },
              metadata: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['id', 'name', 'token', 'expiresAt', 'metadata'],
          },
        },
      },
    },
    async (request, reply) => {
      const name = parseCiTokenName(request.body?.name);
      const expiresMs = parseExpiresIn(request.body?.expiresIn);
      const parsedMetadata = parseMetadata(request.body?.metadata);
      if (!name) return reply.status(400).send({ error: 'name is required' });
      if (expiresMs == null) {
        return reply.status(400).send({ error: 'expiresIn is required and must be at most 1d (examples: 30m, 2h, 1d)' });
      }
      if ('error' in parsedMetadata) return reply.status(400).send({ error: parsedMetadata.error });

      const id = randomUUID();
      const expiresAt = new Date(Date.now() + expiresMs);
      const createdBy = actorName(request.user) || 'admin';
      const row = fastify.db.getRepository(CiToken).create({
        id,
        name,
        metadata: parsedMetadata.metadata,
        expiresAt,
        revokedAt: null,
        createdBy,
      });
      await fastify.db.getRepository(CiToken).save(row);

      const token = await fastify.jwt.sign(
        { sub: id, role: 'User', type: 'ci', name },
        { expiresIn: Math.ceil(expiresMs / 1000) }
      );

      const { reqIp, userAgent } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester: createdBy,
        ecosystem: 'ci_token',
        packageName: name,
        decision: 'CI_TOKEN_CREATED',
        metadata: parsedMetadata.metadata,
      });

      return reply.status(201).send({
        id,
        name,
        token,
        expiresAt: expiresAt.toISOString(),
        metadata: parsedMetadata.metadata,
      });
    }
  );

  fastify.get(
    '/api/admin/ci-tokens',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['CI Tokens'],
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
                    metadata: { type: 'object', additionalProperties: { type: 'string' } },
                    expiresAt: { type: 'string' },
                    revokedAt: { type: 'string', nullable: true },
                    createdBy: { type: 'string' },
                    createdAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const rows = await fastify.db.getRepository(CiToken).find({ order: { createdAt: 'DESC' }, take: 200 });
      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          metadata: row.metadata ?? {},
          expiresAt: new Date(row.expiresAt).toISOString(),
          revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/ci-tokens/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['CI Tokens'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const row = await fastify.db.getRepository(CiToken).findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'CI token not found' });
      if (!row.revokedAt) {
        row.revokedAt = new Date();
        await fastify.db.getRepository(CiToken).save(row);
        const { reqIp, userAgent } = getRequestContext(request);
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester: actorName(request.user),
          ecosystem: 'ci_token',
          packageName: row.name,
          decision: 'CI_TOKEN_REVOKED',
          metadata: row.metadata,
        });
      }
      return reply.status(204).send();
    }
  );
};

export default fp(ciTokenRoutes);
