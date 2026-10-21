import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { Policy, PolicyDecision, PolicyMode } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import type { PolicyConditions } from '../services/policy-engine.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';
import { policyConditionsError, ruleDecisionError } from '../services/policy-rules.js';
import { canonicalScorecardChecks } from '../services/scorecard-rule.js';
import { withCvssMin } from '../services/cvss.js';
import { SCORECARD_CHECKS } from '../services/scorecard-checks.js';
import {
  simulatePolicy,
  simulatePolicyToggle,
  fetchRecentAuditPackages,
  AUDIT_LOG_LIMIT_MAX,
  AUDIT_LOG_LIMIT_DEFAULT,
  type SimulationPackageInput,
  type CandidatePolicyDef,
} from '../services/policy-simulation.js';
import { simulateNamespacePolicy } from '../services/namespace-simulation.js';
import { clearMonitorHits, ruleSignature, startRecheck, stopRecheck } from '../services/monitor-service.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import {
  describeScope,
  loadRepositoryRefs,
  parseScopeIds,
  refsFor,
  repositoryRefMap,
  validateRepositoryScope,
  allowedRemotesError,
  type RepositoryRef,
} from '../services/repository-scope.js';

const VALID_DECISIONS: PolicyDecision[] = ['ALLOW', 'BLOCK'];
const VALID_MODES: PolicyMode[] = ['enforce', 'monitor'];

function policyView(p: Policy, refs: Map<string, RepositoryRef>) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    decision: p.decision,
    conditions: withCvssMin((p.conditions ?? {}) as PolicyConditions),
    priority: p.priority,
    isEnabled: p.isEnabled,
    mode: p.mode ?? 'enforce',
    modeChangedAt: p.modeChangedAt ? new Date(p.modeChangedAt).toISOString() : null,
    repositoryIds: p.repositoryIds ?? [],
    repositories: refsFor(p.repositoryIds, refs),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const repositoryRefSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ecosystem: { type: 'string' },
    key: { type: 'string' },
    type: { type: 'string' },
  },
} as const;

const scopeSchemaProps = {
  repositoryIds: { type: 'array', items: { type: 'string' } },
  repositories: { type: 'array', items: repositoryRefSchema },
} as const;

function policyEcosystems(conditions: unknown): string[] {
  const list = (conditions as PolicyConditions | undefined)?.ecosystem;
  return Array.isArray(list) ? list.map(String) : [];
}

async function viewOf(db: Parameters<typeof repositoryRefMap>[0], policy: Policy) {
  return policyView(policy, await repositoryRefMap(db, [policy]));
}

/** Only a Block policy can monitor: an Allow in monitor mode would mean nothing. */
function modeError(decision: PolicyDecision, mode: PolicyMode): string | null {
  return mode === 'monitor' && decision !== 'BLOCK' ? 'Only Block policies can run in monitor mode' : null;
}

const MODE_LABELS: Record<PolicyMode, string> = { enforce: 'enforce', monitor: 'monitor' };


