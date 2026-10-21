import type { EventActor } from '../request-context.js';
import type { EventTarget } from './envelope.js';
import type { RecordInput } from './record.js';
import { PACKAGE_ECOSYSTEMS } from './record.js';

/**
 * Today's `audit_logs` shape mapped onto the event format (requirements_event_streaming.md §6.2 renames and
 * Appendix A). Used by the `logAudit` adapter, so admin routes keep their call sites, and by the
 * copy of older rows, so live and copied rows map the same way.
 */

export type LegacyRow = {
  id?: string;
  createdAt?: Date;
  requesterIp?: string | null;
  userAgent?: string | null;
  requester?: string | null;
  ecosystem: string;
  packageName: string;
  resolvedVersion?: string | null;
  repository?: string | null;
  decision: string;
  policyId?: string | null;
  policyName?: string | null;
  conditionReasons?: string[] | null;
  metadata?: Record<string, string> | null;
};

/** Feed sync rows: not migrated, no longer written (D3). Jobs & Feeds shows the runs. */
export const SYNC_TYPES = new Set(['MALICIOUS_SYNC', 'MALICIOUS_SYNC_FAILED', 'EPSS_SYNC', 'EPSS_SYNC_FAILED']);

/** The renames of §6.2 that do not depend on the row. */
const RENAMES: Record<string, string> = {
  BLOCK: 'BLOCK_ENFORCE',
  LOGIN_SUCCEEDED: 'SIGNIN_SUCCEEDED',
  LOGIN_FAILED: 'SIGNIN_FAILED',
  MALICIOUS_ADDED: 'MALWARE_ADDED',
  MALICIOUS_UPDATED: 'MALWARE_UPDATED',
  MALICIOUS_DELETED: 'MALWARE_DELETED',
  MALICIOUS_OVERRIDE_ALLOW: 'MALWARE_OVERRIDE_ALLOW',
  MALICIOUS_OVERRIDE_BLOCK: 'MALWARE_OVERRIDE_BLOCK',
  MALICIOUS_OVERRIDE_TO_CUSTOM: 'MALWARE_OVERRIDE_TO_CUSTOM',
  // Written by releases before 2026-10-09 (quarantine removed) and by an early config import.
  config_import: 'CONFIG_IMPORTED',
};

/** The old name of a renamed type, for the `/api/admin/audit-logs` alias (§11). */
export function legacyTypeName(type: string): string {
  for (const [old, current] of Object.entries(RENAMES)) if (current === type) return old;
  return type;
}

/** The new type of an old row, or null for rows that are not carried over. */
export function mapLegacyType(row: Pick<LegacyRow, 'decision' | 'packageName' | 'conditionReasons'>): string | null {
  if (SYNC_TYPES.has(row.decision)) return null;
  if (row.decision === 'CONFIG_UPDATED') {
    const reason = row.conditionReasons?.[0] ?? '';
    if (row.packageName.startsWith('jobs/')) {
      if (/^Retried job/i.test(reason)) return 'JOB_RETRIED';
      if (/^Discarded/i.test(reason)) return 'JOB_DISCARDED';
      return 'JOB_RUN_REQUESTED';
    }
    if (row.packageName === 'namespace-collisions') return 'JOB_RUN_REQUESTED';
    if (/^namespaceCollisionCheck\b/.test(reason)) return 'NAMESPACE_SETTINGS_UPDATED';
    return 'CONFIG_UPDATED';
  }
  return RENAMES[row.decision] ?? row.decision;
}

/**
 * Decision types of old rows. QUARANTINE (a download held for review, removed 2026-10-09) and
 * INTEGRITY_VIOLATION (artifact integrity checks, removed 2026-10-18) are kept as history, not counted.
 */
const DECISION_TYPES = new Set(['ALLOW', 'BLOCK_ENFORCE', 'UPSTREAM_UNAVAILABLE', 'INTEGRITY_VIOLATION', 'QUARANTINE']);

export function isDecisionType(type: string): boolean {
  return DECISION_TYPES.has(type);
}

const ACTOR_KEYS = new Set(['authMethod']);
const SOURCE_KEYS = new Set(['sourceRepository', 'sourceType']);

/**
 * Splits today's `metadata`: authMethod becomes the actor's, the serving remote goes to `details.source`,
 * and every other key is the token's metadata (decision rows) or DepGate's detail (admin rows).
 */
export function splitMetadata(metadata: Record<string, string> | null | undefined): {
  authMethod: string | null;
  source: { repository: string; type?: string } | null;
  rest: Record<string, string>;
} {
  const rest: Record<string, string> = {};
  let authMethod: string | null = null;
  let source: { repository: string; type?: string } | null = null;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (ACTOR_KEYS.has(key)) authMethod = value;
    else if (!SOURCE_KEYS.has(key)) rest[key] = value;
  }
  if (metadata?.sourceRepository) {
    source = { repository: metadata.sourceRepository, ...(metadata.sourceType ? { type: metadata.sourceType } : {}) };
  }
  return { authMethod, source, rest };
}

