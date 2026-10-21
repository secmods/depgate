import type { DataSource } from 'typeorm';
import { AuditEvent } from '../db/entities/AuditEvent.js';
import { DecisionLedgerEntry } from '../db/entities/DecisionLedgerEntry.js';
import { bindPublisher, currentPublisher } from '../services/events/record.js';
import type { EventEnvelope } from '../services/events/envelope.js';

/** Integration-test reads of the event tables (requirements_event_streaming.md §5.1). */

export async function poll<T>(read: () => Promise<T | null | undefined>, what: string, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0)) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type AuditWhere = {
  type: string;
  targetName?: string;
  targetId?: string;
  targetKind?: string;
  targetEcosystem?: string;
  /** `details.policyId` of an exception, waiver or approval. */
  policyId?: string;
};

export async function auditRows(db: DataSource, where: AuditWhere, take = 20): Promise<AuditEvent[]> {
  const qb = db.getRepository(AuditEvent).createQueryBuilder('a').where('a.type = :type', { type: where.type });
  if (where.targetName !== undefined) qb.andWhere('a.target_name = :targetName', { targetName: where.targetName });
  if (where.targetId !== undefined) qb.andWhere('a.target_id = :targetId', { targetId: where.targetId });
  if (where.targetKind !== undefined) qb.andWhere('a.target_kind = :targetKind', { targetKind: where.targetKind });
  if (where.targetEcosystem !== undefined) qb.andWhere('a.target_ecosystem = :targetEcosystem', { targetEcosystem: where.targetEcosystem });
  if (where.policyId !== undefined) qb.andWhere(`a.details ->> 'policyId' = :policyId`, { policyId: where.policyId });
  return qb.orderBy('a.created_at', 'DESC').take(take).getMany();
}

export async function ledgerRows(
  db: DataSource,
  where: { decision?: string; ecosystem?: string; packageName?: string; policyId?: string; version?: string; repository?: string },
  take = 20
): Promise<DecisionLedgerEntry[]> {
  const qb = db.getRepository(DecisionLedgerEntry).createQueryBuilder('l').where('1 = 1');
  if (where.decision) qb.andWhere('l.decision = :decision', { decision: where.decision });
  if (where.ecosystem) qb.andWhere('l.ecosystem = :ecosystem', { ecosystem: where.ecosystem });
  if (where.packageName) qb.andWhere('l.package_name = :packageName', { packageName: where.packageName });
  if (where.policyId) qb.andWhere('l.policy_id = :policyId', { policyId: where.policyId });
  if (where.version) qb.andWhere('l.resolved_version = :version', { version: where.version });
  if (where.repository) qb.andWhere('l.repository = :repository', { repository: where.repository });
  return qb.orderBy('l.created_at', 'DESC').take(take).getMany();
}

/**
 * Every event published while it runs, passed on to the app's own publisher. For allowed downloads, which
 * are counted and streamed but never stored row by row (D1).
 */
export function capturePublished(): { events: EventEnvelope[]; stop: () => void } {
  const events: EventEnvelope[] = [];
  const previous = currentPublisher();
  bindPublisher((envelope, json, webhookPayload) => {
    events.push(envelope);
    previous?.(envelope, json, webhookPayload);
  });
  return { events, stop: () => bindPublisher(previous) };
}

/**
 * Audit Log rows of a type for one target name, newest first, waiting until `until` holds (they are written
 * after the response). Old type names (LOGIN_*, MALICIOUS_*) are accepted and renamed (§6.2).
 */
export async function auditFor(
  db: DataSource,
  type: string,
  targetName: string,
  until: (rows: AuditEvent[]) => boolean = (rows) => rows.length > 0,
  ms = 4_000
): Promise<AuditEvent[]> {
  const renamed = type.replace(/^LOGIN_/, 'SIGNIN_').replace(/^MALICIOUS_/, 'MALWARE_');
  const end = Date.now() + ms;
  for (;;) {
    const rows = await auditRows(db, { type: renamed, targetName }, 50);
    if (until(rows) || Date.now() > end) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
