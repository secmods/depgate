import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { parseAuth, buildAuthHeaders, encodeAuth, type AuthConfig } from '../services/upstream-provider.js';
import { removeUpstreamRepository, syncUpstreamRegistry } from '../services/repository-resolve.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { auditDetach } from './repositories.js';

const VALID_ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'] as const;
const VALID_AUTH_TYPES = ['bearer', 'basic', 'header'] as const;

/** Health-check path for a known public registry host (exact hostname match). */
function upstreamHealthCheckPath(registryBaseUrl: string): string {
  try {
    const hostname = new URL(registryBaseUrl).hostname.toLowerCase();
    switch (hostname) {
      case 'registry.npmjs.org':
        return '/-/ping';
      case 'api.nuget.org':
        return '/v3/index.json';
      case 'crates.io':
        return '/api/v1/crates?page=1&per_page=1';
      case 'packagist.org':
        return '/packages.json';
      case 'rubygems.org':
        return '/api/v1/versions/rake/latest.json';
      default:
        return '/';
    }
  } catch {
    return '/';
  }
}

/** Mask placeholder returned by backend when auth is configured. UI displays this and sends it back on update to mean "keep existing". */
export const AUTH_MASK_PLACEHOLDER = '********';

const upstreamRegistriesRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });

  fastify.get<{ Querystring: { ecosystem?: string } }>(
    '/api/admin/upstream-registries',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Upstream Registries'],
        querystring: {
          type: 'object',
          properties: { ecosystem: { type: 'string', enum: VALID_ECOSYSTEMS } },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                ecosystem: { type: 'string' },
                url: { type: 'string' },
                priority: { type: 'number' },
                isEnabled: { type: 'boolean' },
                timeoutMs: { type: 'number' },
                retryCount: { type: 'number' },
                authConfigured: { type: 'boolean' },
                authType: { type: 'string', nullable: true },
                usernameMasked: { type: 'string', nullable: true },
                passwordMasked: { type: 'string', nullable: true },
                tokenMasked: { type: 'string', nullable: true },
                headerNameMasked: { type: 'string', nullable: true },
                headerValueMasked: { type: 'string', nullable: true },
                createdAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { ecosystem } = request.query ?? {};
      const qb = fastify.db.getRepository(UpstreamRegistry).createQueryBuilder('r');
      if (ecosystem) qb.andWhere('r.ecosystem = :ecosystem', { ecosystem });
      qb.orderBy('r.ecosystem').addOrderBy('r.priority', 'ASC');
      const list = await qb.getMany();
      return reply.send(
        list.map((r) => {
          const authConfigured = !!r.authEncrypted;
          const authType = r.authType ?? null;
          const out: Record<string, unknown> = {
            id: r.id,
            ecosystem: r.ecosystem,
            url: r.url,
            priority: r.priority,
            isEnabled: r.isEnabled,
            timeoutMs: r.timeoutMs,
            retryCount: r.retryCount,
            authConfigured,
            authType,
            createdAt: r.createdAt.toISOString(),
          };
          if (authConfigured && authType === 'basic') {
            out.usernameMasked = AUTH_MASK_PLACEHOLDER;
            out.passwordMasked = AUTH_MASK_PLACEHOLDER;
          } else if (authConfigured && authType === 'bearer') {
            out.tokenMasked = AUTH_MASK_PLACEHOLDER;
          } else if (authConfigured && authType === 'header') {
            out.headerNameMasked = AUTH_MASK_PLACEHOLDER;
            out.headerValueMasked = AUTH_MASK_PLACEHOLDER;
          }
          return out;
        })
      );
    }
  );

  fastify.post<{
    Body: {
      ecosystem?: string;
      url?: string;
      priority?: number;
      timeoutMs?: number;
      retryCount?: number;
      authType?: string;
      authToken?: string;
      authUsername?: string;
      authPassword?: string;
      authHeaderName?: string;
      authHeaderValue?: string;
    };
  }>(
    '/api/admin/upstream-registries',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Upstream Registries'],
        body: {
          type: 'object',
          required: ['ecosystem', 'url'],
          properties: {
            ecosystem: { type: 'string', enum: VALID_ECOSYSTEMS },
            url: { type: 'string' },
            priority: { type: 'number' },
            timeoutMs: { type: 'number' },
            retryCount: { type: 'number' },
            authType: { type: 'string', enum: VALID_AUTH_TYPES, nullable: true },
            authToken: { type: 'string', nullable: true },
            authUsername: { type: 'string', nullable: true },
            authPassword: { type: 'string', nullable: true },
            authHeaderName: { type: 'string', nullable: true },
            authHeaderValue: { type: 'string', nullable: true },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              ecosystem: { type: 'string' },
              url: { type: 'string' },
              priority: { type: 'number' },
              isEnabled: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const { ecosystem, url } = body;
      if (!ecosystem || !url || !VALID_ECOSYSTEMS.includes(ecosystem as (typeof VALID_ECOSYSTEMS)[number])) {
        return reply.status(400).send({ error: 'ecosystem and url required; ecosystem: npm|pypi|go|maven|nuget|cargo|composer|rubygems' });
      }

      const authPayload = buildAuthPayload(body);
      const maxPriority = await fastify.db
        .getRepository(UpstreamRegistry)
        .createQueryBuilder('r')
        .select('MAX(r.priority)', 'max')
        .where('r.ecosystem = :ecosystem', { ecosystem })
        .getRawOne();
      const priority = body.priority ?? (Number(maxPriority?.max ?? -1) + 1);

      const reg = fastify.db.getRepository(UpstreamRegistry).create({
        ecosystem,
        url: url.replace(/\/$/, ''),
        priority,
        isEnabled: true,
        timeoutMs: body.timeoutMs ?? 30000,
        retryCount: body.retryCount ?? 3,
        authType: authPayload ? (body.authType as string) : null,
        authEncrypted: authPayload ? encodeAuth(authPayload) : null,
      });
      const saved = await fastify.db.getRepository(UpstreamRegistry).save(reg);
      await syncUpstreamRegistry(fastify.db, saved);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: saved.ecosystem,
        packageName: saved.url,
        decision: 'UPSTREAM_REGISTRY_CREATED',
        conditionReasons: [String(saved.priority)],
      });
      return reply.status(201).send({
        id: saved.id,
        ecosystem: saved.ecosystem,
        url: saved.url,
        priority: saved.priority,
        isEnabled: saved.isEnabled,
      });
    }
  );

  fastify.put<{
    Params: { id: string };
    Body: {
      url?: string;
      priority?: number;
      isEnabled?: boolean;
      timeoutMs?: number;
      retryCount?: number;
      authType?: string;
      authToken?: string;
      authUsername?: string;
      authPassword?: string;
      authHeaderName?: string;
      authHeaderValue?: string;
    };
  }>(
    '/api/admin/upstream-registries/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Upstream Registries'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            priority: { type: 'number' },
            isEnabled: { type: 'boolean' },
            timeoutMs: { type: 'number' },
            retryCount: { type: 'number' },
            authType: { type: 'string', enum: VALID_AUTH_TYPES, nullable: true },
            authToken: { type: 'string', nullable: true },
            authUsername: { type: 'string', nullable: true },
            authPassword: { type: 'string', nullable: true },
            authHeaderName: { type: 'string', nullable: true },
            authHeaderValue: { type: 'string', nullable: true },
          },
        },
        response: { 200: { type: 'object', properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};
      const repo = fastify.db.getRepository(UpstreamRegistry);
      const reg = await repo.findOne({ where: { id } });
      if (!reg) return reply.status(404).send({ error: 'Registry not found' });

      if (body.url !== undefined) reg.url = body.url.replace(/\/$/, '');
      if (body.priority !== undefined) reg.priority = body.priority;
      if (body.isEnabled !== undefined) reg.isEnabled = body.isEnabled;
      if (body.timeoutMs !== undefined) reg.timeoutMs = body.timeoutMs;
      if (body.retryCount !== undefined) reg.retryCount = body.retryCount;

      const authPayload = buildAuthPayloadForUpdate(body, reg);
      if (authPayload !== undefined) {
        reg.authType = body.authType ?? null;
        reg.authEncrypted = authPayload ? encodeAuth(authPayload) : null;
      }

      await repo.save(reg);
      await syncUpstreamRegistry(fastify.db, reg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: reg.ecosystem,
        packageName: reg.url,
        decision: 'UPSTREAM_REGISTRY_UPDATED',
      });
      return reply.send({ id: reg.id });
    }
  );

  fastify.post<{
    Body: {
      ecosystem?: string;
      url?: string;
      timeoutMs?: number;
      authType?: string;
      authToken?: string;
      authUsername?: string;
      authPassword?: string;
      authHeaderName?: string;
      authHeaderValue?: string;
    };
  }>(
    '/api/admin/upstream-registries/test-connection',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Upstream Registries'],
        body: {
          type: 'object',
          required: ['ecosystem', 'url'],
          properties: {
            ecosystem: { type: 'string', enum: VALID_ECOSYSTEMS },
            url: { type: 'string' },
            timeoutMs: { type: 'number' },
            authType: { type: 'string', enum: VALID_AUTH_TYPES, nullable: true },
            authToken: { type: 'string', nullable: true },
            authUsername: { type: 'string', nullable: true },
            authPassword: { type: 'string', nullable: true },
            authHeaderName: { type: 'string', nullable: true },
            authHeaderValue: { type: 'string', nullable: true },
          },
        },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' }, latencyMs: { type: 'number' } } },
          502: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const { ecosystem, url } = body;
      if (!ecosystem || !url || !VALID_ECOSYSTEMS.includes(ecosystem as (typeof VALID_ECOSYSTEMS)[number])) {
        return reply.status(400).send({ error: 'ecosystem and url required' });
      }
      const base = (url as string).replace(/\/$/, '');
      const testUrl = base + upstreamHealthCheckPath(base);
      const auth = buildAuthFromBody(body);
      const headers = buildAuthHeaders(auth);
      const timeoutMs = Math.min(body.timeoutMs ?? 5000, 10000);
      const start = Date.now();
      try {
        const { fetchWithRetry } = await import('../services/upstream-provider.js');
        await fetchWithRetry(testUrl, {
          headers,
          timeoutMs,
          retryCount: 0,
        });
        return reply.send({ ok: true, latencyMs: Date.now() - start });
      } catch (err) {
        return reply.status(502).send({
          error: err instanceof Error ? err.message : 'Connection failed',
        });
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/upstream-registries/:id/test',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Upstream Registries'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' }, latencyMs: { type: 'number' } } },
          502: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const reg = await fastify.db.getRepository(UpstreamRegistry).findOne({ where: { id } });
      if (!reg) return reply.status(404).send({ error: 'Registry not found' });

      const base = reg.url.replace(/\/$/, '');
      const testUrl = base + upstreamHealthCheckPath(base);
      const start = Date.now();
      try {
        const { fetchWithRetry } = await import('../services/upstream-provider.js');
        const auth = parseAuth(reg);
        const headers = buildAuthHeaders(auth);
        await fetchWithRetry(testUrl, {
          headers,
          timeoutMs: Math.min(reg.timeoutMs, 5000),
          retryCount: 0,
          circuitKey: `upstream:${reg.id}`,
        });
        return reply.send({ ok: true, latencyMs: Date.now() - start });
      } catch (err) {
        return reply.status(502).send({
          error: err instanceof Error ? err.message : 'Connection failed',
        });
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/upstream-registries/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Upstream Registries'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const reg = await fastify.db.getRepository(UpstreamRegistry).findOne({ where: { id } });
      if (!reg) return reply.status(404).send({ error: 'Registry not found' });
      const removed = await removeUpstreamRepository(fastify.db, reg.id);
      await fastify.db.getRepository(UpstreamRegistry).remove(reg);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      if (removed) auditDetach(fastify.db, { reqIp, userAgent, requester }, removed.label, removed.detached);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: reg.ecosystem,
        packageName: reg.url,
        decision: 'UPSTREAM_REGISTRY_DELETED',
      });
      return reply.status(204).send();
    }
  );
};

