import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { DataSource, In } from 'typeorm';
import { MaliciousFeedState, MaliciousEcosystemSummary } from '../db/entities/MaliciousFeedState.js';
import { MaliciousPackage } from '../db/entities/MaliciousPackage.js';
import { config } from '../config.js';
import { versionInRange } from './version-range.js';
import { malwareEcosystems, canonicalPackageName } from './package-name.js';
import { bumpReference, readReferenceEntry } from './reference-cache.js';
import {
  ChangeOp,
  DROPPED_ECOSYSTEMS,
  FEED_STATE_ID,
  Manifest,
  SYNC_ECOSYSTEMS,
  SnapshotRecord,
  SyncMode,
  assertManifest,
  decideSync,
  appendSnapshot,
  resolveFeedFile,
  selectChangeOps,
  trackedRecordCount,
  verifySha256,
  feedVersionsToRange,
} from './malicious-feed.js';

const execFileAsync = promisify(execFile);

export type SyncLogger = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (err: unknown, msg?: string) => void;
};

export type SyncProgress = {
  phase: 'fetching' | 'upserting';
  ecosystem?: string;
  fetched?: number;
  added?: number;
  total?: number;
  error?: string;
};

export type SyncResult = {
  added: number;
  removed: number;
  updated: number;
  total: number;
  mode: SyncMode;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
};

const noopLog: SyncLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const FETCH_TIMEOUT_MS = config.malicious.feedTimeoutMs;
const FETCH_RETRIES = 2;
const WRITE_CHUNK = 1000;

type PackageKey = { name: string; source: 'default' | 'custom' };

type FeedRow = { name: string; ecosystem: string; reason: string | null; versionRange: string | null };

export type MaliciousPackageStore = {
  listByEcosystem(ecosystem: string): Promise<PackageKey[]>;
  listByNames(ecosystem: string, names: string[]): Promise<PackageKey[]>;
  insertDefault(rows: FeedRow[]): Promise<void>;
  updateDefault(rows: FeedRow[]): Promise<void>;
  deleteDefaultByName(ecosystem: string, names: string[]): Promise<number>;
  deleteDefaultByEcosystem(ecosystems: string[]): Promise<number>;
  readWatermark(): Promise<string | null>;
  writeState(manifest: Manifest): Promise<void>;
  /**
   * Gives rows without a `lookup_name` one. A replica still on an older version writes rows without
   * it during a rolling upgrade, and lookups never match them, so every sync repairs them.
   */
  fillLookupNames?(): Promise<number>;
};