const policiesRoutes: FastifyPluginAsync = async (fastify) => {
  const requireRead = fastify.authenticate({ roles: ['Security'] });
  const requireWrite = fastify.authenticate({ roles: ['Security'] });

  fastify.get(
    '/api/admin/policies/scorecard-checks',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Policies'],
        summary: 'OpenSSF Scorecard checks a policy may set a minimum for',
        response: {
          200: {
            type: 'object',
            properties: {
              checks: {
                type: 'array',
                items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => reply.send({ checks: SCORECARD_CHECKS })
  );

  fastify.get<{
    Querystring: { limit?: string; offset?: string; repositoryId?: string; scope?: string };
  }>(
    '/api/admin/policies',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Policies'],
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'string' },
            offset: { type: 'string' },
            /** Policies that apply to this repository: scoped to it, or to every repository of its ecosystem. */
            repositoryId: { type: 'string', format: 'uuid' },
            /** scoped: only policies limited to some repositories. all: only policies for every repository. */
            scope: { type: 'string', enum: ['scoped', 'all'] },
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
                    description: { type: 'string', nullable: true },
                    decision: { type: 'string', enum: VALID_DECISIONS },
                    conditions: { type: 'object', additionalProperties: true },
                    priority: { type: 'number' },
                    isEnabled: { type: 'boolean' },
                    mode: { type: 'string', enum: VALID_MODES },
                    modeChangedAt: { type: 'string', nullable: true },
                    ...scopeSchemaProps,
                    createdAt: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              total: { type: 'number' },
              enabled: { type: 'number' },
              disabled: { type: 'number' },
              monitoring: { type: 'number' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const limit = Math.min(Math.max(parseInt(request.query?.limit ?? '100', 10) || 100, 1), 500);
      const offset = Math.max(parseInt(request.query?.offset ?? '0', 10) || 0, 0);
      const repo = fastify.db.getRepository(Policy);
      const base = repo.createQueryBuilder('p');
      const { repositoryId, scope } = request.query ?? {};
      if (repositoryId) {
        const target = await fastify.db.getRepository(PackageRepository).findOne({ where: { id: repositoryId } });
        if (!target) return reply.status(404).send({ error: 'Repository not found' });
        base
          .andWhere(
            `(jsonb_array_length(p.repository_ids) = 0 OR p.repository_ids @> :scopeIdJson::jsonb)`,
            { scopeIdJson: JSON.stringify([repositoryId]) }
          )
          .andWhere(
            `(COALESCE(jsonb_array_length(p.conditions->'ecosystem'), 0) = 0 OR p.conditions->'ecosystem' @> :ecoJson::jsonb)`,
            { ecoJson: JSON.stringify([target.ecosystem]) }
          );
      }
      if (scope === 'scoped') base.andWhere('jsonb_array_length(p.repository_ids) > 0');
      else if (scope === 'all') base.andWhere('jsonb_array_length(p.repository_ids) = 0');
      const [total, enabled, monitoring, list] = await Promise.all([
        base.clone().getCount(),
        base.clone().andWhere('p.isEnabled = true').getCount(),
        // Enabled monitor-mode policies: on, but not blocking.
        base
          .clone()
          .andWhere("p.mode = 'monitor' AND p.isEnabled = true AND p.decision = 'BLOCK'")
          .getCount(),
        base.clone().orderBy('p.priority', 'ASC').addOrderBy('p.createdAt', 'ASC').skip(offset).take(limit).getMany(),
      ]);
      const refs = await repositoryRefMap(fastify.db, list);
      return reply.send({
        items: list.map((p) => policyView(p, refs)),
        total,
        enabled,
        disabled: total - enabled,
        monitoring,
      });
    }
  );

  fastify.post<{
    Body: {
      name?: string;
      description?: string;
      decision?: PolicyDecision;
      conditions?: PolicyConditions;
      priority?: number;
      isEnabled?: boolean;
      mode?: PolicyMode;
      repositoryIds?: string[];
    };
  }>(
    '/api/admin/policies',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Policies'],
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            decision: { type: 'string', enum: VALID_DECISIONS },
            conditions: { type: 'object', additionalProperties: true },
            priority: { type: 'number' },
            isEnabled: { type: 'boolean' },
            mode: { type: 'string', enum: VALID_MODES },
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string', nullable: true },
              decision: { type: 'string' },
              conditions: { type: 'object', additionalProperties: true },
              priority: { type: 'number' },
              isEnabled: { type: 'boolean' },
              ...scopeSchemaProps,
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, description, decision, priority, isEnabled, mode } = request.body;
      const conditions = withCvssMin(request.body.conditions);
      const conditionsError =
        policyConditionsError(conditions) ??
        ruleDecisionError(decision ?? 'BLOCK', conditions) ??
        modeError(decision ?? 'BLOCK', mode ?? 'enforce');
      if (conditionsError) return reply.status(400).send({ error: conditionsError });
      const parsedScope = parseScopeIds(request.body.repositoryIds);
      if (parsedScope.error) return reply.status(400).send({ error: parsedScope.error });
      const scope = await validateRepositoryScope(fastify.db, parsedScope.ids ?? [], policyEcosystems(conditions));
      if ('error' in scope) return reply.status(400).send({ error: scope.error });
      const remotesError = await allowedRemotesError(fastify.db, conditions?.allowedRemotes, policyEcosystems(conditions)[0]);
      if (remotesError) return reply.status(400).send({ error: remotesError });
      const policy = fastify.db.getRepository(Policy).create({
        name,
        description: description ?? null,
        decision: decision ?? 'BLOCK',
        conditions: canonicalScorecardChecks(conditions ?? {}),
        priority: priority ?? 0,
        isEnabled: isEnabled ?? true,
        // New policies enforce unless asked: a forgotten monitor policy protects nothing.
        mode: mode ?? 'enforce',
        modeChangedAt: mode === 'monitor' ? new Date() : null,
        repositoryIds: parsedScope.ids ?? [],
      });
      const saved = await fastify.db.getRepository(Policy).save(policy);
      const createdNotes = [
        ...(saved.mode === 'monitor' ? ['Created in monitor mode'] : []),
        ...(scope.refs.length ? [`Scoped to ${describeScope(scope.refs)}`] : []),
      ];
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'policy',
        packageName: saved.name,
        decision: 'POLICY_CREATED',
        policyId: saved.id,
        policyName: saved.name,
        conditionReasons: createdNotes.length ? createdNotes : null,
      });
      return reply.status(201).send(await viewOf(fastify.db, saved));
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/admin/policies/:id',
    {
      onRequest: [requireRead],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string', nullable: true },
              decision: { type: 'string' },
              conditions: { type: 'object', additionalProperties: true },
              priority: { type: 'number' },
              isEnabled: { type: 'boolean' },
              mode: { type: 'string', enum: VALID_MODES },
              modeChangedAt: { type: 'string', nullable: true },
              ...scopeSchemaProps,
              createdAt: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const policy = await fastify.db.getRepository(Policy).findOne({ where: { id } });
      if (!policy) return reply.status(404).send({ error: 'Policy not found' });
      return reply.send(await viewOf(fastify.db, policy));
    }
  );

  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      decision?: PolicyDecision;
      conditions?: PolicyConditions;
      priority?: number;
      isEnabled?: boolean;
      mode?: PolicyMode;
      repositoryIds?: string[];
    };
  }>(
    '/api/admin/policies/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string', nullable: true },
            decision: { type: 'string', enum: VALID_DECISIONS },
            conditions: { type: 'object', additionalProperties: true },
            priority: { type: 'number' },
            isEnabled: { type: 'boolean' },
            mode: { type: 'string', enum: VALID_MODES },
            repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string', nullable: true },
              decision: { type: 'string' },
              conditions: { type: 'object', additionalProperties: true },
              priority: { type: 'number' },
              isEnabled: { type: 'boolean' },
              mode: { type: 'string', enum: VALID_MODES },
              modeChangedAt: { type: 'string', nullable: true },
              ...scopeSchemaProps,
              recheck: { type: 'boolean' },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const policy = await fastify.db.getRepository(Policy).findOne({ where: { id } });
      if (!policy) return reply.status(404).send({ error: 'Policy not found' });
      const { name, description, decision, priority, isEnabled, mode } = request.body;
      const conditions = withCvssMin(request.body.conditions);
      let conditionsError = conditions !== undefined ? policyConditionsError(conditions) : null;
      if (!conditionsError && (decision != null || conditions !== undefined)) {
        conditionsError = ruleDecisionError(
          decision ?? policy.decision,
          (conditions ?? policy.conditions) as PolicyConditions
        );
      }
      const previousMode: PolicyMode = policy.mode ?? 'enforce';
      const nextMode: PolicyMode = mode ?? previousMode;
      conditionsError ??= modeError(decision ?? policy.decision, nextMode);
      if (conditionsError) return reply.status(400).send({ error: conditionsError });
      const parsedScope = parseScopeIds(request.body.repositoryIds);
      if (parsedScope.error) return reply.status(400).send({ error: parsedScope.error });
      const nextEcosystems = policyEcosystems(conditions ?? policy.conditions);
      if (conditions !== undefined) {
        const remotesError = await allowedRemotesError(fastify.db, conditions.allowedRemotes, nextEcosystems[0]);
        if (remotesError) return reply.status(400).send({ error: remotesError });
      }
      const previousRefs = await loadRepositoryRefs(fastify.db, policy.repositoryIds ?? []);
      let nextRefs = previousRefs;
      if (parsedScope.ids !== undefined) {
        const scope = await validateRepositoryScope(fastify.db, parsedScope.ids, nextEcosystems);
        if ('error' in scope) return reply.status(400).send({ error: scope.error });
        nextRefs = scope.refs;
      } else if (conditions !== undefined && nextEcosystems.length > 0) {
        // A new ecosystem must still hold every repository the policy is scoped to.
        const stranded = previousRefs.find((ref) => !nextEcosystems.includes(ref.ecosystem));
        if (stranded) {
          return reply.status(400).send({
            error: `Repository ${stranded.ecosystem}/${stranded.key} is not in this policy's ecosystem (${nextEcosystems.join(', ')}). Remove it or change the ecosystem`,
          });
        }
      }
      const previousScope = describeScope(previousRefs);
      const nextScope = describeScope(nextRefs);
      const ruleChanged =
        conditions !== undefined &&
        ruleSignature(conditions as Record<string, unknown>) !== ruleSignature(withCvssMin(policy.conditions as PolicyConditions));
      const modeChanged = nextMode !== previousMode;
      if (name != null) policy.name = name;
      if (description !== undefined) policy.description = description;
      if (decision != null) policy.decision = decision;
      if (conditions !== undefined) policy.conditions = canonicalScorecardChecks(conditions);
      if (priority !== undefined) policy.priority = priority;
      if (isEnabled !== undefined) policy.isEnabled = isEnabled;
      if (parsedScope.ids !== undefined) policy.repositoryIds = parsedScope.ids;
      if (modeChanged) {
        policy.mode = nextMode;
        policy.modeChangedAt = new Date();
      }
      await fastify.db.transaction(async (manager) => {
        // Monitoring again starts empty; an enforced policy's rows stay read-only for 30 days.
        if (modeChanged && nextMode === 'monitor') await clearMonitorHits(manager, policy.id);
        await manager.getRepository(Policy).save(policy);
      });
      const recheck = !modeChanged && nextMode === 'monitor' && ruleChanged;
      if (modeChanged) stopRecheck(policy.id);
      if (recheck) {
        void startRecheck({ db: fastify.db, redis: fastify.redis, log: fastify.log }, policy);
      }
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'policy',
        packageName: policy.name,
        decision: 'POLICY_UPDATED',
        policyId: policy.id,
        policyName: policy.name,
        conditionReasons: (() => {
          const notes = [
            ...(modeChanged ? [`Mode changed from ${MODE_LABELS[previousMode]} to ${MODE_LABELS[nextMode]}`] : []),
            ...(previousScope !== nextScope ? [`Scope changed from ${previousScope} to ${nextScope}`] : []),
          ];
          return notes.length ? notes : null;
        })(),
      });
      const view = await viewOf(fastify.db, policy);
      return reply.send({
        id: view.id,
        name: view.name,
        description: view.description,
        decision: view.decision,
        conditions: view.conditions,
        priority: view.priority,
        isEnabled: view.isEnabled,
        mode: view.mode,
        modeChangedAt: view.modeChangedAt,
        repositoryIds: view.repositoryIds,
        repositories: view.repositories,
        recheck,
      });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/policies/:id',
    {
      onRequest: [requireWrite],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: {
          204: { type: 'null' },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const policy = await fastify.db.getRepository(Policy).findOne({ where: { id } });
      if (!policy) return reply.status(404).send({ error: 'Policy not found' });
      stopRecheck(policy.id);
      // Its approvals go with it, each audited. Monitor rows go through the foreign key.
      const scoped = await fastify.db.transaction(async (manager) => {
        const approvals = await manager.getRepository(Exception).find({ where: { policyId: policy.id } });
        if (approvals.length) await manager.getRepository(Exception).delete({ policyId: policy.id });
        await manager.getRepository(Policy).remove(policy);
        return approvals;
      });
      const { reqIp, userAgent, requester } = getRequestContext(request);
      for (const exception of scoped) {
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester,
          ecosystem: exception.ecosystem,
          packageName: `${exception.packageName}@${exception.version}`,
          resolvedVersion: exception.version,
          decision: 'EXCEPTION_REVOKED',
          policyId: id,
          policyName: policy.name,
          conditionReasons: ['Policy deleted'],
        });
      }
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'policy',
        packageName: policy.name,
        decision: 'POLICY_DELETED',
        policyId: policy.id,
        policyName: policy.name,
      });
      return reply.status(204).send();
    }
  );

  const simulationResponseSchema = {
    type: 'object',
    properties: {
      simulatedAction: { type: 'string', nullable: true },
      summary: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          changed: { type: 'number' },
          newlyBlocked: { type: 'number' },
          newlyAllowed: { type: 'number' },
          outOfScope: { type: 'number' },
        },
      },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string' },
            name: { type: 'string' },
            version: { type: 'string' },
            baselineDecision: { type: 'string', nullable: true },
            simulatedDecision: { type: 'string', nullable: true },
            changed: { type: 'boolean' },
            matchedPolicyId: { type: 'string', nullable: true },
            matchedPolicyName: { type: 'string', nullable: true },
            reasons: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      /** Internal namespace policies: matching downloads grouped by the remote that served them. */
      namespace: { type: 'object', nullable: true, additionalProperties: true },
    },
  };

  /**
   * POST /api/admin/policies/simulate
   * Simulate a candidate (new or hypothetical) policy against a set of packages.
   * If no packages are provided, recent audit-log traffic is used automatically.
   */
  fastify.post<{
    Body: {
      policy: CandidatePolicyDef;
      packages?: SimulationPackageInput[];
      useRecentAuditLog?: boolean;
      auditLogLimit?: number;
    };
  }>(
    '/api/admin/policies/simulate',
    {
      onRequest: [fastify.authenticate({ roles: ['Security'] })],
      schema: {
        tags: ['Policies'],
        body: {
          type: 'object',
          required: ['policy'],
          properties: {
            policy: {
              type: 'object',
              required: ['name', 'decision', 'conditions', 'priority'],
              properties: {
                name: { type: 'string' },
                decision: { type: 'string', enum: VALID_DECISIONS },
                conditions: { type: 'object', additionalProperties: true },
                priority: { type: 'number' },
                repositoryIds: { type: 'array', items: { type: 'string' }, nullable: true },
              },
            },
            packages: {
              type: 'array',
              maxItems: AUDIT_LOG_LIMIT_MAX,
              items: {
                type: 'object',
                required: ['ecosystem', 'name', 'version'],
                properties: {
                  ecosystem: { type: 'string' },
                  name: { type: 'string' },
                  version: { type: 'string' },
                  repository: { type: 'string' },
                },
              },
            },
            useRecentAuditLog: { type: 'boolean' },
            auditLogLimit: { type: 'number' },
          },
        },
        response: { 200: simulationResponseSchema },
      },
    },
    async (request, reply) => {
      const { policy: candidate, packages, useRecentAuditLog, auditLogLimit } = request.body;
      const candidateScope = parseScopeIds(candidate.repositoryIds);
      if (candidateScope.error) return reply.status(400).send({ error: candidateScope.error });
      candidate.repositoryIds = candidateScope.ids ?? [];
      if (candidate.conditions?.reservedNamespaces?.length) {
        const error = policyConditionsError(candidate.conditions);
        if (error) return reply.status(400).send({ error });
        const limit = Math.min(Math.max(auditLogLimit ?? AUDIT_LOG_LIMIT_DEFAULT, 1), AUDIT_LOG_LIMIT_MAX);
        return reply.send(await simulateNamespacePolicy(fastify.db, candidate.conditions, limit, candidate.name));
      }

      let pkgs: SimulationPackageInput[];
      if (packages && packages.length > 0) {
        pkgs = packages.slice(0, AUDIT_LOG_LIMIT_MAX);
      } else if (useRecentAuditLog !== false) {
        const limit = Math.min(
          Math.max(auditLogLimit ?? AUDIT_LOG_LIMIT_DEFAULT, 1),
          AUDIT_LOG_LIMIT_MAX
        );
        pkgs = await fetchRecentAuditPackages(fastify.db, limit);
      } else {
        pkgs = [];
      }

      if (pkgs.length === 0) {
        return reply.send({
          summary: { total: 0, changed: 0, newlyBlocked: 0, newlyAllowed: 0, outOfScope: 0 },
          entries: [],
        });
      }

      const report = await simulatePolicy(fastify.db, fastify.redis, candidate, pkgs);
      return reply.send(report);
    }
  );

  /**
   * POST /api/admin/policies/:id/simulate
   * Simulate toggling an existing policy's enabled state and show the diff.
   * If enabled  → shows impact of disabling it.
   * If disabled → shows impact of enabling it.
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      packages?: SimulationPackageInput[];
      useRecentAuditLog?: boolean;
      auditLogLimit?: number;
    };
  }>(
    '/api/admin/policies/:id/simulate',
    {
      onRequest: [fastify.authenticate({ roles: ['Security'] })],
      schema: {
        tags: ['Policies'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            packages: {
              type: 'array',
              maxItems: AUDIT_LOG_LIMIT_MAX,
              items: {
                type: 'object',
                required: ['ecosystem', 'name', 'version'],
                properties: {
                  ecosystem: { type: 'string' },
                  name: { type: 'string' },
                  version: { type: 'string' },
                  repository: { type: 'string' },
                },
              },
            },
            useRecentAuditLog: { type: 'boolean' },
            auditLogLimit: { type: 'number' },
          },
        },
        response: {
          200: simulationResponseSchema,
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const policy = await fastify.db.getRepository(Policy).findOne({ where: { id } });
      if (!policy) return reply.status(404).send({ error: 'Policy not found' });

      const { packages, useRecentAuditLog, auditLogLimit } = request.body ?? {};
      const policyConditions = (policy.conditions ?? {}) as PolicyConditions;
      if (policyConditions.reservedNamespaces?.length) {
        const limit = Math.min(Math.max(auditLogLimit ?? AUDIT_LOG_LIMIT_DEFAULT, 1), AUDIT_LOG_LIMIT_MAX);
        const report = await simulateNamespacePolicy(fastify.db, policyConditions, limit, policy.name);
        return reply.send({ simulatedAction: policy.isEnabled ? 'disable' : 'enable', ...report });
      }

      let pkgs: SimulationPackageInput[];
      if (packages && packages.length > 0) {
        pkgs = packages.slice(0, AUDIT_LOG_LIMIT_MAX);
      } else if (useRecentAuditLog !== false) {
        const limit = Math.min(
          Math.max(auditLogLimit ?? AUDIT_LOG_LIMIT_DEFAULT, 1),
          AUDIT_LOG_LIMIT_MAX
        );
        pkgs = await fetchRecentAuditPackages(fastify.db, limit);
      } else {
        pkgs = [];
      }

      if (pkgs.length === 0) {
        return reply.send({
          simulatedAction: policy.isEnabled ? 'disable' : 'enable',
          summary: { total: 0, changed: 0, newlyBlocked: 0, newlyAllowed: 0, outOfScope: 0 },
          entries: [],
        });
      }

      const report = await simulatePolicyToggle(fastify.db, fastify.redis, policy, pkgs);
      return reply.send(report);
    }
  );
};

export default fp(policiesRoutes);