function buildAuthFromBody(body: {
  authType?: string;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}): AuthConfig | null {
  const { authType } = body;
  if (!authType || !VALID_AUTH_TYPES.includes(authType as (typeof VALID_AUTH_TYPES)[number])) return null;
  if (authType === 'bearer' && body.authToken) return { type: 'bearer', token: body.authToken };
  if (authType === 'basic' && body.authUsername && body.authPassword) {
    return { type: 'basic', username: body.authUsername, password: body.authPassword };
  }
  if (authType === 'header' && body.authHeaderName && body.authHeaderValue) {
    return { type: 'header', headerName: body.authHeaderName, value: body.authHeaderValue };
  }
  return null;
}

function buildAuthPayload(body: {
  authType?: string;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
}): Record<string, string> | null | undefined {
  const { authType } = body;
  if (!authType || !VALID_AUTH_TYPES.includes(authType as (typeof VALID_AUTH_TYPES)[number])) {
    return body.authType === null ? null : undefined;
  }
  if (authType === 'bearer' && body.authToken) return { token: body.authToken };
  if (authType === 'basic' && body.authUsername && body.authPassword) {
    return { username: body.authUsername, password: body.authPassword };
  }
  if (authType === 'header' && body.authHeaderName && body.authHeaderValue) {
    return { headerName: body.authHeaderName, value: body.authHeaderValue };
  }
  return undefined;
}