/** The target of an admin row (Appendix A). */
export function legacyTarget(row: LegacyRow, type: string): EventTarget {
  const name = row.packageName || null;
  switch (row.ecosystem) {
    case 'auth':
    case 'user':
      return { kind: 'user', name };
    case 'policy':
      return { kind: 'policy', id: row.policyId ?? null, name };
    case 'sso':
      return type === 'SIGNIN_SETTINGS_UPDATED' ? { kind: 'setting', name: name ?? 'signin' } : { kind: 'sso_provider', name };
    case 'ci_token':
    case 'service_account':
    case 'api_key':
    case 'webhook':
    case 'stream_destination':
      return { kind: row.ecosystem, name };
    case 'settings':
      return { kind: 'setting', name: 'mail' };
    case 'config_import':
      return { kind: 'setting', name: name ?? 'config' };
    case 'config':
      if (type.startsWith('JOB_')) {
        const job = row.packageName === 'namespace-collisions' ? 'namespace-collision-check' : row.packageName.replace(/^jobs\//, '');
        return { kind: 'job', name: job };
      }
      if (type === 'NAMESPACE_SETTINGS_UPDATED') return { kind: 'setting', name: 'namespace' };
      return { kind: 'setting', name, ...(row.resolvedVersion ? { version: row.resolvedVersion } : {}) };
    default:
      break;
  }
  const ecosystem = PACKAGE_ECOSYSTEMS.has(row.ecosystem) ? row.ecosystem : null;
  const pkg = { ecosystem, name, version: row.resolvedVersion ?? null, repository: row.repository ?? null };
  if (type.startsWith('REPOSITORY_')) return { kind: 'repository', name, ecosystem };
  if (type.startsWith('UPSTREAM_REGISTRY_')) return { kind: 'upstream_registry', name, ecosystem };
  if (type.startsWith('EXCEPTION_')) return { kind: 'exception', ...pkg };
  if (type.startsWith('WAIVER_')) return { kind: 'waiver', ...pkg };
  if (type.startsWith('MALWARE_')) return { kind: 'malware_entry', ...pkg };
  if (type.startsWith('QUARANTINE_')) return { kind: 'package', ...pkg };
  return { kind: ecosystem ? 'package' : row.ecosystem || 'setting', ...pkg };
}

/** The actor of an old row: requester, IP and user agent, plus how it authenticated. */
export function legacyActor(row: LegacyRow, type: string, authMethod: string | null, base?: EventActor): EventActor {
  const signin = type === 'SIGNIN_SUCCEEDED' || type === 'SIGNIN_FAILED';
  const method = authMethod ?? (signin ? (row.metadata?.method ?? null) : null);
  const name = row.requester ?? base?.name ?? null;
  let kind: EventActor['kind'] = base?.kind ?? (name ? 'user' : 'system');
  if (name === 'DepGate') kind = 'system';
  else if (type === 'SIGNIN_FAILED') kind = 'anonymous';
  else if (type === 'SIGNIN_SUCCEEDED' || (name && kind === 'anonymous')) kind = 'user';
  if (method === 'ci_token') kind = 'ci_token';
  if (method === 'api_key') kind = 'api_key';
  const actor: EventActor = {
    kind,
    id: base?.name && base.name === name ? (base.id ?? null) : null,
    name,
    ip: row.requesterIp ?? base?.ip ?? null,
    userAgent: row.userAgent ?? base?.userAgent ?? null,
    authMethod: method ?? (base?.name === name ? (base?.authMethod ?? null) : null),
    metadata: base?.name === name ? (base?.metadata ?? null) : null,
  };
  return actor;
}

/**
 * The event of an old row, or null for rows that are not carried over.
 * `base` is the actor of the request in flight (live calls), never set by the migration.
 */
export function legacyToEvent(row: LegacyRow, base?: EventActor): RecordInput | null {
  const type = mapLegacyType(row);
  if (!type) return null;
  const { authMethod, source, rest } = splitMetadata(row.metadata);
  const reasons = row.conditionReasons?.length ? row.conditionReasons : null;
  if (isDecisionType(type)) {
    const actor = legacyActor(row, type, authMethod, base);
    // A download's token metadata is the actor's; it never mixes with DepGate's own values.
    if (Object.keys(rest).length) actor.metadata = rest;
    return {
      type,
      id: row.id,
      time: row.createdAt,
      actor,
      target: {
        kind: 'package',
        ecosystem: row.ecosystem,
        name: row.packageName,
        version: row.resolvedVersion ?? null,
        repository: row.repository ?? null,
      },
      policy: row.policyId || row.policyName ? { id: row.policyId ?? null, name: row.policyName ?? null } : null,
      reasons,
      details: source ? { source } : null,
    };
  }
  const details: Record<string, unknown> = { ...rest };
  // An exception, waiver or Monitoring approval names the policy it belongs to.
  if (row.policyId && row.ecosystem !== 'policy') details.policyId = row.policyId;
  if (row.policyName && row.ecosystem !== 'policy') details.policyName = row.policyName;
  if (row.ecosystem === 'auth' || row.ecosystem === 'user') {
    if (row.resolvedVersion) details.role = row.resolvedVersion;
  }
  return {
    type,
    id: row.id,
    time: row.createdAt,
    actor: legacyActor(row, type, authMethod, base),
    target: legacyTarget(row, type),
    reasons,
    summary: reasons?.[0] ?? undefined,
    details: Object.keys(details).length ? details : null,
  };
}