type ExecuteDeps = {
  store: MaliciousPackageStore;
  feedUrl: string;
  archiveUrl: string;
  limit?: number;
  log: SyncLogger;
  onProgress?: (p: SyncProgress) => void | Promise<void>;
  fetchBuffer: (url: string) => Promise<Buffer>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function feedFileUrl(feedUrl: string, file: string): string {
  return `${feedUrl.replace(/\/$/, '')}/${file}`;
}

function manifestUrl(feedUrl: string): string {
  return feedFileUrl(feedUrl, 'manifest.json');
}

function reasonFromId(id: string | undefined): string | null {
  return id ?? null;
}

function feedRow(ecosystem: string, name: string, id: string | undefined, versions?: string[]): FeedRow {
  return {
    name,
    ecosystem,
    reason: reasonFromId(id),
    versionRange: feedVersionsToRange(ecosystem, versions),
  };
}

function asRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

export function createPackageStore(db: DataSource): MaliciousPackageStore {
  return {
    async listByEcosystem(ecosystem) {
      const result = await db.query(
        `SELECT name, source FROM malicious_packages WHERE ecosystem = $1`,
        [ecosystem]
      );
      return asRows(result) as PackageKey[];
    },

    async listByNames(ecosystem, names) {
      if (names.length === 0) return [];
      const found: PackageKey[] = [];
      for (const part of chunk(names, WRITE_CHUNK)) {
        const result = await db.query(
          `SELECT name, source FROM malicious_packages WHERE ecosystem = $1 AND name = ANY($2::varchar[])`,
          [ecosystem, part]
        );
        found.push(...(asRows(result) as PackageKey[]));
      }
      return found;
    },

    async insertDefault(rows) {
      for (const part of chunk(rows, WRITE_CHUNK)) {
        await db.query(
          `INSERT INTO malicious_packages (id, name, ecosystem, lookup_name, reason, version_range, source, override_status, created_at)
           SELECT id, name, ecosystem, lookup_name, reason, version_range, 'default', 'BLOCK', NOW()
           FROM unnest($1::uuid[], $2::varchar[], $3::varchar[], $4::varchar[], $5::text[], $6::varchar[])
             AS t(id, name, ecosystem, lookup_name, reason, version_range)
           ON CONFLICT (name, ecosystem) DO UPDATE SET
             reason = EXCLUDED.reason,
             lookup_name = EXCLUDED.lookup_name,
             version_range = EXCLUDED.version_range
           WHERE malicious_packages.source = 'default'`,
          [
            part.map(() => randomUUID()),
            part.map((row) => row.name),
            part.map((row) => row.ecosystem),
            part.map((row) => canonicalPackageName(row.ecosystem, row.name)),
            part.map((row) => row.reason),
            part.map((row) => row.versionRange),
          ]
        );
      }
      if (rows.length > 0) await bumpReference('malicious');
    },

    async updateDefault(rows) {
      for (const part of chunk(rows, WRITE_CHUNK)) {
        const ecosystem = part[0].ecosystem;
        await db.query(
          `UPDATE malicious_packages AS m
           SET reason = v.reason, lookup_name = v.lookup_name, version_range = v.version_range
           FROM unnest($2::varchar[], $3::text[], $4::varchar[], $5::varchar[]) AS v(name, reason, lookup_name, version_range)
           WHERE m.ecosystem = $1 AND m.name = v.name AND m.source = 'default'`,
          [
            ecosystem,
            part.map((row) => row.name),
            part.map((row) => row.reason),
            part.map((row) => canonicalPackageName(ecosystem, row.name)),
            part.map((row) => row.versionRange),
          ]
        );
      }
      if (rows.length > 0) await bumpReference('malicious');
    },

    async deleteDefaultByName(ecosystem, names) {
      let removed = 0;
      for (const part of chunk(names, WRITE_CHUNK)) {
        const result = await db.query(
          `DELETE FROM malicious_packages
           WHERE ecosystem = $1 AND source = 'default' AND name = ANY($2::varchar[])
           RETURNING name`,
          [ecosystem, part]
        );
        removed += asRows(result).length;
      }
      if (removed > 0) await bumpReference('malicious');
      return removed;
    },

    async deleteDefaultByEcosystem(ecosystems) {
      if (ecosystems.length === 0) return 0;
      const result = await db.query(
        `DELETE FROM malicious_packages
         WHERE source = 'default' AND ecosystem = ANY($1::varchar[])
         RETURNING name`,
        [ecosystems]
      );
      const removed = asRows(result).length;
      if (removed > 0) await bumpReference('malicious');
      return removed;
    },

    async readWatermark() {
      const row = await db.getRepository(MaliciousFeedState).findOne({ where: { id: FEED_STATE_ID } });
      return row?.watermark ?? null;
    },

    async fillLookupNames() {
      const filled = await backfillMaliciousLookupNames(db);
      if (filled > 0) await bumpReference('malicious');
      return filled;
    },
    async writeState(manifest) {
      const ecosystems: Record<string, MaliciousEcosystemSummary> = {};
      for (const [ecosystem, entry] of Object.entries(manifest.ecosystems)) {
        ecosystems[ecosystem] = {
          records: entry.records ?? 0,
          maxModified: entry.max_modified ?? null,
          changesRecords: entry.changes_records ?? 0,
        };
      }
      const repo = db.getRepository(MaliciousFeedState);
      const fields = {
        id: FEED_STATE_ID,
        watermark: manifest.generated_at,
        schemaVersion: manifest.schema_version,
        upstreamRepo: manifest.upstream_repo ?? null,
        upstreamCommit: manifest.upstream_commit ?? null,
        changesSince: manifest.changes_since,
        changesWindowDays: manifest.changes_window_days ?? 0,
        totalRecords: manifest.total_records ?? 0,
        ecosystems,
        appliedAt: new Date(),
      };
      const existing = await repo.findOne({ where: { id: FEED_STATE_ID } });
      if (existing) await repo.save(Object.assign(existing, fields));
      else await repo.save(repo.create(fields));
    },
  };
}

export async function applySnapshot(
  store: MaliciousPackageStore,
  ecosystem: string,
  records: SnapshotRecord[],
  limit?: number
): Promise<{ added: number; updated: number; removed: number; skippedCustom: number }> {
  const limited = limit != null ? records.slice(0, limit) : records;
  const existing = await store.listByEcosystem(ecosystem);
  const byName = new Map(existing.map((row) => [row.name, row.source]));
  const inserts = new Map<string, FeedRow>();
  const updates = new Map<string, FeedRow>();
  let skippedCustom = 0;
  const seen = new Set<string>();

  for (const record of limited) {
    seen.add(record.name);
    const row: FeedRow = feedRow(ecosystem, record.name, record.id, record.versions);
    const source = byName.get(record.name);
    if (source === 'custom') {
      skippedCustom++;
      inserts.delete(record.name);
      updates.delete(record.name);
      continue;
    }
    if (source === 'default' || updates.has(record.name)) {
      updates.set(record.name, row);
      inserts.delete(record.name);
    } else {
      inserts.set(record.name, row);
    }
  }

  const insertRows = Array.from(inserts.values());
  const updateRows = Array.from(updates.values());
  await store.insertDefault(insertRows);
  await store.updateDefault(updateRows);

  let removed = 0;
  if (limit == null) {
    const stale = existing.filter((row) => row.source === 'default' && !seen.has(row.name)).map((row) => row.name);
    removed = await store.deleteDefaultByName(ecosystem, stale);
  }

  return { added: insertRows.length, updated: updateRows.length, removed, skippedCustom };
}

export async function applyChanges(
  store: MaliciousPackageStore,
  ecosystem: string,
  ops: ChangeOp[],
  limit?: number
): Promise<{ added: number; updated: number; removed: number; skippedCustom: number }> {
  const limited = limit != null ? ops.slice(0, limit) : ops;
  const existing = await store.listByNames(
    ecosystem,
    limited.map((op) => op.name)
  );
  const byName = new Map(existing.map((row) => [row.name, row.source]));
  const inserts: FeedRow[] = [];
  const updates: FeedRow[] = [];
  const deletes: string[] = [];
  let skippedCustom = 0;

  for (const op of limited) {
    const source = byName.get(op.name);
    if (source === 'custom') {
      skippedCustom++;
      continue;
    }
    if (op.op === 'delete') {
      if (source === 'default') deletes.push(op.name);
      continue;
    }
    const row: FeedRow = feedRow(ecosystem, op.name, op.id, op.versions);
    if (source === 'default') updates.push(row);
    else inserts.push(row);
  }

  await store.insertDefault(inserts);
  await store.updateDefault(updates);
  const removed = await store.deleteDefaultByName(ecosystem, deletes);
  return { added: inserts.length, updated: updates.length, removed, skippedCustom };
}

async function findFeedDir(root: string): Promise<string> {
  const candidates = [root, path.join(root, 'malicious-packages')];
  for (const dir of candidates) {
    try {
      await readFile(path.join(dir, 'manifest.json'));
      return dir;
    } catch {
      /* try the next layout */
    }
  }
  throw new Error('Archive has no manifest.json');
}

async function extractArchive(buf: Buffer): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'depgate-malicious-'));
  const archivePath = path.join(root, 'feed.tar.gz');
  await writeFile(archivePath, buf);
  try {
    await execFileAsync('tar', ['-xzf', archivePath, '-C', root]);
    const dir = await findFeedDir(root);
    return {
      dir,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(root, { recursive: true, force: true });
    throw err;
  }
}

