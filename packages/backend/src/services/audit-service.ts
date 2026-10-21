import type { FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';
import { currentActor, currentRepository, currentServedSource } from './request-context.js';
import { legacyToEvent } from './events/legacy.js';
import { recordEvent } from './events/record.js';

/**
 * The old ledger entry shape. Admin routes still describe their events this way; `logAudit` maps each
 * one onto the event format (requirements_event_streaming.md Appendix A) and hands it to `recordEvent`,
 * which writes the Audit Log or the Decision Ledger and publishes it.
 */
export type AuditLogEntry = {
  requesterIp?: string | null;
  userAgent?: string | null;
  requester?: string | null;
  ecosystem: string;
  packageName: string;
  resolvedVersion?: string | null;
  decision: string;
  policyId?: string | null;
  policyName?: string | null;
  conditionReasons?: string[] | null;
  metadata?: Record<string, string> | null;
  /** Defaults to the repository of the request being served. */
  repository?: string | null;
};

export function getRequestContext(req: FastifyRequest): { reqIp: string | null; userAgent: string | null; requester: string | null } {
  const reqIp = (req.ip ?? req.headers['x-forwarded-for'] ?? req.headers['x-real-ip']) as string | undefined;
  const userAgent = (req.headers['user-agent'] as string) ?? null;
  const user = req.user as { username?: string; name?: string } | undefined;
  const requester = user?.username || user?.name || null;
  return { reqIp: reqIp ?? null, userAgent, requester };
}

/** AUDIT_LOG_ALLOWS was removed (D9): allowed downloads are counted, and streamed when a destination asks. */
export function warnRemovedSettings(log: { warn: (msg: string) => void }): void {
  if ((process.env.AUDIT_LOG_ALLOWS ?? '').trim()) {
    log.warn(
      'AUDIT_LOG_ALLOWS is no longer used: allowed downloads are counted for the dashboard and simulations, and can be sent to a SIEM with Log Streaming (Settings → Log streaming)'
    );
  }
}

/** Ledger fields of an allowed download: the Allow policy that decided it, or none when no policy matched. */
export function allowedByFields(
  result: { decision: string; policyId: string; policyName: string; reasons: string[] } | null | undefined
): Pick<AuditLogEntry, 'policyId' | 'policyName' | 'conditionReasons'> {
  if (result?.decision !== 'ALLOW') return { policyId: null, policyName: null, conditionReasons: null };
  return { policyId: result.policyId, policyName: result.policyName, conditionReasons: result.reasons };
}

/**
 * Records an event described in the old shape. Never throws and never waits for the database; the returned
 * promise is kept so existing `await logAudit(...)` and `.catch()` call sites still work.
 */
export function logAudit(db: DataSource, entry: AuditLogEntry): Promise<void> {
  // Read before the first await: the request context is only guaranteed on the calling tick.
  const repository = entry.repository !== undefined ? entry.repository : (currentRepository() ?? null);
  const served = entry.resolvedVersion ? currentServedSource() : undefined;
  const metadata = served ? { ...(entry.metadata ?? {}), ...served } : entry.metadata;
  const event = legacyToEvent({ ...entry, repository, metadata }, currentActor());
  if (event) recordEvent(db, event);
  return Promise.resolve();
}
