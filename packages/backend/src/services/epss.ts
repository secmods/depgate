import type { DataSource } from 'typeorm';
import { config } from '../config.js';
import { EpssSyncStatus, type EpssSyncTrigger } from '../db/entities/EpssSyncStatus.js';
import { ByteLru } from './memory-lru.js';
import { bumpReference, readReference } from './reference-cache.js';
import {
  EPSS_MIN_ROWS,
  decodeEpssBody,
  epssFileError,
  isCveId,
  parseEpssCsv,
  scoreDay,
  type EpssFile,
  type EpssRow,
  type EpssValue,
} from './epss-feed.js';

export const EPSS_STATUS_ID = 'default';
/** A run still marked running after this long can be replaced, so a crashed process cannot lock the sync. */
const SYNC_STALE_MS = 3 * 60 * 60 * 1000;
const INSERT_CHUNK = 10_000;
/** About 64 bytes per CVE: a few hundred thousand lookups before anything is evicted. */
const LRU_BYTES = 16 * 1024 * 1024;
const ENTRY_BYTES = 64;

type Log = { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };

const quiet: Log = { info: () => {}, warn: () => {} };
let log: Log = quiet;

export function bindEpssLogger(logger: Log | null): void {
  log = logger ?? quiet;
}

// --- Read path ---

/** null: looked up, no score. Shared by every request in the process; cleared when a sync finishes. */
const lru = new ByteLru<EpssValue | null>(LRU_BYTES);
let lruToken: object | null = null;

type EpssMeta = { token: object; scoreDate: string | null };

async function loadMeta(db: DataSource): Promise<EpssMeta> {
  const rows: Array<{ score_date: string | null }> = await db.query(
    `SELECT score_date FROM epss_sync_status WHERE id = $1`,
    [EPSS_STATUS_ID]
  );
  return { token: {}, scoreDate: rows[0]?.score_date ?? null };
}

/** The date of the stored scores. The reference generation changes with every finished sync. */
async function epssMeta(db: DataSource): Promise<EpssMeta> {
  const meta = await readReference('epss', () => loadMeta(db));
  if (meta.token !== lruToken) {
    lru.clear();
    lruToken = meta.token;
  }
  return meta;
}

export type EpssLookup = {
  /** Scores of the CVEs that have one. A CVE missing here has no EPSS score. */
  scores: Map<string, EpssValue>;
  /** Day the scores are from, e.g. 2026-10-11; null when never synced. */
  scoreDate: string | null;
};

/**
 * One `ANY($1)` query for the CVEs not in the process LRU. EPSS off, never synced, or a
 * Postgres error: every CVE is unknown (the policy's epssUnknown decides). Never calls FIRST.
 */
export async function lookupEpss(db: DataSource, cves: Iterable<string>): Promise<EpssLookup> {
  const scores = new Map<string, EpssValue>();
  if (!config.epss.enabled) return { scores, scoreDate: null };
  const wanted = [...new Set([...cves].map((id) => id.trim().toUpperCase()).filter(isCveId))];
  let meta: EpssMeta;
  try {
    meta = await epssMeta(db);
  } catch (err) {
    log.warn({ err }, 'EPSS status lookup failed; EPSS treated as unknown');
    return { scores, scoreDate: null };
  }
  if (wanted.length === 0) return { scores, scoreDate: scoreDay(meta.scoreDate) };

  const missing: string[] = [];
  for (const cve of wanted) {
    const hit = lru.get(cve);
    if (hit === undefined) missing.push(cve);
    else if (hit) scores.set(cve, hit);
  }
  if (missing.length > 0) {
    try {
      const rows: Array<{ cve_id: string; score: number; percentile: number }> = await db.query(
        `SELECT cve_id, score, percentile FROM epss_scores WHERE cve_id = ANY($1)`,
        [missing]
      );
      const found = new Map(rows.map((row) => [row.cve_id, { score: Number(row.score), percentile: Number(row.percentile) }]));
      for (const cve of missing) {
        const value = found.get(cve) ?? null;
        lru.set(cve, value, ENTRY_BYTES);
        if (value) scores.set(cve, value);
      }
    } catch (err) {
      log.warn({ err }, 'EPSS score lookup failed; EPSS treated as unknown');
    }
  }
  return { scores, scoreDate: scoreDay(meta.scoreDate) };
}

