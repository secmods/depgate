import type { DataSource, EntityManager } from 'typeorm';
import { DecisionLedgerEntry } from '../../db/entities/DecisionLedgerEntry.js';
import { AuditEvent } from '../../db/entities/AuditEvent.js';
import { COLLISION_LOOKBACK_DAYS } from '../namespace-collisions.js';
import { buildEnvelope } from './envelope.js';
import { isDecisionType, legacyToEvent, type LegacyRow } from './legacy.js';
import { auditRow, ledgerRow, PACKAGE_ECOSYSTEMS } from './record.js';
import { upsertCounts, upsertUsage, type UsageRow } from './summary.js';

/**
 * Copies `audit_logs` into the new tables (requirements_event_streaming.md §5.5). The scheduled job that
 * ran this copy has been removed; startup stays seconds long because it only creates the tables.
 *
 * Each batch of 10,000 rows, ordered by (created_at, id), is one transaction that copies the blocks into
 * `decision_ledger` and the admin rows into `audit_events`, adds the batch's ALLOW and BLOCK rows to the
 * counts and usage, and advances the cursor. A crash resumes at the cursor with nothing copied or counted
 * twice. Rows that old replicas write during a rolling deploy are picked up by later runs.
 */

const BATCH = 10_000;
const PACKAGE_COUNTS_DAYS = 31;
const DAY_MS = 86_400_000;
/** One run stops after this long; the next scheduled run continues from the cursor. */
const RUN_BUDGET_MS = 15 * 60_000;

export type MigrationState = {
  startedAt: Date;
  finishedAt: Date | null;
  cursorCreatedAt: Date | null;
  copiedLedger: number;
  copiedAudit: number;
  counted: number;
};

let finishedCache: boolean | null = null;

/** Whether the copy finished, as of the last read. Decides the job's schedule: hourly until done, then daily. */
export function migrationFinished(): boolean {
  return finishedCache === true;
}

export async function readMigrationState(db: DataSource | EntityManager): Promise<MigrationState | null> {
  const rows: Array<Record<string, unknown>> = await db.query(
    `SELECT started_at, finished_at, cursor_created_at, copied_ledger, copied_audit, counted FROM event_migration WHERE id = 1`
  );
  const row = rows[0];
  if (!row) return null;
  const state = {
    startedAt: new Date(row.started_at as string),
    finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
    cursorCreatedAt: row.cursor_created_at ? new Date(row.cursor_created_at as string) : null,
    copiedLedger: Number(row.copied_ledger ?? 0),
    copiedAudit: Number(row.copied_audit ?? 0),
    counted: Number(row.counted ?? 0),
  };
  finishedCache = state.finishedAt !== null;
  return state;
}

export async function legacyTableExists(db: DataSource | EntityManager): Promise<boolean> {
  const [row]: Array<{ present: boolean }> = await db.query(`SELECT to_regclass('public.audit_logs') IS NOT NULL AS present`);
  return row?.present === true;
}

type LegacyDbRow = {
  id: string;
  created_at: Date;
  requester_ip: string | null;
  requester: string | null;
  user_agent: string | null;
  ecosystem: string;
  package_name: string;
  resolved_version: string | null;
  repository: string | null;
  decision: string;
  policy_id: string | null;
  policy_name: string | null;
  condition_reasons: string[] | null;
  metadata: Record<string, string> | null;
};

function toLegacy(row: LegacyDbRow): LegacyRow {
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    requesterIp: row.requester_ip,
    requester: row.requester,
    userAgent: row.user_agent,
    ecosystem: row.ecosystem,
    packageName: row.package_name,
    resolvedVersion: row.resolved_version,
    repository: row.repository,
    decision: row.decision,
    policyId: row.policy_id,
    policyName: row.policy_name,
    conditionReasons: row.condition_reasons,
    metadata: row.metadata,
  };
}

function hourOf(at: Date): string {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
}

type Totals = { rows: number; ledger: number; audit: number; counted: number };

