import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { Brackets, In, type SelectQueryBuilder } from 'typeorm';
import { DecisionLedgerEntry } from '../db/entities/DecisionLedgerEntry.js';
import { AuditEvent } from '../db/entities/AuditEvent.js';
import { JobRun } from '../db/entities/JobRun.js';
import { CATALOG, recommendedSelection, everythingSelection } from '../services/events/catalog.js';
import { auditEnvelope, buildLabel, jobRunEnvelope, ledgerEnvelope, legacyLedgerItem } from '../services/events/views.js';
import { upcomingPurge } from '../services/events/retention.js';
import { SCHEDULED_JOBS } from '../services/jobs/scheduled.js';
import { maskEmails } from './jobs.js';
import { WEBHOOK_EVENTS } from '../services/webhook-service.js';
import { config } from '../config.js';

/**
 * The three event pages (requirements_event_streaming.md §10.2, §11): Decision Ledger, Audit Log, Jobs & Feeds,
 * plus the catalog the destination form and the Audit Log filter share, and the old audit-logs path.
 */

type Paging = { limit?: string; offset?: string; from?: string; to?: string };

function paging(query: Paging): { limit: number; offset: number } {
  return {
    limit: Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 200),
    offset: Math.max(parseInt(query.offset ?? '0', 10) || 0, 0),
  };
}

function dateRange<T extends object>(qb: SelectQueryBuilder<T>, column: string, from?: string, to?: string): void {
  if (from && !Number.isNaN(Date.parse(from))) qb.andWhere(`${column} >= :from`, { from: new Date(from) });
  if (to && !Number.isNaN(Date.parse(to))) qb.andWhere(`${column} <= :to`, { to: new Date(to) });
}

type LedgerQuery = Paging & {
  ecosystem?: string;
  package?: string;
  decision?: string;
  repository?: string;
  policy?: string;
  actor?: string;
  authMethod?: string;
  /** `key=value` on the token metadata. */
  meta?: string;
};

function ledgerQuery(qb: SelectQueryBuilder<DecisionLedgerEntry>, query: LedgerQuery): void {
  const { ecosystem, package: pkg, decision, repository, policy, actor, authMethod, meta } = query;
  if (ecosystem) qb.andWhere('l.ecosystem = :ecosystem', { ecosystem });
  if (pkg) qb.andWhere('l.package_name ILIKE :pkg', { pkg: `%${pkg}%` });
  if (decision === 'MALWARE') qb.andWhere('l.malware = true');
  else if (decision === 'BLOCK') qb.andWhere('l.decision = :decision', { decision: 'BLOCK_ENFORCE' });
  else if (decision) qb.andWhere('l.decision = :decision', { decision });
  if (repository) qb.andWhere('l.repository = :repository', { repository });
  if (policy) {
    qb.andWhere(
      new Brackets((w) => {
        w.where('l.policy_name ILIKE :policyName', { policyName: `%${policy}%` });
        if (/^[0-9a-f-]{36}$/i.test(policy)) w.orWhere('l.policy_id = :policyId', { policyId: policy });
      })
    );
  }
  if (actor) {
    qb.andWhere(
      new Brackets((w) => {
        w.where('l.requester ILIKE :actor', { actor: `%${actor}%` }).orWhere('l.requester_ip = :actorIp', { actorIp: actor });
      })
    );
  }
  if (authMethod) qb.andWhere('l.auth_method = :authMethod', { authMethod });
  if (meta && meta.includes('=')) {
    const [key, ...rest] = meta.split('=');
    qb.andWhere(`l.actor_metadata ->> :metaKey = :metaValue`, { metaKey: key.trim(), metaValue: rest.join('=').trim() });
  }
  dateRange(qb, 'l.created_at', query.from, query.to);
}