/** Drop this process's cached scores. Other replicas follow through the `epss` reference generation. */
export async function invalidateEpss(): Promise<void> {
  lru.clear();
  lruToken = null;
  await bumpReference('epss');
}

// --- Status ---

export type EpssStatusView = {
  state: string;
  trigger: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  scoreDate: string | null;
  modelVersion: string | null;
  rowCount: number | null;
  lastError: string | null;
  /** URL the stored scores came from: the feed, or the GitHub backup. */
  feedSource: string | null;
  enabled: boolean;
  /** Never synced, or the data is older than EPSS_STALE_AFTER_HOURS. */
  stale: boolean;
  staleAfterHours: number;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

export function isEpssStale(scoreDate: string | null | undefined, now = Date.now()): boolean {
  if (!scoreDate) return true;
  const at = Date.parse(scoreDate);
  if (Number.isNaN(at)) return true;
  return now - at > config.epss.staleAfterHours * 3_600_000;
}

export async function readEpssStatus(db: DataSource): Promise<EpssStatusView> {
  const row = await db.getRepository(EpssSyncStatus).findOne({ where: { id: EPSS_STATUS_ID } });
  const running = row ? isRunning(row) : false;
  return {
    state: row ? (row.state === 'running' && !running ? 'failed' : row.state) : 'idle',
    trigger: row?.trigger ?? null,
    startedAt: iso(row?.startedAt),
    finishedAt: iso(row?.finishedAt),
    lastSuccessAt: iso(row?.lastSuccessAt),
    scoreDate: row?.scoreDate ?? null,
    modelVersion: row?.modelVersion ?? null,
    rowCount: row?.rowCount ?? null,
    lastError: row?.lastError ?? null,
    feedSource: row?.feedSource ?? null,
    enabled: config.epss.enabled,
    stale: isEpssStale(row?.scoreDate),
    staleAfterHours: config.epss.staleAfterHours,
  };
}

// --- Sync ---

function isRunning(row: Pick<EpssSyncStatus, 'state' | 'startedAt'>, now = Date.now()): boolean {
  if (row.state !== 'running' || !row.startedAt) return false;
  return now - new Date(row.startedAt).getTime() < SYNC_STALE_MS;
}

/** One replica syncs at a time. False when a fresh run is already in progress. */
export async function claimEpssSync(db: DataSource, trigger: EpssSyncTrigger): Promise<boolean> {
  await db.query(`INSERT INTO epss_sync_status (id, state) VALUES ($1, 'idle') ON CONFLICT (id) DO NOTHING`, [EPSS_STATUS_ID]);
  return db.transaction(async (manager) => {
    const repo = manager.getRepository(EpssSyncStatus);
    const row = await repo.findOne({ where: { id: EPSS_STATUS_ID }, lock: { mode: 'pessimistic_write' } });
    if (!row || isRunning(row)) return false;
    row.state = 'running';
    row.trigger = trigger;
    row.startedAt = new Date();
    row.finishedAt = null;
    await repo.save(row);
    return true;
  });
}

export async function downloadEpssFeed(url = config.epss.feedUrl, timeoutMs = config.epss.feedTimeoutMs): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'depgate', accept: 'application/gzip, text/csv, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return decodeEpssBody(Buffer.from(await res.arrayBuffer()));
}

/**
 * The GitHub backup's URLs, newest first: today (UTC), then each earlier day up to `days`.
 * The repository keeps one folder per year, so the year comes from each date.
 */