type Prepared =
  | { ecosystem: string; mode: 'full'; records: SnapshotRecord[] }
  | { ecosystem: string; mode: 'changes'; ops: ChangeOp[] };

async function readVerified(read: (file: string) => Promise<Buffer>, file: string, expectedSha: string): Promise<string> {
  const buf = await read(file);
  verifySha256(file, buf, expectedSha);
  return buf.toString('utf8');
}

export async function executeMaliciousSync(deps: ExecuteDeps): Promise<SyncResult> {
  const { store, log, onProgress } = deps;
  const remoteBytes = await deps.fetchBuffer(manifestUrl(deps.feedUrl));
  const remote = assertManifest(JSON.parse(remoteBytes.toString('utf8')));
  const watermark = await store.readWatermark();
  const mode = decideSync(remote, watermark);

  log.info(
    { mode, watermark, generatedAt: remote.generated_at, changesSince: remote.changes_since },
    'Malicious feed decision'
  );
  const fillLookupNames = async () => {
    const filled = (await store.fillLookupNames?.()) ?? 0;
    if (filled > 0) log.info({ filled }, 'Malicious feed: filled missing lookup names');
  };

  if (mode === 'none') {
    await fillLookupNames();
    return {
      added: 0,
      removed: 0,
      updated: 0,
      total: trackedRecordCount(remote),
      mode,
      watermarkBefore: watermark,
      watermarkAfter: watermark,
    };
  }

  let manifest = remote;
  let cleanup = async () => {};
  let read: (file: string) => Promise<Buffer>;

  try {
    if (mode === 'full') {
      await onProgress?.({ phase: 'fetching' });
      const archive = await deps.fetchBuffer(deps.archiveUrl);
      const extracted = await extractArchive(archive);
      cleanup = extracted.cleanup;
      read = (file) => readFile(resolveFeedFile(extracted.dir, file));
      const manifestBuf = await readFile(path.join(extracted.dir, 'manifest.json'));
      manifest = assertManifest(JSON.parse(manifestBuf.toString('utf8')));
    } else {
      read = (file) => deps.fetchBuffer(feedFileUrl(deps.feedUrl, file));
    }

    const prepared: Prepared[] = [];
    for (const ecosystem of SYNC_ECOSYSTEMS) {
      const entry = manifest.ecosystems[ecosystem];
      if (!entry) continue;
      await onProgress?.({ phase: 'fetching', ecosystem });
      if (mode === 'full') {
        const records: SnapshotRecord[] = [];
        for (const file of entry.files) {
          const text = await readVerified(read, file.file, file.sha256);
          appendSnapshot(records, text);
        }
        prepared.push({ ecosystem, mode: 'full', records });
      } else {
        const text = await readVerified(read, entry.changes_file, entry.changes_sha256);
        prepared.push({
          ecosystem,
          mode: 'changes',
          ops: selectChangeOps(text, watermark!),
        });
      }
    }

    let added = 0;
    let updated = 0;
    let removed = 0;
    let skippedCustom = 0;
    const applyTotal = prepared.reduce((sum, item) => {
      return sum + (item.mode === 'full' ? item.records.length : item.ops.length);
    }, 0);

    for (const item of prepared) {
      const counts =
        item.mode === 'full'
          ? await applySnapshot(store, item.ecosystem, item.records, deps.limit)
          : await applyChanges(store, item.ecosystem, item.ops, deps.limit);
      added += counts.added;
      updated += counts.updated;
      removed += counts.removed;
      skippedCustom += counts.skippedCustom;
      await onProgress?.({ phase: 'upserting', ecosystem: item.ecosystem, added, total: applyTotal });
      log.info({ ecosystem: item.ecosystem, ...counts }, 'Applied malicious feed ecosystem');
    }

    if (mode === 'full') {
      removed += await store.deleteDefaultByEcosystem([...DROPPED_ECOSYSTEMS]);
    }

    await fillLookupNames();
    await store.writeState(manifest);
    log.info({ added, updated, removed, skippedCustom, mode, total: manifest.total_records }, 'Malicious feed sync completed');
    return {
      added,
      removed,
      updated,
      total: trackedRecordCount(manifest),
      mode,
      watermarkBefore: watermark,
      watermarkAfter: manifest.generated_at,
    };
  } finally {
    await cleanup();
  }
}

