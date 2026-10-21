import { FastifyPluginAsync } from 'fastify';
import { DataSource, In } from 'typeorm';
import {
  PackageRepository,
  type PackageRepositoryType,
  type RepositorySource,
} from '../db/entities/PackageRepository.js';
import { isKnownPublicRegistry } from '../services/namespace-protection.js';
import { PackageRepositoryMember } from '../db/entities/PackageRepositoryMember.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { fetchWithRetry, buildAuthHeaders, encodeAuth, parseAuth, type AuthConfig } from '../services/upstream-provider.js';
import {
  clientPath,
  isEcosystem,
  shareRepoKey,
  unshareRepoKey,
  validateRepoKey,
} from '../services/repo-keys.js';
import { compareAllOrder, nextAllPosition, resolveRemoteTargets } from '../services/repository-resolve.js';
import { bumpRepositories } from '../services/reference-cache.js';
import { Policy } from '../db/entities/Policy.js';
import { detachRepository, repositoryUsage } from '../services/repository-scope.js';
import { auditDetach } from '../services/scope-audit.js';

export { auditDetach };

const TYPES: PackageRepositoryType[] = ['remote', 'virtual'];
const SOURCES: RepositorySource[] = ['public', 'internal'];

/** Why `source` cannot be set on this repository, or null. Undefined leaves it unchanged. */
function sourceError(source: unknown, type: PackageRepositoryType, reserved: boolean): string | null {
  if (source === undefined) return null;
  if (!SOURCES.includes(source as RepositorySource)) return 'source must be public or internal';
  if (type !== 'remote') return 'Only remote repositories have a source; a virtual repository uses its members';
  if (reserved && source !== 'public') return 'The default remote is the public registry; its source is always public';
  return null;
}
const AUTH_TYPES = ['bearer', 'basic', 'header'] as const;
const AUTH_MASK = '********';

type AuthBody = {
  authType?: string | null;
  authToken?: string;
  authUsername?: string;
  authPassword?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
};

function buildAuth(body: AuthBody): { authType: string | null; authEncrypted: string | null } | { error: string } | null {
  const type = body.authType || null;
  if (!type) return { authType: null, authEncrypted: null };
  if (!AUTH_TYPES.includes(type as (typeof AUTH_TYPES)[number])) return { error: 'Invalid auth type' };
  let payload: Record<string, string> | null = null;
  if (type === 'bearer' && body.authToken && body.authToken !== AUTH_MASK) payload = { token: body.authToken };
  if (type === 'basic' && body.authUsername && body.authPassword && body.authPassword !== AUTH_MASK) {
    payload = { username: body.authUsername, password: body.authPassword };
  }
  if (type === 'header' && body.authHeaderName && body.authHeaderValue && body.authHeaderValue !== AUTH_MASK) {
    payload = { headerName: body.authHeaderName, value: body.authHeaderValue };
  }
  if (!payload) return null;
  return { authType: type, authEncrypted: encodeAuth(payload) };
}

async function orderedMemberKeys(db: DataSource, row: PackageRepository): Promise<string[]> {
  if (row.type !== 'virtual') return [];
  const repos = db.getRepository(PackageRepository);
  if (row.key === 'all') {
    const remotes = await resolveRemoteTargets(db, row.ecosystem, 'all');
    const remoteRows = remotes.length
      ? await repos.find({ where: { id: In(remotes.map((r) => r.id)) } })
      : [];
    const remoteById = new Map(remoteRows.map((r) => [r.id, r.key]));
    return remotes.map((r) => remoteById.get(r.id) ?? r.id);
  }
  const members = await db.getRepository(PackageRepositoryMember).find({
    where: { virtualId: row.id },
    order: { position: 'ASC' },
  });
  if (members.length === 0) return [];
  const rows = await repos.find({ where: { id: In(members.map((m) => m.memberId)) } });
  const byId = new Map(rows.map((r) => [r.id, r.key]));
  return members.map((m) => byId.get(m.memberId)).filter((key): key is string => !!key);
}

function present(row: PackageRepository, memberKeys: string[]) {
  const authConfigured = !!row.authEncrypted;
  return {
    id: row.id,
    ecosystem: row.ecosystem,
    key: row.key,
    type: row.type,
    upstreamUrl: row.upstreamUrl,
    /** Remotes only. The reserved `default` remote is always public. */
    source: row.type === 'remote' ? (row.isReserved ? 'public' : row.source ?? 'public') : null,
    /** An internal remote whose URL is a well-known public registry: probably a mistake. */
    looksPublic: row.type === 'remote' && row.source === 'internal' && isKnownPublicRegistry(row.ecosystem, row.upstreamUrl),
    priority: row.priority,
    isEnabled: row.isEnabled,
    isReserved: row.isReserved,
    timeoutMs: row.timeoutMs,
    retryCount: row.retryCount,
    description: row.description,
    clientPath: clientPath(row.ecosystem, row.key),
    memberKeys,
    authConfigured,
    authType: row.authType,
    createdAt: row.createdAt.toISOString(),
  };
}

const repositoryRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['User', 'Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });
  const repos = () => fastify.db.getRepository(PackageRepository);
  const members = () => fastify.db.getRepository(PackageRepositoryMember);

  /**
   * `all` contains every remote automatically; its member list sets the search order (R2). The list
   * must name every enabled remote once. Remotes left out (disabled ones) keep their place after it.
   */
  async function orderAll(all: PackageRepository, keys: string[]): Promise<{ error: string } | { before: string[]; after: string[] }> {
    const remotes = (await repos().find({ where: { ecosystem: all.ecosystem, type: 'remote' } })).sort(compareAllOrder);
    const byKey = new Map(remotes.map((row) => [row.key, row]));
    const seen = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) return { error: `Repository "${key}" is listed twice` };
      seen.add(key);
      if (!byKey.has(key)) return { error: `"${key}" is not a remote repository of ${all.ecosystem}` };
    }
    const missing = remotes.filter((row) => row.isEnabled && !seen.has(row.key)).map((row) => row.key);
    if (missing.length) return { error: `List every enabled remote of ${all.ecosystem}. Missing: ${missing.join(', ')}` };
    const before = remotes.filter((row) => row.isEnabled).map((row) => row.key);
    const ordered = [...keys.map((key) => byKey.get(key)!), ...remotes.filter((row) => !seen.has(row.key))];
    await fastify.db.transaction(async (manager) => {
      for (const [position, row] of ordered.entries()) {
        await manager.getRepository(PackageRepository).update({ id: row.id }, { allPosition: position });
      }
    });
    await bumpRepositories(all.ecosystem);
    return { before, after: ordered.filter((row) => row.isEnabled).map((row) => row.key) };
  }

  async function replaceMembers(virtual: PackageRepository, memberKeys: string[]): Promise<string | null> {
    if (virtual.key === 'all') return 'Use the order of all instead';
    const candidates = await repos().find({ where: { ecosystem: virtual.ecosystem } });
    const byKey = new Map(candidates.map((row) => [row.key, row]));
    const chosen: PackageRepository[] = [];
    for (const key of memberKeys) {
      const row = byKey.get(key);
      if (!row) return `Unknown repository "${key}"`;
      if (row.type === 'virtual') return 'A virtual repository cannot contain another virtual repository';
      if (row.id === virtual.id) return 'A repository cannot contain itself';
      chosen.push(row);
    }
    await members().delete({ virtualId: virtual.id });
    if (chosen.length) {
      await members().save(
        chosen.map((row, position) =>
          members().create({ virtualId: virtual.id, memberId: row.id, position })
        ) as never
      );
    }
    await bumpRepositories(virtual.ecosystem);
    return null;
  }

  fastify.get<{ Querystring: { ecosystem?: string } }>(
    '/api/admin/repositories',
    { onRequest: [requireRead], schema: { tags: ['Repositories'] } },
    async (request, reply) => {
      const ecosystem = request.query?.ecosystem;
      const where = ecosystem && isEcosystem(ecosystem) ? { ecosystem } : {};
      const list = await repos().find({ where, order: { ecosystem: 'ASC', type: 'ASC', key: 'ASC' } });
      const body = [];
      for (const row of list) {
        body.push(present(row, await orderedMemberKeys(fastify.db, row)));
      }
      return reply.send(body);
    }
  );

  fastify.post<{
    Body: AuthBody & {
      ecosystem?: string;
      key?: string;
      type?: string;
      upstreamUrl?: string;
      timeoutMs?: number;
      retryCount?: number;
      description?: string;
      isEnabled?: boolean;
      memberKeys?: string[];
      source?: RepositorySource;
    };
  }>('/api/admin/repositories', { onRequest: [requireWrite], schema: { tags: ['Repositories'] } }, async (request, reply) => {
    const body = request.body ?? {};
    const ecosystem = body.ecosystem ?? '';
    const key = (body.key ?? '').trim().toLowerCase();
    const type = body.type as PackageRepositoryType;
    if (!isEcosystem(ecosystem)) return reply.status(400).send({ error: 'ecosystem is required' });
    if (!TYPES.includes(type)) return reply.status(400).send({ error: 'type must be remote or virtual' });
    const keyError = validateRepoKey(key);
    if (keyError) return reply.status(400).send({ error: keyError });
    if (await repos().findOne({ where: { ecosystem, key } })) {
      return reply.status(409).send({ error: `Repository ${key} already exists` });
    }
    if (type === 'remote' && !body.upstreamUrl?.trim()) {
      return reply.status(400).send({ error: 'A remote repository requires an upstream URL' });
    }
    // A public remote may have its package names looked up on deps.dev, so it is never assumed.
    if (type === 'remote' && body.source === undefined) {
      return reply.status(400).send({ error: 'A remote repository requires a source: public or internal' });
    }
    const badSource = sourceError(body.source, type, false);
    if (badSource) return reply.status(400).send({ error: badSource });
    const auth = buildAuth(body);
    if (auth && 'error' in auth) return reply.status(400).send({ error: auth.error });

    const saved = await repos().save(
      repos().create({
        ecosystem,
        key,
        type,
        upstreamUrl: type === 'remote' ? body.upstreamUrl!.trim().replace(/\/$/, '') : null,
        source: body.source,
        // A new remote joins the end of `all` (R2).
        allPosition: type === 'remote' ? await nextAllPosition(fastify.db, ecosystem) : null,
        isEnabled: body.isEnabled !== false,
        isReserved: false,
        timeoutMs: body.timeoutMs ?? 30000,
        retryCount: body.retryCount ?? 3,
        description: body.description?.trim() || null,
        authType: auth && !('error' in auth) ? auth.authType : null,
        authEncrypted: auth && !('error' in auth) ? auth.authEncrypted : null,
      })
    );
    shareRepoKey(ecosystem, key);
    if (type === 'virtual' && body.memberKeys?.length) {
      const memberError = await replaceMembers(saved, body.memberKeys);
      if (memberError) {
        await repos().remove(saved);
        unshareRepoKey(ecosystem, key);
        return reply.status(400).send({ error: memberError });
      }
    }
    const { reqIp, userAgent, requester } = getRequestContext(request);
    logAudit(fastify.db, {
      requesterIp: reqIp,
      userAgent,
      requester,
      ecosystem,
      packageName: key,
      decision: 'REPOSITORY_CREATED',
      conditionReasons: type === 'remote' ? [type, `Source: ${saved.source}`] : [type],
    });
    return reply.status(201).send(present(saved, body.memberKeys ?? []));
  });

  fastify.put<{
    Params: { id: string };
    Body: AuthBody & {
      upstreamUrl?: string;
      isEnabled?: boolean;
      timeoutMs?: number;
      retryCount?: number;
      description?: string | null;
      memberKeys?: string[];
      source?: RepositorySource;
    };
  }>('/api/admin/repositories/:id', { onRequest: [requireWrite], schema: { tags: ['Repositories'] } }, async (request, reply) => {
    const row = await repos().findOne({ where: { id: request.params.id } });
    if (!row) return reply.status(404).send({ error: 'Repository not found' });
    const body = request.body ?? {};
    const badSource = sourceError(body.source, row.type, row.isReserved);
    if (badSource) return reply.status(400).send({ error: badSource });
    const previousSource: RepositorySource = row.source ?? 'public';
    if (body.source !== undefined && row.type === 'remote') row.source = body.source;
    if (body.upstreamUrl !== undefined && row.type === 'remote') {
      row.upstreamUrl = body.upstreamUrl.trim().replace(/\/$/, '');
    }
    if (body.isEnabled !== undefined) row.isEnabled = body.isEnabled;
    if (body.timeoutMs !== undefined) row.timeoutMs = body.timeoutMs;
    if (body.retryCount !== undefined) row.retryCount = body.retryCount;
    if (body.description !== undefined) row.description = body.description?.trim() || null;
    const auth = buildAuth(body);
    if (auth && 'error' in auth) return reply.status(400).send({ error: auth.error });
    if (auth && !('error' in auth)) {
      row.authType = auth.authType;
      row.authEncrypted = auth.authEncrypted;
    }
    let orderChange: { before: string[]; after: string[] } | null = null;
    if (body.memberKeys && row.key === 'all' && row.type === 'virtual') {
      const ordered = await orderAll(row, body.memberKeys);
      if ('error' in ordered) return reply.status(400).send({ error: ordered.error });
      if (ordered.before.join(',') !== ordered.after.join(',')) orderChange = ordered;
    }
    const saved = await repos().save(row);
    if (body.memberKeys && row.type === 'virtual' && row.key !== 'all') {
      const memberError = await replaceMembers(saved, body.memberKeys);
      if (memberError) return reply.status(400).send({ error: memberError });
    }
    const sourceChanged = saved.type === 'remote' && saved.source !== previousSource;
    // Reserved names get new cache keys (the namespace epoch includes every remote's source).
    if (sourceChanged) await bumpRepositories(saved.ecosystem);
    const { reqIp, userAgent, requester } = getRequestContext(request);
    logAudit(fastify.db, {
      requesterIp: reqIp,
      userAgent,
      requester,
      ecosystem: saved.ecosystem,
      packageName: saved.key,
      decision: 'REPOSITORY_UPDATED',
      conditionReasons: [
        saved.type,
        saved.isEnabled ? 'enabled' : 'disabled',
        ...(sourceChanged ? [`Source changed from ${previousSource} to ${saved.source}`] : []),
        ...(orderChange ? [`Order changed from ${orderChange.before.join(', ')} to ${orderChange.after.join(', ')}`] : []),
      ],
    });
    return reply.send(present(saved, await orderedMemberKeys(fastify.db, saved)));
  });

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/repositories/:id',
    { onRequest: [requireWrite], schema: { tags: ['Repositories'] } },
    async (request, reply) => {
      const row = await repos().findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Repository not found' });
      if (row.isReserved) return reply.status(400).send({ error: `${row.key} is reserved and cannot be deleted` });
      const used = await members().count({ where: { memberId: row.id } });
      if (used > 0) {
        return reply.status(400).send({ error: 'Remove this repository from virtual repositories before deleting it' });
      }
      const detached = await fastify.db.transaction(async (manager) => {
        const result = await detachRepository(manager, row.id);
        await manager.getRepository(PackageRepositoryMember).delete({ virtualId: row.id });
        await manager.getRepository(PackageRepository).remove(row);
        return result;
      });
      unshareRepoKey(row.ecosystem, row.key);
      await bumpRepositories(row.ecosystem);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      auditDetach(fastify.db, { reqIp, userAgent, requester }, `${row.ecosystem}/${row.key}`, detached);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: row.ecosystem,
        packageName: row.key,
        decision: 'REPOSITORY_DELETED',
        conditionReasons: [row.type],
      });
      return reply.status(204).send();
    }
  );

  /** Enabled policies that apply to this repository, in priority order: scoped to it, or to every repository. */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/repositories/:id/policies',
    { onRequest: [requireWrite], schema: { tags: ['Repositories'] } },
    async (request, reply) => {
      const row = await repos().findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Repository not found' });
      const list = await fastify.db
        .getRepository(Policy)
        .createQueryBuilder('p')
        .where('p.isEnabled = true')
        .andWhere('(jsonb_array_length(p.repository_ids) = 0 OR p.repository_ids @> :scopeIdJson::jsonb)', {
          scopeIdJson: JSON.stringify([row.id]),
        })
        .andWhere(
          `(COALESCE(jsonb_array_length(p.conditions->'ecosystem'), 0) = 0 OR p.conditions->'ecosystem' @> :ecoJson::jsonb)`,
          { ecoJson: JSON.stringify([row.ecosystem]) }
        )
        .orderBy('p.priority', 'ASC')
        .addOrderBy('p.createdAt', 'ASC')
        .getMany();
      return reply.send(
        list.map((p) => ({
          id: p.id,
          name: p.name,
          decision: p.decision,
          mode: p.mode,
          priority: p.priority,
          scope: (p.repositoryIds ?? []).length > 0 ? 'scoped' : 'global',
        }))
      );
    }
  );

  /** What deleting this repository would change: scoped policies, exceptions and pending waivers. */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/repositories/:id/usage',
    { onRequest: [requireWrite], schema: { tags: ['Repositories'] } },
    async (request, reply) => {
      const row = await repos().findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Repository not found' });
      return reply.send(await repositoryUsage(fastify.db, row.id));
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/repositories/:id/test',
    { onRequest: [requireWrite], schema: { tags: ['Repositories'] } },
    async (request, reply) => {
      const row = await repos().findOne({ where: { id: request.params.id } });
      if (!row) return reply.status(404).send({ error: 'Repository not found' });
      if (row.type !== 'remote' || !row.upstreamUrl) {
        return reply.status(400).send({ error: 'Only remote repositories can be connection-tested' });
      }
      const start = Date.now();
      try {
        const auth = parseAuth(row) as AuthConfig | null;
        await fetchWithRetry(row.upstreamUrl, {
          headers: buildAuthHeaders(auth),
          timeoutMs: row.timeoutMs,
          retryCount: 0,
        });
        return reply.send({ ok: true, latencyMs: Date.now() - start });
      } catch (err) {
        return reply.status(502).send({ error: err instanceof Error ? err.message : 'Connection failed' });
      }
    }
  );
};

export default repositoryRoutes;
