import { DataSource } from 'typeorm';
import { MaliciousFeedState } from '../db/entities/MaliciousFeedState.js';
import {
  MaliciousSyncStatus,
  MaliciousSyncTrigger,
} from '../db/entities/MaliciousSyncStatus.js';
import { FEED_STATE_ID } from './malicious-feed.js';
import {
  syncMaliciousFromDepgate,
  type SyncLogger,
  type SyncProgress,
  type SyncResult,
} from './malicious-sync.js';

/** A run still marked running after this long can be replaced. A crashed process must not lock the button forever. */
export const SYNC_STALE_MS = 3 * 60 * 60 * 1000;

const noopLog: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function isSyncInProgress(
  status: string | null | undefined,
  startedAt: Date | string | null | undefined,
  now = Date.now()
): boolean {
  if (status !== 'running' || startedAt == null) return false;
  const started = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return now - started < SYNC_STALE_MS;
}

export function syncModeLabel(mode: SyncResult['mode']): string {
  if (mode === 'full') return 'full sync';
  if (mode === 'changes') return 'changes sync';
  return 'no changes';
}

export function formatMaliciousSyncAudit(input: {
  trigger: MaliciousSyncTrigger;
  mode?: SyncResult['mode'] | null;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
  added?: number;
  removed?: number;
  updated?: number;
  total?: number;
  error?: string;
}): string[] {
  const lines = [
    `Trigger: ${input.trigger}`,
    `Mode: ${input.mode ?? 'unknown'}`,
    `Watermark before: ${input.watermarkBefore ?? 'none'}`,
    `Watermark after: ${input.watermarkAfter ?? 'unchanged'}`,
  ];
  if (input.added != null) lines.push(`Added: ${input.added}`);
  if (input.updated != null) lines.push(`Updated: ${input.updated}`);
  if (input.removed != null) lines.push(`Removed: ${input.removed}`);
  if (input.total != null) lines.push(`Tracked packages: ${input.total}`);
  if (input.error) lines.push(`Error: ${input.error}`);
  return lines;
}

async function patchStatus(db: DataSource, patch: Partial<MaliciousSyncStatus>): Promise<void> {
  const repo = db.getRepository(MaliciousSyncStatus);
  const row = await repo.findOne({ where: { id: FEED_STATE_ID } });
  if (!row) return;
  await repo.save(Object.assign(row, patch));
}

/** Returns false when a fresh run is already in progress. */
export async function claimMaliciousSync(db: DataSource, trigger: MaliciousSyncTrigger): Promise<boolean> {
  await db.query(
    `INSERT INTO malicious_sync_status (id, status) VALUES ($1, 'idle') ON CONFLICT (id) DO NOTHING`,
    [FEED_STATE_ID]
  );
  return db.transaction(async (manager) => {
    const repo = manager.getRepository(MaliciousSyncStatus);
    const row = await repo.findOne({
      where: { id: FEED_STATE_ID },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row || isSyncInProgress(row.status, row.startedAt)) return false;
    row.status = 'running';
    row.trigger = trigger;
    row.startedAt = new Date();
    row.finishedAt = null;
    row.phase = 'fetching';
    row.ecosystem = null;
    row.mode = null;
    row.added = null;
    row.removed = null;
    row.updated = null;
    row.total = null;
    row.error = null;
    row.watermarkBefore = null;
    row.watermarkAfter = null;
    await repo.save(row);
    return true;
  });
}

export async function runClaimedMaliciousSync(opts: {
  db: DataSource;
  log?: SyncLogger;
  trigger: MaliciousSyncTrigger;
  requesterIp?: string | null;
  userAgent?: string | null;
  requester?: string | null;
  onProgress?: (p: SyncProgress) => void | Promise<void>;
}): Promise<SyncResult> {
  const log = opts.log ?? noopLog;
  const feed = await opts.db.getRepository(MaliciousFeedState).findOne({ where: { id: FEED_STATE_ID } });
  const watermarkBefore = feed?.watermark ?? null;
  await patchStatus(opts.db, { watermarkBefore });

  try {
    const result = await syncMaliciousFromDepgate(opts.db, log, async (progress) => {
      await patchStatus(opts.db, {
        phase: progress.phase,
        ecosystem: progress.ecosystem ?? null,
        added: progress.added ?? null,
        total: progress.total ?? null,
      }).catch((err) => log.warn({ err }, 'Malicious sync progress update failed'));
      await opts.onProgress?.(progress);
    });
    const finishedAt = new Date();
    await patchStatus(opts.db, {
      status: 'completed',
      finishedAt,
      lastSuccessAt: finishedAt,
      phase: 'done',
      ecosystem: null,
      mode: result.mode,
      added: result.added,
      removed: result.removed,
      updated: result.updated,
      total: result.total,
      error: null,
      watermarkBefore: result.watermarkBefore,
      watermarkAfter: result.watermarkAfter,
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await patchStatus(opts.db, {
      status: 'failed',
      finishedAt: new Date(),
      phase: 'done',
      error,
      watermarkBefore,
      watermarkAfter: watermarkBefore,
    }).catch((patchErr) => log.error(patchErr, 'Malicious sync failure status update failed'));
    throw err;
  }
}
