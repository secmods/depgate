import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ApiKey } from '../db/entities/ApiKey.js';
import { ROLE_SECURITY } from '../auth/roles.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';

const apiKeysRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });

  fastify.post(
    '/api/admin/api-keys',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['API Keys'],
        response: {
          403: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.status(403).send({
        error: 'Role-bearing API keys cannot be created. Create a service account instead.',
      });
    }
  );

  fastify.get(
    '/api/admin/api-keys',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['API Keys'],
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                role: { type: 'string' },
                namespace: { type: 'string', nullable: true },
                expiresAt: { type: 'string', nullable: true },
                lastUsedAt: { type: 'string', nullable: true },
                requestCount: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const keys = await fastify.db.getRepository(ApiKey).find({
        order: { createdAt: 'DESC' },
      });
      return reply.send(
        keys.map((k) => ({
          id: k.id,
          name: k.name,
          role: k.role,
          namespace: k.namespace,
          expiresAt: k.expiresAt?.toISOString() ?? null,
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          requestCount: k.requestCount,
          createdAt: k.createdAt.toISOString(),
        }))
      );
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/api-keys/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['API Keys'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const key = await fastify.db.getRepository(ApiKey).findOne({ where: { id } });
      if (!key) return reply.status(404).send({ error: 'API key not found' });
      await fastify.db.getRepository(ApiKey).remove(key);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'api_key',
        packageName: key.name,
        resolvedVersion: key.role,
        decision: 'API_KEY_REVOKED',
      });
      return reply.status(204).send();
    }
  );
};

export default fp(apiKeysRoutes);