const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: ['Security'] });

  fastify.get<{ Querystring: LedgerQuery }>(
    '/api/admin/decision-ledger',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Audit Logs'],
        summary: 'Decision Ledger: what the gateway refused, and why',
        querystring: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string' },
            package: { type: 'string' },
            decision: { type: 'string', description: 'BLOCK_ENFORCE, UPSTREAM_UNAVAILABLE, ALLOW, or MALWARE for malware-listed rows' },
            repository: { type: 'string' },
            policy: { type: 'string', description: 'Policy name (substring) or ID' },
            actor: { type: 'string', description: 'Actor name (substring) or exact IP' },
            authMethod: { type: 'string' },
            meta: { type: 'string', description: 'Token metadata key=value, e.g. buildId=8812' },
            limit: { type: 'string' },
            offset: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit, offset } = paging(request.query);
      const qb = fastify.db.getRepository(DecisionLedgerEntry).createQueryBuilder('l');
      ledgerQuery(qb, request.query);
      const [rows, total] = await qb.orderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC').skip(offset).take(limit).getManyAndCount();
      return reply.send({
        items: rows.map((row) => ({
          id: row.id,
          createdAt: new Date(row.createdAt).toISOString(),
          decision: row.decision,
          malware: row.malware,
          ecosystem: row.ecosystem,
          packageName: row.packageName,
          version: row.resolvedVersion,
          repository: row.repository,
          policyId: row.policyId,
          policyName: row.policyName,
          reasons: row.conditionReasons ?? [],
          actor: { kind: row.actorKind, name: row.requester, ip: row.requesterIp, userAgent: row.userAgent, authMethod: row.authMethod, metadata: row.actorMetadata ?? {} },
          build: buildLabel(row),
          details: row.details ?? {},
          event: ledgerEnvelope(row),
        })),
        total,
      });
    }
  );

  /** The old path, one release (§11): ledger rows in the old shape and type names. */
  fastify.get<{ Querystring: LedgerQuery & { method?: string } }>(
    '/api/admin/audit-logs',
    { onRequest: [requireSecurity], schema: { tags: ['Audit Logs'], deprecated: true, summary: 'Deprecated: use /api/admin/decision-ledger' } },
    async (request, reply) => {
      const { limit, offset } = paging(request.query);
      const qb = fastify.db.getRepository(DecisionLedgerEntry).createQueryBuilder('l');
      ledgerQuery(qb, request.query);
      const [rows, total] = await qb.orderBy('l.created_at', 'DESC').addOrderBy('l.id', 'DESC').skip(offset).take(limit).getManyAndCount();
      reply.header('Deprecation', 'true');
      reply.header('Link', '</api/admin/decision-ledger>; rel="successor-version"');
      return reply.send({ items: rows.map(legacyLedgerItem), total });
    }
  );

  fastify.get<{ Querystring: Paging & { feature?: string; type?: string; actor?: string; targetKind?: string; target?: string; authMethod?: string } }>(
    '/api/admin/audit-events',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Audit Logs'],
        summary: 'Audit Log: who changed what',
        querystring: {
          type: 'object',
          properties: {
            feature: { type: 'string', description: 'Catalog feature, e.g. policies, access, settings' },
            type: { type: 'string', description: 'Event type, e.g. POLICY_UPDATED' },
            actor: { type: 'string' },
            targetKind: { type: 'string' },
            target: { type: 'string' },
            authMethod: { type: 'string', description: 'How the actor authenticated: password, oidc, saml, api_key, ci_token' },
            limit: { type: 'string' },
            offset: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { feature, type, actor, targetKind, target, authMethod, from, to } = request.query;
      const { limit, offset } = paging(request.query);
      const qb = fastify.db.getRepository(AuditEvent).createQueryBuilder('a');
      if (feature) {
        const types = CATALOG.find((row) => row.feature === feature)
          ?.groups.flatMap((group) => group.events)
          .filter((event) => event.category === 'audit')
          .map((event) => event.type) ?? [];
        qb.andWhere('a.type IN (:...types)', { types: types.length ? types : ['-'] });
      }
      if (type) qb.andWhere('a.type = :type', { type });
      if (actor) {
        qb.andWhere(new Brackets((w) => w.where('a.actor_name ILIKE :actor', { actor: `%${actor}%` }).orWhere('a.actor_ip = :actorIp', { actorIp: actor })));
      }
      if (targetKind) qb.andWhere('a.target_kind = :targetKind', { targetKind });
      if (target) qb.andWhere('a.target_name ILIKE :target', { target: `%${target}%` });
      if (authMethod) qb.andWhere('a.actor_auth_method = :authMethod', { authMethod });
      dateRange(qb, 'a.created_at', from, to);
      const [rows, total] = await qb.orderBy('a.created_at', 'DESC').addOrderBy('a.id', 'DESC').skip(offset).take(limit).getManyAndCount();
      return reply.send({
        items: rows.map((row) => {
          const event = auditEnvelope(row);
          return {
            id: row.id,
            createdAt: new Date(row.createdAt).toISOString(),
            type: row.type,
            feature: event.feature,
            summary: row.summary,
            actor: { kind: row.actorKind, name: row.actorName, ip: row.actorIp, userAgent: row.actorUserAgent, authMethod: row.actorAuthMethod, metadata: row.actorMetadata ?? {} },
            target: { kind: row.targetKind, id: row.targetId, name: row.targetName, ecosystem: row.targetEcosystem, version: row.targetVersion, repository: row.targetRepository },
            reasons: row.reasons ?? [],
            details: row.details ?? {},
            event,
          };
        }),
        total,
      });
    }
  );

  fastify.get<{ Querystring: Paging & { job?: string; status?: string; trigger?: string } }>(
    '/api/admin/job-runs',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Jobs'],
        summary: 'Jobs & Feeds: what the background jobs did',
        querystring: {
          type: 'object',
          properties: {
            job: { type: 'string' },
            status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'skipped'] },
            trigger: { type: 'string', enum: ['scheduled', 'manual', 'startup'] },
            limit: { type: 'string' },
            offset: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { job, status, trigger, from, to } = request.query;
      const { limit, offset } = paging(request.query);
      const qb = fastify.db.getRepository(JobRun).createQueryBuilder('r');
      if (job) qb.andWhere('r.job = :job', { job });
      if (status) qb.andWhere('r.status = :status', { status });
      if (trigger) qb.andWhere('r.trigger = :trigger', { trigger });
      dateRange(qb, 'r.started_at', from, to);
      const [rows, total] = await qb.orderBy('r.started_at', 'DESC').skip(offset).take(limit).getManyAndCount();
      return reply.send({
        items: rows.map((run) => ({
          id: run.id,
          job: run.job,
          jobId: run.jobId,
          trigger: run.trigger,
          status: run.status,
          startedAt: new Date(run.startedAt).toISOString(),
          finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
          durationMs: run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null,
          result: run.result,
          error: run.error ? maskEmails(run.error) : null,
          event: jobRunEnvelope(run),
        })),
        total,
        jobs: [...SCHEDULED_JOBS],
      });
    }
  );

  fastify.get('/api/admin/events/catalog', { onRequest: [requireSecurity], schema: { tags: ['Audit Logs'], summary: 'Event catalog, grouped by feature' } }, async (_request, reply) => {
    return reply.send({
      features: CATALOG,
      presets: { recommended: recommendedSelection(), everything: everythingSelection() },
      webhookEvents: WEBHOOK_EVENTS,
    });
  });

  /** Banner on the Decision Ledger and Audit Log pages: what the first retention purge will delete (§5.4). */
  fastify.get('/api/admin/events/status', { onRequest: [requireSecurity], schema: { tags: ['Audit Logs'] } }, async (_request, reply) => {
    const purge = await upcomingPurge(fastify.db).catch(() => null);
    return reply.send({
      migration: null,
      purge,
      retention: { ledgerDays: config.events.ledgerRetentionDays, auditDays: config.events.auditRetentionDays },
    });
  });

  /** Ledger rows and audit events by ID, for links from elsewhere (webhook deliveries, SIEM). */
  fastify.get<{ Params: { id: string } }>('/api/admin/events/:id', { onRequest: [requireSecurity], schema: { tags: ['Audit Logs'] } }, async (request, reply) => {
    const id = request.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.status(404).send({ error: 'Event not found' });
    const ledger = await fastify.db.getRepository(DecisionLedgerEntry).findOne({ where: { id } });
    if (ledger) return reply.send(ledgerEnvelope(ledger));
    const audit = await fastify.db.getRepository(AuditEvent).findOne({ where: { id } });
    if (audit) return reply.send(auditEnvelope(audit));
    const runs = await fastify.db.getRepository(JobRun).find({ where: { id: In([id]) } });
    const event = runs[0] ? jobRunEnvelope(runs[0]) : null;
    return event ? reply.send(event) : reply.status(404).send({ error: 'Event not found' });
  });
};

export default fp(eventsRoutes);