export function epssBackupUrls(now = new Date(), template = config.epss.backupUrlTemplate, days = config.epss.backupDays): string[] {
  if (!template) return [];
  const out: string[] = [];
  for (let back = 0; back < days; back += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - back)).toISOString().slice(0, 10);
    out.push(template.replace(/\{year\}/g, date.slice(0, 4)).replace(/\{date\}/g, date));
  }
  return out;
}

export type EpssDownload = { file: EpssFile; source: string };

/**
 * The feed first, then the GitHub backup. A source counts only when it parses into a full file, so an
 * error page or a truncated download moves on to the next one. Throws with every source's error.
 */
export async function downloadEpss(minRows = EPSS_MIN_ROWS, now = new Date()): Promise<EpssDownload> {
  const errors: string[] = [];
  for (const url of [config.epss.feedUrl, ...epssBackupUrls(now)]) {
    try {
      const file = parseEpssCsv(await downloadEpssFeed(url));
      if (file.rows.length < minRows) throw new Error(`${file.rows.length} rows, fewer than ${minRows}`);
      if (errors.length > 0) log.warn({ source: url, failed: errors }, 'EPSS feed unavailable; using the backup');
      return { file, source: url };
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No EPSS source could be read. ${errors.join('; ')}`);
}

/**
 * Replace every score in one transaction: readers see the old table until the commit, then the new one.
 * The status row moves with the data, so its score_date always describes what is stored.
 */
async function replaceScores(
  db: DataSource,
  rows: EpssRow[],
  meta: { scoreDate: string | null; modelVersion: string | null; source: string | null }
): Promise<number> {
  return db.transaction(async (manager) => {
    await manager.query(
      `CREATE TEMP TABLE epss_scores_staging (cve_id varchar(32) PRIMARY KEY, score real NOT NULL, percentile real NOT NULL) ON COMMIT DROP`
    );
    for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
      const chunk = rows.slice(at, at + INSERT_CHUNK);
      await manager.query(
        `INSERT INTO epss_scores_staging (cve_id, score, percentile)
         SELECT * FROM unnest($1::varchar[], $2::real[], $3::real[]) ON CONFLICT (cve_id) DO NOTHING`,
        [chunk.map((row) => row.cve), chunk.map((row) => row.score), chunk.map((row) => row.percentile)]
      );
    }
    await manager.query(`DELETE FROM epss_scores`);
    await manager.query(`INSERT INTO epss_scores (cve_id, score, percentile) SELECT cve_id, score, percentile FROM epss_scores_staging`);
    const counted: Array<{ n: number }> = await manager.query(`SELECT count(*)::int AS n FROM epss_scores`);
    const rowCount = Number(counted[0]?.n ?? rows.length);
    const finishedAt = new Date();
    await manager.getRepository(EpssSyncStatus).update(
      { id: EPSS_STATUS_ID },
      {
        state: 'completed',
        finishedAt,
        lastSuccessAt: finishedAt,
        scoreDate: meta.scoreDate,
        modelVersion: meta.modelVersion,
        rowCount,
        lastError: null,
        feedSource: meta.source,
      }
    );
    return rowCount;
  });
}

export type EpssSyncResult = {
  rowCount: number;
  scoreDate: string | null;
  modelVersion: string | null;
  skipped: number;
  /** URL the file came from. */
  source: string | null;
  /** The file had the stored score_date, so the table was left as it is. */
  unchanged: boolean;
};

export type EpssSyncOptions = {
  db: DataSource;
  trigger: EpssSyncTrigger;
  /** The file text, for tests and mirrors; otherwise the feed (then its GitHub backup) is downloaded. */
  download?: () => Promise<string>;
  minRows?: number;
  requester?: string | null;
  requesterIp?: string | null;
  userAgent?: string | null;
};

/**
 * Download, parse, guard, swap. A failed download or a rejected file leaves the stored scores
 * untouched (last good data keeps being used) and records the error on the status row.
 */
export async function runClaimedEpssSync(opts: EpssSyncOptions): Promise<EpssSyncResult> {
  const { db } = opts;
  try {
    const minRows = opts.minRows ?? EPSS_MIN_ROWS;
    const { file, source } = opts.download
      ? { file: parseEpssCsv(await opts.download()), source: null }
      : await downloadEpss(minRows);
    const stored = await db.getRepository(EpssSyncStatus).findOne({ where: { id: EPSS_STATUS_ID } });
    const rejected = epssFileError(file, stored?.scoreDate ?? null, minRows);
    if (rejected) throw new Error(rejected);
    if (stored?.lastSuccessAt && file.scoreDate && stored.scoreDate === file.scoreDate) {
      // The same day's file again (the backup lags, or a second run): nothing to swap.
      await db.getRepository(EpssSyncStatus).update(
        { id: EPSS_STATUS_ID },
        { state: 'completed', finishedAt: new Date(), lastSuccessAt: new Date(), lastError: null }
      );
      log.info({ scoreDate: file.scoreDate, source }, 'EPSS scores already current');
      return { rowCount: stored.rowCount ?? 0, scoreDate: file.scoreDate, modelVersion: file.modelVersion, skipped: file.skipped, source, unchanged: true };
    }
    const rowCount = await replaceScores(db, file.rows, { scoreDate: file.scoreDate, modelVersion: file.modelVersion, source });
    await invalidateEpss();
    log.info({ rowCount, scoreDate: file.scoreDate, skipped: file.skipped, source }, 'EPSS sync completed');
    return { rowCount, scoreDate: file.scoreDate, modelVersion: file.modelVersion, skipped: file.skipped, source, unchanged: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .getRepository(EpssSyncStatus)
      .update({ id: EPSS_STATUS_ID }, { state: 'failed', finishedAt: new Date(), lastError: message.slice(0, 2000) })
      .catch(() => undefined);
    log.warn({ err: message }, 'EPSS sync failed; keeping the last good scores');
    throw err;
  }
}

/** Claim and run. Returns null when another replica is already syncing. */
export async function syncEpss(opts: EpssSyncOptions): Promise<EpssSyncResult | null> {
  if (!(await claimEpssSync(opts.db, opts.trigger))) return null;
  return runClaimedEpssSync(opts);
}

/**
 * The admin "refresh" for a handful of CVEs, from FIRST's API. Upserts the rows it gets back;
 * never used on the request path.
 */
export async function refreshEpssCves(db: DataSource, cves: string[]): Promise<Map<string, EpssValue>> {
  const ids = [...new Set(cves.map((id) => id.trim().toUpperCase()).filter(isCveId))];
  const out = new Map<string, EpssValue>();
  if (ids.length === 0) return out;
  const url = `${config.epss.apiUrl.replace(/\/$/, '')}?cve=${encodeURIComponent(ids.join(','))}`;
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'depgate' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FIRST EPSS API returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ cve?: string; epss?: string | number; percentile?: string | number }> };
  for (const row of body.data ?? []) {
    const cve = String(row.cve ?? '').toUpperCase();
    const score = Number(row.epss);
    const percentile = Number(row.percentile);
    if (!isCveId(cve) || !(score >= 0 && score <= 1) || !(percentile >= 0 && percentile <= 1)) continue;
    out.set(cve, { score, percentile });
  }
  if (out.size > 0) {
    const rows = [...out.entries()];
    await db.query(
      `INSERT INTO epss_scores (cve_id, score, percentile)
       SELECT * FROM unnest($1::varchar[], $2::real[], $3::real[])
       ON CONFLICT (cve_id) DO UPDATE SET score = EXCLUDED.score, percentile = EXCLUDED.percentile`,
      [rows.map(([cve]) => cve), rows.map(([, v]) => v.score), rows.map(([, v]) => v.percentile)]
    );
    await invalidateEpss();
  }
  return out;
}