async function fetchBuffer(url: string, log: SyncLogger): Promise<Buffer> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      log.info({ method: 'GET', url, attempt: attempt + 1 }, 'Malicious feed: outgoing request');
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      log.warn({ url, attempt: attempt + 1, error: lastErr.message }, 'Malicious feed: request failed');
      if (attempt < FETCH_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr ?? new Error(`Fetch failed: ${url}`);
}

export async function syncMaliciousFromDepgate(
  db: DataSource,
  log: SyncLogger = noopLog,
  onProgress?: (p: SyncProgress) => void | Promise<void>
): Promise<SyncResult> {
  const limit = config.malicious.syncLimitPerEcosystem;
  log.info(
    { archiveUrl: config.malicious.archiveUrl, feedUrl: config.malicious.feedUrl, limit: limit ?? 'unlimited' },
    'Malicious feed sync started'
  );
  return executeMaliciousSync({
    store: createPackageStore(db),
    feedUrl: config.malicious.feedUrl,
    archiveUrl: config.malicious.archiveUrl,
    limit,
    log,
    onProgress,
    fetchBuffer: (url) => fetchBuffer(url, log),
  });
}

/** @deprecated Use syncMaliciousFromDepgate */
export async function syncMaliciousFromOSSF(db: DataSource): Promise<SyncResult> {
  return syncMaliciousFromDepgate(db);
}

