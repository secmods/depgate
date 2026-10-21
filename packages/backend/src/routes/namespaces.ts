import { FastifyPluginAsync } from 'fastify';
import { NamespaceCollision } from '../db/entities/NamespaceCollision.js';
import { Policy } from '../db/entities/Policy.js';
import { getCompiledPolicies, type CompiledPolicy, type PolicyConditions } from '../services/policy-engine.js';
import {
  compileCandidate,
  evaluateNamespace,
  isKnownPublicRegistry,
  namespaceBlockResult,
  remoteLabel,
  resolvePackageTargets,
} from '../services/namespace-protection.js';
import { canonicalName, goNoSumDb, namespacePatternError } from '../services/namespace-patterns.js';
import { listRemotes } from '../services/repository-resolve.js';
import { isEcosystem } from '../services/repo-keys.js';
import { runNow } from '../services/jobs/scheduled.js';
import { JobRun } from '../db/entities/JobRun.js';
import { getRequestContext, logAudit } from '../services/audit-service.js';

type CheckInput = {
  ecosystem?: string;
  name?: string;
  repository?: string;
  /** A policy being written in the form: checked on its own instead of the saved policies. */
  reservedNamespaces?: string[];
  publicPackages?: string[];
  /** Remotes the candidate allows; empty for every internal remote (R6). */
  allowedRemotes?: string[];
  mode?: 'enforce' | 'monitor';
  repositoryIds?: string[];
};

const namespacesRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });

  async function check(input: CheckInput) {
    const ecosystem = input.ecosystem ?? '';
    const name = (input.name ?? '').trim();
    const repository = input.repository?.trim() || 'all';
    if (!isEcosystem(ecosystem)) return { status: 400 as const, body: { error: 'ecosystem is required' } };
    if (!name) return { status: 400 as const, body: { error: 'name is required' } };

    let policies: CompiledPolicy[];
    if (input.reservedNamespaces !== undefined) {
      const patternErrors = (input.reservedNamespaces ?? [])
        .map((pattern) => ({ pattern, error: namespacePatternError(ecosystem, pattern) }))
        .filter((row) => row.error);
      if (patternErrors.length) return { status: 400 as const, body: { error: patternErrors[0].error, patternErrors } };
      const conditions: PolicyConditions = {
        ecosystem: [ecosystem],
        reservedNamespaces: input.reservedNamespaces,
        publicPackages: input.publicPackages ?? [],
        ...(input.allowedRemotes?.length ? { allowedRemotes: input.allowedRemotes } : {}),
      };
      policies = [compileCandidate(conditions, { mode: input.mode, repositoryIds: input.repositoryIds ?? [] })];
    } else {
      policies = await getCompiledPolicies(fastify.db, { verifyPolicies: true });
    }

    const route = await resolvePackageTargets(fastify.db, ecosystem, repository, name, { policies });
    if (route.targets.length + route.skipped.length === 0) {
      return { status: 400 as const, body: { error: `Repository "${repository}" does not exist or is not enabled for ${ecosystem}` } };
    }
    const { matches } = await evaluateNamespace(fastify.db, ecosystem, repository, name, policies);
    const label = (target: { key: string }) => remoteLabel(ecosystem, target);
    const deciding = route.reserved ?? route.monitored[0] ?? null;
    let outcome: 'unrestricted' | 'internal' | 'blocked' | 'monitor' = 'unrestricted';
    let reason: string | null = null;
    if (route.reserved && route.block) {
      outcome = 'blocked';
      reason = namespaceBlockResult(route.reserved, ecosystem, repository, name).reasons[0];
    } else if (route.reserved) {
      outcome = 'internal';
      // R6: a policy bound to chosen remotes may allow public ones, so name them by the policy, not by source.
      const bound = (route.reserved.allowedRemoteIds?.length ?? 0) > 0;
      const serving = route.targets.map(label).join(', ');
      const skipped = route.skipped.map(label).join(', ');
      reason = bound
        ? `Served only from the remotes the policy allows (${serving}); ${skipped ? `${skipped} ${route.skipped.length > 1 ? 'are' : 'is'} not consulted` : 'no other remote is in the repository'}`
        : `Served only from internal remotes (${serving}); ${skipped ? `public remotes ${skipped} are not consulted` : 'the repository has no public remote'}`;
    } else if (route.monitored.length) {
      outcome = 'monitor';
      reason = 'Monitor mode: served as today; a hit is recorded when a public remote serves it';
    } else if (matches.some((match) => match.lifted)) {
      const lifted = matches.find((match) => match.lifted)!;
      reason =
        lifted.lifted === 'publicPackages'
          ? `In reserved namespace "${lifted.pattern}", but listed as published publicly on purpose`
          : lifted.lifted === 'exception'
            ? `In reserved namespace "${lifted.pattern}", but an exception to "${lifted.policyName}" lets it come from any remote`
            : `In reserved namespace "${lifted.pattern}", but "${lifted.policyName}" does not apply to ${ecosystem}/${repository}`;
    }
    return {
      status: 200 as const,
      body: {
        ecosystem,
        name,
        canonicalName: canonicalName(ecosystem, name),
        repository,
        reserved: deciding !== null,
        outcome,
        reason,
        policy: deciding
          ? { id: deciding.policyId, name: deciding.policyName, mode: deciding.mode, pattern: deciding.pattern }
          : null,
        matches,
        servingRemotes: route.targets.map(label),
        internalRemotes: route.targets.filter((target) => target.source === 'internal').map(label),
        publicRemotesSkipped: route.reserved ? route.skipped.map(label) : [],
      },
    };
  }

  /** Whether a name is reserved, by which policy and pattern, and which remotes would serve it. */
  fastify.get<{ Querystring: CheckInput }>(
    '/api/admin/namespaces/check',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Namespaces'],
        querystring: {
          type: 'object',
          required: ['ecosystem', 'name'],
          properties: { ecosystem: { type: 'string' }, name: { type: 'string' }, repository: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { ecosystem, name, repository } = request.query;
      const result = await check({ ecosystem, name, repository });
      return reply.status(result.status).send(result.body);
    }
  );

  /** The same for a policy that is being written and is not saved yet ("Try a name" in the form). */
  fastify.post<{ Body: CheckInput }>(
    '/api/admin/namespaces/check',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Namespaces'],
        body: {
          type: 'object',
          required: ['ecosystem', 'name', 'reservedNamespaces'],
          properties: {
            ecosystem: { type: 'string' },
            name: { type: 'string' },
            repository: { type: 'string' },
            reservedNamespaces: { type: 'array', items: { type: 'string' } },
            publicPackages: { type: 'array', items: { type: 'string' } },
            allowedRemotes: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['enforce', 'monitor'] },
            repositoryIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await check(request.body ?? {});
      return reply.status(result.status).send(result.body);
    }
  );

  /** Per-pattern validation for the policy form, and the GONOSUMDB value for Go. */
  fastify.post<{ Body: { ecosystem?: string; patterns?: string[] } }>(
    '/api/admin/namespaces/validate',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Namespaces'],
        body: {
          type: 'object',
          required: ['ecosystem', 'patterns'],
          properties: { ecosystem: { type: 'string' }, patterns: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { ecosystem = '', patterns = [] } = request.body ?? {};
      if (!isEcosystem(ecosystem)) return reply.status(400).send({ error: 'ecosystem is required' });
      return reply.send({
        results: patterns.map((pattern) => ({ pattern, error: namespacePatternError(ecosystem, pattern) })),
        goNoSumDb: ecosystem === 'go' ? goNoSumDb(patterns) : null,
      });
    }
  );

  /** The ecosystem's remotes and their source, for the policy form's Remotes panel. */
  fastify.get<{ Querystring: { ecosystem?: string } }>(
    '/api/admin/namespaces/remotes',
    { onRequest: [requireSecurity], schema: { tags: ['Namespaces'] } },
    async (request, reply) => {
      const ecosystem = request.query?.ecosystem ?? '';
      if (!isEcosystem(ecosystem)) return reply.status(400).send({ error: 'ecosystem is required' });
      const remotes = await listRemotes(fastify.db, ecosystem);
      return reply.send(
        remotes.map((remote) => ({
          id: remote.id,
          key: remote.key,
          label: remoteLabel(ecosystem, remote),
          url: remote.url,
          source: remote.source,
          isEnabled: remote.isEnabled,
          looksPublic: remote.source === 'internal' && isKnownPublicRegistry(ecosystem, remote.url),
        }))
      );
    }
  );

  /** Reserved names this policy protects that also exist on the public registry. */
  fastify.get<{ Params: { id: string } }>(
    '/api/admin/policies/:id/collisions',
    { onRequest: [requireSecurity], schema: { tags: ['Namespaces'] } },
    async (request, reply) => {
      const policy = await fastify.db.getRepository(Policy).findOne({ where: { id: request.params.id } });
      if (!policy) return reply.status(404).send({ error: 'Policy not found' });
      const rows = await fastify.db.getRepository(NamespaceCollision).find({
        where: { policyId: policy.id },
        order: { firstSeenAt: 'DESC' },
        take: 500,
      });
      return reply.send(
        rows.map((row) => ({
          id: row.id,
          ecosystem: row.ecosystem,
          name: row.name,
          firstSeenAt: row.firstSeenAt.toISOString(),
          lastCheckedAt: row.lastCheckedAt.toISOString(),
          publicLatestVersion: row.publicLatestVersion,
        }))
      );
    }
  );

  /** Queue a collision check now (it does nothing while the setting is off). One run at a time across the cluster. */
  fastify.post('/api/admin/namespaces/collisions/run', { onRequest: [requireSecurity], schema: { tags: ['Namespaces'] } }, async (request, reply) => {
    const queued = await runNow('namespace-collision-check');
    if ('conflict' in queued) return reply.status(409).send({ error: 'A collision check is already running' });
    if ('unavailable' in queued) return reply.status(503).send({ error: 'The job queue is unavailable; try again shortly' });
    const { reqIp, userAgent, requester } = getRequestContext(request);
    logAudit(fastify.db, {
      requesterIp: reqIp,
      userAgent,
      requester,
      ecosystem: 'config',
      packageName: 'namespace-collisions',
      decision: 'CONFIG_UPDATED',
      conditionReasons: ['Collision check queued'],
    });
    return reply.status(202).send({ queued: true, jobId: queued.jobId });
  });

  /** The outcome of a queued run: the newest run recorded for that job ID. */
  fastify.get<{ Params: { jobId: string } }>(
    '/api/admin/namespaces/collisions/run/:jobId',
    { onRequest: [requireSecurity], schema: { tags: ['Namespaces'] } },
    async (request, reply) => {
      const run = await fastify.db
        .getRepository(JobRun)
        .findOne({ where: { job: 'namespace-collision-check', jobId: request.params.jobId }, order: { startedAt: 'DESC' } });
      if (!run) return reply.send({ status: 'queued' });
      return reply.send({
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        ...(run.result ?? {}),
        error: run.error,
      });
    }
  );
};

export default namespacesRoutes;