function buildAuthPayloadForUpdate(
  body: {
    authType?: string;
    authToken?: string;
    authUsername?: string;
    authPassword?: string;
    authHeaderName?: string;
    authHeaderValue?: string;
  },
  existing: UpstreamRegistry
): Record<string, string> | null | undefined {
  const { authType } = body;
  if (authType === null || authType === undefined) return undefined;
  if (!authType || !VALID_AUTH_TYPES.includes(authType as (typeof VALID_AUTH_TYPES)[number])) {
    return authType === '' ? null : undefined;
  }
  const existingAuth = parseAuth(existing);

  if (authType === 'bearer') {
    const token = body.authToken;
    if (token && token !== AUTH_MASK_PLACEHOLDER) return { token };
    if (existingAuth?.type === 'bearer' && existingAuth.token) return { token: existingAuth.token };
    return token === AUTH_MASK_PLACEHOLDER && existingAuth?.token ? { token: existingAuth.token } : undefined;
  }
  if (authType === 'basic') {
    let username = body.authUsername;
    let password = body.authPassword;
    if (username === AUTH_MASK_PLACEHOLDER && existingAuth?.type === 'basic') username = existingAuth.username;
    if (password === AUTH_MASK_PLACEHOLDER && existingAuth?.type === 'basic') password = existingAuth.password;
    if (username && password) return { username, password };
    return undefined;
  }
  if (authType === 'header') {
    let headerName = body.authHeaderName;
    let headerValue = body.authHeaderValue;
    if (headerName === AUTH_MASK_PLACEHOLDER && existingAuth?.type === 'header') headerName = existingAuth.headerName;
    if (headerValue === AUTH_MASK_PLACEHOLDER && existingAuth?.type === 'header') headerValue = existingAuth.value;
    if (headerName && headerValue) return { headerName, value: headerValue };
    return undefined;
  }
  return undefined;
}

export default fp(upstreamRegistriesRoutes);
