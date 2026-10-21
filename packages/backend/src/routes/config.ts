import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { DataSource } from 'typeorm';
import { config } from '../config.js';
import {
  getSessionTokenDays,
  setSessionTokenDays,
  normalizeSessionTokenDays,
  getNamespaceCollisionCheck,
  setNamespaceCollisionCheck,
} from '../services/gateway-config.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';

const configRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['User', 'Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });

  fastify.get(
    '/api/admin/config/gateway',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Config'],
        response: {
          200: {
            type: 'object',
            properties: {
              baseUrl: { type: 'string', description: 'Gateway base URL for client configuration' },
              sessionTokenDays: { type: 'integer', description: 'Registry token lifetime in days for User and Security. Default 30. The browser session is 1 hour.' },
              namespaceCollisionCheck: { type: 'boolean', description: 'Daily check whether reserved internal names exist on public registries. Sends those names to the public registries.' },
            },
            required: ['baseUrl', 'sessionTokenDays'],
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.send(await gatewayConfig(fastify));
    }
  );

  fastify.patch<{
    Body: {
      sessionTokenDays?: number;
      namespaceCollisionCheck?: boolean;
    };
  }>(
    '/api/admin/config/gateway',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Config'],
        body: {
          type: 'object',
          properties: {
            sessionTokenDays: { type: 'integer', minimum: 1, maximum: 365, description: 'Registry token lifetime in days for User and Security' },
            namespaceCollisionCheck: { type: 'boolean', description: 'Turn the namespace collision check on or off' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              baseUrl: { type: 'string' },
              sessionTokenDays: { type: 'integer' },
              namespaceCollisionCheck: { type: 'boolean' },
            },
            required: ['baseUrl', 'sessionTokenDays'],
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      if (body.sessionTokenDays !== undefined) {
        const days = normalizeSessionTokenDays(body.sessionTokenDays);
        if (days === null) {
          return reply.status(400).send({ error: 'sessionTokenDays must be a whole number from 1 to 365' });
        }
        await setSessionTokenDays(fastify.db, days);
        const { reqIp, userAgent, requester } = getRequestContext(request);
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester,
          ecosystem: 'config',
          packageName: 'gateway',
          decision: 'CONFIG_UPDATED',
          conditionReasons: [`sessionTokenDays: ${days}`],
        });
      }
      if (typeof body.namespaceCollisionCheck === 'boolean') {
        await setNamespaceCollisionCheck(fastify.db, body.namespaceCollisionCheck);
        const { reqIp, userAgent, requester } = getRequestContext(request);
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester,
          ecosystem: 'config',
          packageName: 'gateway',
          decision: 'CONFIG_UPDATED',
          conditionReasons: [`namespaceCollisionCheck: ${body.namespaceCollisionCheck}`],
        });
      }
      return reply.send(await gatewayConfig(fastify));
    }
  );
};

async function gatewayConfig(fastify: { db: DataSource }) {
  const [sessionTokenDays, namespaceCollisionCheck] = await Promise.all([
    getSessionTokenDays(fastify.db),
    getNamespaceCollisionCheck(fastify.db),
  ]);
  return {
    baseUrl: config.gateway.baseUrl,
    sessionTokenDays,
    namespaceCollisionCheck,
  };
}

export default fp(configRoutes);