/** One batch, one transaction. Returns how many old rows it read (0 when there is nothing after the cursor). */
export async function migrateBatch(db: DataSource, now = new Date(), batchSize = BATCH): Promise<Totals> {
  return db.transaction(async (manager) => {
    // The cursor is compared inside Postgres: as a JS Date it would lose its microseconds.
    const [cursor]: Array<{ started: boolean }> = await manager.query(
      `SELECT cursor_created_at IS NOT NULL AS started FROM event_migration WHERE id = 1 FOR UPDATE`
    );
    const rows: LegacyDbRow[] = cursor?.started
      ? await manager.query(
          `SELECT a.* FROM audit_logs a, event_migration m
            WHERE m.id = 1 AND (a.created_at, a.id) > (m.cursor_created_at, m.cursor_id)
            ORDER BY a.created_at, a.id LIMIT $1`,
          [batchSize]
        )
      : await manager.query(`SELECT * FROM audit_logs ORDER BY created_at, id LIMIT $1`, [batchSize]);
    if (rows.length === 0) return { rows: 0, ledger: 0, audit: 0, counted: 0 };

    const ledger: DecisionLedgerEntry[] = [];
    const audit: AuditEvent[] = [];
    const counts = new Map<string, Array<{ key: [string, string | null, string]; n: number }>>();
    const packageCounts = new Map<string, Array<{ key: [string, string | null, string]; n: number }>>();
    const usage: UsageRow[] = [];
    let counted = 0;
    const usageSince = now.getTime() - COLLISION_LOOKBACK_DAYS * DAY_MS;
    const packageCountsSince = now.getTime() - PACKAGE_COUNTS_DAYS * DAY_MS;

    for (const raw of rows) {
      const old = toLegacy(raw);
      const event = legacyToEvent(old);
      if (!event) continue;
      const createdAt = old.createdAt!;
      const isPackageRow = (event.type === 'ALLOW' || event.type === 'BLOCK_ENFORCE') && PACKAGE_ECOSYSTEMS.has(old.ecosystem);
      if (isPackageRow) {
        const hour = hourOf(createdAt);
        const add = (map: typeof counts, key: [string, string | null, string]) => {
          const list = map.get(hour) ?? [];
          list.push({ key, n: 1 });
          map.set(hour, list);
        };
        add(counts, [old.ecosystem, old.repository ?? null, event.type]);
        if (createdAt.getTime() >= packageCountsSince) add(packageCounts, [old.ecosystem, old.packageName, event.type]);
        counted += 1;
        if (old.resolvedVersion && createdAt.getTime() >= usageSince) {
          const source = (event.details?.source ?? null) as { repository?: string; type?: string } | null;
          usage.push({
            ecosystem: old.ecosystem,
            packageName: old.packageName,
            version: old.resolvedVersion,
            repository: old.repository ?? null,
            sourceRepository: source?.repository ?? null,
            sourceType: source?.type ?? null,
            decision: event.type as 'ALLOW' | 'BLOCK_ENFORCE',
            seenAt: createdAt,
            firstSeenAt: createdAt,
          });
        }
      }
      // ALLOW rows only feed the counts and usage (D1).
      if (event.type === 'ALLOW') continue;
      const envelope = buildEnvelope(event);
      if (isDecisionType(event.type)) ledger.push(ledgerRow(envelope, envelope.policy?.name === 'Malicious packages list'));
      else audit.push(auditRow(envelope));
    }

    for (let i = 0; i < ledger.length; i += 1000) {
      await manager.createQueryBuilder().insert().into(DecisionLedgerEntry).values(ledger.slice(i, i + 1000) as never[]).orIgnore().execute();
    }
    for (let i = 0; i < audit.length; i += 1000) {
      await manager.createQueryBuilder().insert().into(AuditEvent).values(audit.slice(i, i + 1000) as never[]).orIgnore().execute();
    }
    for (const [hour, list] of counts) await upsertCounts(manager, 'counts', new Date(hour), list);
    for (const [hour, list] of packageCounts) await upsertCounts(manager, 'pkgcounts', new Date(hour), list);
    if (usage.length) await upsertUsage(manager, usage);

    const last = rows[rows.length - 1];
    // The cursor takes created_at from the row itself: a JS Date has milliseconds, Postgres microseconds,
    // and a truncated cursor would read the batch's last row again.
    await manager.query(
      `UPDATE event_migration SET cursor_created_at = (SELECT created_at FROM audit_logs WHERE id = $1), cursor_id = $1,
              copied_ledger = copied_ledger + $2, copied_audit = copied_audit + $3, counted = counted + $4
        WHERE id = 1`,
      [last.id, ledger.length, audit.length, counted]
    );
    return { rows: rows.length, ledger: ledger.length, audit: audit.length, counted };
  });
}

type Log = { info: (obj: unknown, msg?: string) => void };

/** The job: batches until the old table is done or the run's time budget is spent. */
export async function runEventMigration(
  db: DataSource,
  log?: Log,
  opts: { budgetMs?: number; batchSize?: number } = {}
): Promise<Record<string, unknown>> {
  if (!(await legacyTableExists(db))) {
    await db.query(`UPDATE event_migration SET finished_at = COALESCE(finished_at, now()) WHERE id = 1`);
    finishedCache = true;
    return { skipped: 'No audit_logs table' };
  }
  // Walking the old table in (created_at, id) order needs this index; built without blocking writers.
  await db.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_created_id ON audit_logs (created_at, id)`).catch(() => undefined);
  const started = Date.now();
  const budget = opts.budgetMs ?? RUN_BUDGET_MS;
  const totals = { rows: 0, ledger: 0, audit: 0, counted: 0, batches: 0 };
  let done = false;
  while (Date.now() - started < budget) {
    const batch = await migrateBatch(db, new Date(), opts.batchSize);
    if (batch.rows === 0) {
      done = true;
      break;
    }
    totals.rows += batch.rows;
    totals.ledger += batch.ledger;
    totals.audit += batch.audit;
    totals.counted += batch.counted;
    totals.batches += 1;
    if (totals.batches % 20 === 0) log?.info({ ...totals }, 'Copying older events');
  }
  if (done) {
    await db.query(`UPDATE event_migration SET finished_at = COALESCE(finished_at, now()) WHERE id = 1`);
    finishedCache = true;
  }
  log?.info({ ...totals, finished: done }, done ? 'Older events copied' : 'Older events partly copied; the next run continues');
  return { ...totals, finished: done };
}
