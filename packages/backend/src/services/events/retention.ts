import type { DataSource } from 'typeorm';
import { config } from '../../config.js';
import { COLLISION_LOOKBACK_DAYS } from '../namespace-collisions.js';
import { readMigrationState } from './migration.js';

/**
 * The `event-retention-purge` job (requirements_event_streaming.md §5.4), hourly. Deletes in batches of 5,000
 * by age under an advisory lock, like the Monitor purge.
 *
 * Nothing was ever deleted before this release, so the Decision Ledger and Audit Log are not purged until
 * 7 days after the event migration finished; the pages and the startup log say what will go, and when.
 */

const BATCH = 5_000;
const LOCK_KEY = 74_201_542;
const DAY_MS = 86_400_000;
export const PURGE_GRACE_DAYS = 7;

const FIXED_RETENTION = {
  decisionCountsDays: 400,
  packageCountsDays: 31,
  summaryFlushesDays: 3,
};

/** When the ledger and audit purge may start: 7 days after the copy finished. Null while it runs. */
export async function purgeStartsAt(db: DataSource): Promise<Date | null> {
  const state = await readMigrationState(db);
  if (!state?.finishedAt) return null;
  return new Date(state.finishedAt.getTime() + PURGE_GRACE_DAYS * DAY_MS);
}

export type PurgeNotice = {
  /** When the first purge runs. */
  date: string;
  ledger: { retentionDays: number; entries: number } | null;
  audit: { retentionDays: number; entries: number } | null;
};

/**
 * What the first purge after the upgrade will delete, for the banner and the startup warning.
 * Null once the grace period is over, or when both retentions are 0.
 */
export async function upcomingPurge(db: DataSource, now = new Date()): Promise<PurgeNotice | null> {
  const { ledgerRetentionDays, auditRetentionDays } = config.events;
  if (ledgerRetentionDays === 0 && auditRetentionDays === 0) return null;
  const state = await readMigrationState(db);
  // While the copy runs, the purge waits at least until 7 days after it finishes.
  const date = state?.finishedAt ? new Date(state.finishedAt.getTime() + PURGE_GRACE_DAYS * DAY_MS) : new Date(now.getTime() + PURGE_GRACE_DAYS * DAY_MS);
  if (date.getTime() <= now.getTime()) return null;
  const count = async (table: string, days: number) => {
    const cutoff = new Date(date.getTime() - days * DAY_MS);
    const [row]: Array<{ n: string }> = await db.query(`SELECT count(*) AS n FROM ${table} WHERE created_at < $1`, [cutoff]);
    return Number(row?.n ?? 0);
  };
  const ledger = ledgerRetentionDays > 0 ? { retentionDays: ledgerRetentionDays, entries: await count('decision_ledger', ledgerRetentionDays) } : null;
  const audit = auditRetentionDays > 0 ? { retentionDays: auditRetentionDays, entries: await count('audit_events', auditRetentionDays) } : null;
  if (!ledger?.entries && !audit?.entries) return null;
  return { date: date.toISOString(), ledger, audit };
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

function affected(raw: unknown): number {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === 'number') return raw[1];
  return 0;
}

async function deleteInBatches(runner: Runner, table: string, column: string, cutoff: Date): Promise<number> {
  let total = 0;
  // `ctid` works for every table here, including the summary tables without an id.
  for (;;) {
    const deleted = affected(
      await runner.query(
        `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT ${BATCH})`,
        [cutoff]
      )
    );
    total += deleted;
    if (deleted < BATCH) return total;
  }
}

export type EventPurgeResult = {
  ledger: number | 'grace' | 'kept';
  audit: number | 'grace' | 'kept';
  decisionCounts: number;
  packageCounts: number;
  packageUsage: number;
  summaryFlushes: number;
};

export async function purgeEvents(db: DataSource, now = new Date()): Promise<EventPurgeResult | { skipped: string }> {
  const runner = db.createQueryRunner();
  await runner.connect();
  try {
    const [lock] = (await runner.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])) as Array<{ locked: boolean }>;
    if (!lock?.locked) return { skipped: 'Another purge is running' };
    try {
      const startsAt = await purgeStartsAt(db);
      const inGrace = !startsAt || startsAt.getTime() > now.getTime();
      const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
      const { ledgerRetentionDays, auditRetentionDays } = config.events;
      const ledger = ledgerRetentionDays === 0 ? 'kept' : inGrace ? 'grace' : await deleteInBatches(runner, 'decision_ledger', 'created_at', ago(ledgerRetentionDays));
      const audit = auditRetentionDays === 0 ? 'kept' : inGrace ? 'grace' : await deleteInBatches(runner, 'audit_events', 'created_at', ago(auditRetentionDays));
      return {
        ledger,
        audit,
        decisionCounts: await deleteInBatches(runner, 'decision_counts_hourly', 'hour', ago(FIXED_RETENTION.decisionCountsDays)),
        packageCounts: await deleteInBatches(runner, 'package_counts_hourly', 'hour', ago(FIXED_RETENTION.packageCountsDays)),
        packageUsage: await deleteInBatches(runner, 'package_usage', 'last_seen_at', ago(COLLISION_LOOKBACK_DAYS)),
        summaryFlushes: await deleteInBatches(runner, 'summary_flushes', 'flushed_at', ago(FIXED_RETENTION.summaryFlushesDays)),
      };
    } finally {
      await runner.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await runner.release();
  }
}