export function maliciousMatch(
  pkg: MaliciousPackage | null,
  version?: string
): { blocked: boolean; reason?: string; overrideStatus?: string } {
  if (!pkg) return { blocked: false };
  if (pkg.overrideStatus === 'ALLOW') return { blocked: false };
  if (pkg.versionRange && version) {
    // A version outside the range is allowed. A version we cannot order stays blocked.
    if (versionInRange(pkg.ecosystem, version, pkg.versionRange) === 'miss') return { blocked: false };
  } else if (pkg.versionRange && !version) {
    return { blocked: false };
  }
  return { blocked: true, reason: pkg.reason ?? undefined, overrideStatus: pkg.overrideStatus };
}

/** The malware list entry a version falls under, whatever its override (R-P6). */
export type MalwareHit = { id: string; source: 'feed' | 'custom'; reason: string | null; override: 'ALLOW' | 'BLOCK' };

export function malwareListed(pkg: MaliciousPackage | null, version?: string): MalwareHit | null {
  if (!pkg) return null;
  if (pkg.versionRange) {
    if (!version) return null;
    if (versionInRange(pkg.ecosystem, version, pkg.versionRange) === 'miss') return null;
  }
  const advisory = pkg.reason?.match(/\bMAL-\d{4}-\d+\b/)?.[0];
  return {
    id: advisory ?? pkg.id,
    source: pkg.source === 'custom' ? 'custom' : 'feed',
    reason: pkg.reason ?? null,
    override: pkg.overrideStatus === 'ALLOW' ? 'ALLOW' : 'BLOCK',
  };
}

/**
 * The entry for `name` as a client of `ecosystem` spells it. When several spellings are listed,
 * an administrator's entry wins over the feed's, and an Allow override over a block.
 */
export async function findMaliciousEntry(
  db: DataSource,
  ecosystem: string,
  name: string
): Promise<MaliciousPackage | null> {
  return db.getRepository(MaliciousPackage).findOne({
    where: { ecosystem: In(malwareEcosystems(ecosystem)), lookupName: canonicalPackageName(ecosystem, name) },
    // 'custom' sorts before 'default', 'ALLOW' before 'BLOCK'.
    order: { source: 'ASC', overrideStatus: 'ASC' },
  });
}

/**
 * findMaliciousEntry for the download path: one query per name until the list changes (a feed
 * sync, an override, a custom entry) or the reference max age passes.
 */
export function findMaliciousEntryCached(
  db: DataSource,
  ecosystem: string,
  name: string,
  opts?: { verify?: boolean }
): Promise<MaliciousPackage | null> {
  return readReferenceEntry(
    'malicious',
    `${ecosystem}\0${canonicalPackageName(ecosystem, name)}`,
    () => findMaliciousEntry(db, ecosystem, name),
    opts
  );
}

export async function isMaliciousPackage(
  db: DataSource,
  ecosystem: string,
  name: string,
  version?: string
): Promise<{ blocked: boolean; reason?: string; overrideStatus?: string }> {
  return maliciousMatch(await findMaliciousEntry(db, ecosystem, name), version);
}

const BACKFILL_CHUNK = 5000;

/** Rows written before `lookup_name` existed. Idempotent; a no-op once every row has one. */
export async function backfillMaliciousLookupNames(db: Pick<DataSource, 'query'>): Promise<number> {
  let filled = 0;
  for (;;) {
    const rows = asRows(
      await db.query(`SELECT id, name, ecosystem FROM malicious_packages WHERE lookup_name IS NULL LIMIT $1`, [
        BACKFILL_CHUNK,
      ])
    ) as { id: string; name: string; ecosystem: string }[];
    if (rows.length === 0) return filled;
    await db.query(
      `UPDATE malicious_packages AS m SET lookup_name = v.lookup_name
       FROM unnest($1::uuid[], $2::varchar[]) AS v(id, lookup_name)
       WHERE m.id = v.id`,
      [rows.map((row) => row.id), rows.map((row) => canonicalPackageName(row.ecosystem, row.name))]
    );
    filled += rows.length;
  }
}
