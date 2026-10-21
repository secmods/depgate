import type { DecisionLedgerEntry } from '../../db/entities/DecisionLedgerEntry.js';
import type { AuditEvent } from '../../db/entities/AuditEvent.js';
import type { JobRun } from '../../db/entities/JobRun.js';
import type { EventActor } from '../request-context.js';
import { buildEnvelope, type EventEnvelope } from './envelope.js';
import { legacyTypeName } from './legacy.js';

/**
 * Stored rows back into the event format (requirements_event_streaming.md §6.1), so "Copy as JSON" on any of
 * the three pages copies what a SIEM receives.
 */

function actorOf(row: {
  kind: string | null;
  id: string | null;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  authMethod: string | null;
  metadata: Record<string, string> | null;
}): EventActor {
  return {
    kind: (row.kind as EventActor['kind']) ?? (row.name ? 'user' : 'system'),
    id: row.id,
    name: row.name,
    ip: row.ip,
    userAgent: row.userAgent,
    authMethod: row.authMethod,
    metadata: row.metadata,
  };
}

export function ledgerEnvelope(row: DecisionLedgerEntry): EventEnvelope {
  return buildEnvelope({
    id: row.id,
    time: new Date(row.createdAt),
    type: row.decision,
    actor: actorOf({
      kind: row.actorKind,
      id: row.actorId,
      name: row.requester,
      ip: row.requesterIp,
      userAgent: row.userAgent,
      authMethod: row.authMethod,
      metadata: row.actorMetadata,
    }),
    target: { kind: 'package', ecosystem: row.ecosystem, name: row.packageName, version: row.resolvedVersion, repository: row.repository },
    policy: row.policyId || row.policyName ? { id: row.policyId, name: row.policyName } : null,
    reasons: row.conditionReasons,
    details: row.details,
  });
}

export function auditEnvelope(row: AuditEvent): EventEnvelope {
  return buildEnvelope({
    id: row.id,
    time: new Date(row.createdAt),
    type: row.type,
    summary: row.summary ?? undefined,
    actor: actorOf({
      kind: row.actorKind,
      id: row.actorId,
      name: row.actorName,
      ip: row.actorIp,
      userAgent: row.actorUserAgent,
      authMethod: row.actorAuthMethod,
      metadata: row.actorMetadata,
    }),
    target: row.targetKind
      ? {
          kind: row.targetKind,
          id: row.targetId,
          name: row.targetName,
          ecosystem: row.targetEcosystem,
          version: row.targetVersion,
          repository: row.targetRepository,
        }
      : undefined,
    reasons: row.reasons,
    details: row.details,
  });
}

export function jobRunEnvelope(run: JobRun): EventEnvelope | null {
  if (run.status === 'running') return null;
  const type = run.status === 'failed' ? 'JOB_FAILED' : run.status === 'skipped' ? 'JOB_SKIPPED' : 'JOB_SUCCEEDED';
  const durationMs = run.finishedAt ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime() : null;
  return buildEnvelope({
    type,
    job: run.job,
    time: run.finishedAt ? new Date(run.finishedAt) : new Date(run.startedAt),
    actor: { kind: 'system', name: 'DepGate' },
    target: { kind: 'job', name: run.job },
    reasons: run.error ? [run.error] : null,
    details: {
      runId: run.id,
      jobId: run.jobId,
      trigger: run.trigger,
      ...(durationMs !== null ? { durationMs } : {}),
      ...(run.result ? { result: run.result } : {}),
      ...(run.error ? { error: run.error } : {}),
    },
  });
}

/** The old `/api/admin/audit-logs` shape, kept one release (§11): old type names and one `metadata` map. */
export function legacyLedgerItem(row: DecisionLedgerEntry): Record<string, unknown> {
  const source = row.details?.source as { repository?: string; type?: string } | undefined;
  const metadata: Record<string, string> = { ...(row.actorMetadata ?? {}) };
  if (source?.repository) metadata.sourceRepository = source.repository;
  if (source?.type) metadata.sourceType = source.type;
  if (row.authMethod && row.actorKind === 'user') metadata.authMethod = row.authMethod;
  return {
    id: row.id,
    requesterIp: row.requesterIp,
    requester: row.requester,
    userAgent: row.userAgent,
    ecosystem: row.ecosystem,
    packageName: row.packageName,
    resolvedVersion: row.resolvedVersion,
    repository: row.repository,
    decision: legacyTypeName(row.decision),
    policyId: row.policyId,
    policyName: row.policyName,
    conditionReasons: row.conditionReasons,
    metadata: Object.keys(metadata).length ? metadata : null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

/** The Build column (§10.2): the first of buildId, build, pipeline, runId, else the CI token's name. */
export function buildLabel(row: Pick<DecisionLedgerEntry, 'actorMetadata' | 'actorKind' | 'requester'>): string | null {
  const meta = row.actorMetadata ?? {};
  for (const key of ['buildId', 'build', 'pipeline', 'runId']) if (meta[key]) return meta[key];
  return row.actorKind === 'ci_token' ? row.requester : null;
}
