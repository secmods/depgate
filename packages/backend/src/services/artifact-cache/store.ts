import fsp, { type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { setImmediate as nextTick } from 'node:timers/promises';
import {
  CACHE_ECOSYSTEMS,
  KEY_PATTERN,
  LAYOUT_VERSION,
  META_PATTERN,
  locate,
  packageDir,
  sameVersion,
  type ArtifactRef,
  type CacheEcosystem,
  type EntryLocation,
} from './layout.js';
import { FillStream, type FillOutcome } from './fill-stream.js';
import {
  artifactCacheEvictedTotal,
  artifactCacheFiles,
  artifactCacheRequestsTotal,
  artifactCacheSizeBytes,
  type CacheResult,
  type EvictionReason,
} from './metrics.js';

export type CacheState = 'ok' | 'off' | 'error';

export type CacheLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type ArtifactCacheOptions = {
  enabled: boolean;
  dir: string;
  maxSizeBytes: number;
  maxFiles: number;
  /** 0 turns expiry by age off. */
  maxAgeMs: number;
  /** 0 turns expiry by idle time off. */
  maxIdleMs: number;
  maxFileBytes: number;
  /** Name in the status table; the host name by default. */
  podName?: string;
  evictIntervalMs?: number;
  /** A hit updates its last access at most this often. */
  touchIntervalMs?: number;
  log?: CacheLog;
  now?: () => number;
  /** Free space on the cache's file system; tests replace it. */
  statfs?: (dir: string) => Promise<{ bavail: number; bsize: number; blocks: number }>;
};

/** What Settings can change at runtime; the environment gives the starting values. */
export type CacheLimits = Pick<ArtifactCacheOptions, 'maxSizeBytes' | 'maxFiles' | 'maxAgeMs' | 'maxIdleMs' | 'maxFileBytes'>;

/** The `.json` next to each file. Its mtime is the file's last access. */
export type EntryMeta = {
  ecosystem: CacheEcosystem;
  remoteId: string;
  remoteKey: string;
  package: string;
  version: string;
  size: number;
  sha256: string;
  contentType: string;
  storedAt: string;
};

export type CacheHit = { stream: Readable; size: number; contentType: string; meta: EntryMeta };

export type FillResult = { body: Readable; result: 'MISS' | 'BYPASS' };

export type PurgeTarget = { all: true } | { ecosystem: CacheEcosystem; packageName: string; version?: string | null };

export type PurgeResult = { files: number; bytes: number };

export type EvictionResult = { expired: number; leastRecentlyUsed: number; orphans: number };

export type CacheStats = {
  pod: string;
  state: CacheState;
  /** Switched on, by the environment or in Settings. */
  enabled: boolean;
  /** ARTIFACT_CACHE_MAX_SIZE_GB is set on this pod: it can be switched on. */
  available: boolean;
  lastError: string | null;
  sizeBytes: number;
  /** The size limit in force: the configured one, or less when the disk has less free space. */
  maxSizeBytes: number;
  limitedByDisk: boolean;
  files: number;
  maxFiles: number;
  hits24h: number;
  misses24h: number;
};

const HOUR_MS = 3_600_000;
const DEFAULT_EVICT_INTERVAL_MS = 10 * 60_000;
/** Eviction starts at this share of a limit, and frees space down to the second. */
const HIGH_WATER = 0.95;
const LOW_WATER = 0.9;
/** Free space the cache leaves on its file system: 5 % of it, at most 10 GB. */
const DISK_RESERVE_SHARE = 0.05;
const DISK_RESERVE_MAX_BYTES = 10 * 1024 ** 3;
const DISK_REFRESH_MS = 60_000;
/** Deletes between short pauses, so eviction does not hold the disk while downloads wait. */
const DELETE_BATCH = 100;
const WRITE_ERROR_LOG_INTERVAL_MS = 60_000;
/**
 * An unpaired file younger than this is left alone: a fill renames its data file before it writes the `.json`,
 * and the walk lists a directory before it looks at each entry, so a fresh orphan may be a commit in progress.
 */
const ORPHAN_GRACE_MS = 60_000;

const NO_EVICTION: EvictionResult = { expired: 0, leastRecentlyUsed: 0, orphans: 0 };

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The subdirectory names of `dir`, sorted, so a walk visits package directories in a known order. */
async function subdirectories(dir: string): Promise<string[]> {
  const names: string[] = [];
  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch {
    return names;
  }
  try {
    for await (const entry of handle) if (entry.isDirectory()) names.push(entry.name);
  } catch {
    /* removed while walking */
  }
  return names.sort();
}

type WalkEntry = { key: string; dataPath: string; metaPath: string; hasData: boolean; hasMeta: boolean };
/** Where an entry sits in a walk: ecosystem order, then its prefix and hash directories, then its key. */
type Place = { eco: number; prefix: string; hash: string; key: string };
/**
 * A recount in progress: what the walk has listed so far (the prefixes of ecosystem `eco`, the package
 * directories of `prefix`, the `entries` of `pkg`, the last one read, and which of them it has `counted`), and
 * the commits and removals the walk can no longer see, which are added to its count when it ends.
 */
type Recount = {
  eco: number;
  prefixes: Set<string>;
  prefix: string;
  pkgs: Set<string>;
  pkg: string;
  entries: Set<string>;
  counted: Set<string>;
  bytes: number;
  files: number;
};
type Candidate = { metaPath: string; dataPath: string; size: number; lastAccess: number };

/**
 * The least recently used entries that together free `needBytes` and `needFiles`, and no more: a max-heap by
 * last access drops the newest candidate whenever the rest still cover both. Memory follows what must be freed.
 */
class OldestEntries {
  private heap: Candidate[] = [];
  private bytes = 0;

  constructor(
    private readonly needBytes: number,
    private readonly needFiles: number
  ) {}

  offer(candidate: Candidate): void {
    if (this.covered(this.bytes, this.heap.length) && candidate.lastAccess >= this.heap[0].lastAccess) return;
    this.push(candidate);
    while (this.heap.length > 0 && this.covered(this.bytes - this.heap[0].size, this.heap.length - 1)) this.pop();
  }

  oldestFirst(): Candidate[] {
    return [...this.heap].sort((a, b) => a.lastAccess - b.lastAccess);
  }

  private covered(bytes: number, files: number): boolean {
    return bytes >= this.needBytes && files >= this.needFiles;
  }

  private push(item: Candidate): void {
    const heap = this.heap;
    heap.push(item);
    this.bytes += item.size;
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].lastAccess >= heap[i].lastAccess) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  private pop(): void {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop()!;
    this.bytes -= top.size;
    if (heap.length === 0) return;
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let largest = i;
      if (l < heap.length && heap[l].lastAccess > heap[largest].lastAccess) largest = l;
      if (r < heap.length && heap[r].lastAccess > heap[largest].lastAccess) largest = r;
      if (largest === i) break;
      [heap[largest], heap[i]] = [heap[i], heap[largest]];
      i = largest;
    }
  }
}

/**
 * One pod's artifact cache on local disk (requirements_artifact_cache.md §4–§8). Every failure falls back to
 * the upstream fetch: a method that cannot use the disk answers "miss" or "bypass", never an error.
 */
export class ArtifactCache {
  readonly podName: string;
  /** Tells this process's own purge messages apart from other pods'. */
  readonly instanceId = randomUUID();
  readonly root: string;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private _state: CacheState = 'off';
  private _lastError: string | null = null;
  private wanted = false;
  private directoryReady = false;
  private directoryError: string | null = null;
  private limits: CacheLimits;
  /** Cache bytes plus the free space above the reserve, last time the disk was read. Null before that. */
  private diskCapBytes: number | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private totals = { bytes: 0, files: 0 };
  private readonly filling = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private evicting: Promise<EvictionResult> | null = null;
  private evictTimer: NodeJS.Timeout | null = null;
  private closing = false;
  /** Bumped by a full purge, so a walk that started before it does not restore the old totals. */
  private generation = 0;
  private recount: Recount | null = null;
  private readonly hourly: Array<{ hour: number; hits: number; misses: number }> = Array.from({ length: 24 }, () => ({
    hour: -1,
    hits: 0,
    misses: 0,
  }));
  private lastWriteErrorLog = 0;

  constructor(readonly opts: ArtifactCacheOptions) {
    this.root = path.resolve(opts.dir);
    this.tmpDir = path.join(this.root, 'tmp');
    this.podName = opts.podName || os.hostname();
    this.now = opts.now ?? Date.now;
    const { maxSizeBytes, maxFiles, maxAgeMs, maxIdleMs, maxFileBytes } = opts;
    this.limits = { maxSizeBytes, maxFiles, maxAgeMs, maxIdleMs, maxFileBytes };
  }

  get currentLimits(): CacheLimits {
    return { ...this.limits };
  }

  /**
   * Limits changed in Settings. A lower limit starts an eviction at once; a shorter expiry applies to the next
   * lookup and eviction. A cache that was switched on without a size starts working once it has one.
   */
  async setLimits(next: CacheLimits): Promise<void> {
    const changed = (Object.keys(next) as Array<keyof CacheLimits>).some((field) => next[field] !== this.limits[field]);
    if (!changed) return;
    this.limits = { ...next };
    if (this.wanted && !this.directoryReady) await this.prepareDirectory();
    this.applyState();
    if (this.directoryReady) {
      await this.refreshDiskSpace();
      this.triggerEviction();
    }
  }

  /** The size limit in force: never more than the cache plus the disk's free space above a reserve. */
  private maxSize(): number {
    return this.diskCapBytes === null ? this.limits.maxSizeBytes : Math.min(this.limits.maxSizeBytes, this.diskCapBytes);
  }

  private async refreshDiskSpace(): Promise<void> {
    try {
      const fs = await (this.opts.statfs ?? fsp.statfs)(this.root);
      const total = fs.blocks * fs.bsize;
      const reserve = Math.min(DISK_RESERVE_MAX_BYTES, total * DISK_RESERVE_SHARE);
      this.diskCapBytes = Math.max(0, Math.floor(this.totals.bytes + fs.bavail * fs.bsize - reserve));
    } catch {
      this.diskCapBytes = null;
    }
  }

  get state(): CacheState {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  isActive(): boolean {
    return this._state === 'ok';
  }

  /** A size limit is set, in Settings or ARTIFACT_CACHE_MAX_SIZE_GB, so the cache may be switched on. */
  get available(): boolean {
    return this.limits.maxSizeBytes > 0;
  }

  /** Switched on, by the environment or in Settings, whether or not the directory works. */
  get enabled(): boolean {
    return this.wanted;
  }

  /**
   * Prepares the directory when the pod has disk for the cache, and serves at once if it is switched on.
   * Leftover temp files and unpaired files are removed in the background (L5), by the first eviction walk,
   * which also counts what the cache holds.
   */
  async start(): Promise<void> {
    this.wanted = this.opts.enabled;
    await this.prepareDirectory();
    this.applyState();
  }

  /**
   * Switches the cache on or off at runtime (Settings → Artifact cache). Off stops hits and fills; stored files
   * stay on disk, expire as usual and can still be purged. On retries a directory that could not be used before.
   */
  async setEnabled(on: boolean): Promise<void> {
    const before = this._state;
    this.wanted = on;
    if (on && !this.directoryReady) await this.prepareDirectory();
    this.applyState();
    if (this._state !== before) this.opts.log?.info({ state: this._state }, `Artifact cache ${on ? 'switched on' : 'switched off'}`);
  }

  private applyState(): void {
    if (!this.wanted) {
      this._state = 'off';
      this._lastError = null;
      return;
    }
    if (!this.available) {
      this._state = 'off';
      this._lastError = 'Switched on, but no size per pod is set (Settings or ARTIFACT_CACHE_MAX_SIZE_GB)';
      return;
    }
    const before = this._state;
    this._state = this.directoryReady ? 'ok' : 'error';
    if (this.directoryReady) {
      if (before !== 'ok') this._lastError = null;
      return;
    }
    this._lastError = this.directoryError;
    if (before !== 'error') this.opts.log?.error({ dir: this.root }, `Artifact cache is off: ${this.directoryError}`);
  }

  private async prepareDirectory(): Promise<void> {
    let leftovers: string[];
    try {
      const stat = await fsp.stat(this.root).catch((err: unknown) => {
        throw new Error(errorCode(err) === 'ENOENT' ? 'the directory does not exist' : message(err));
      });
      if (!stat.isDirectory()) throw new Error('it is not a directory');
      await fsp.mkdir(this.tmpDir, { recursive: true });
      await fsp.mkdir(path.join(this.root, LAYOUT_VERSION), { recursive: true });
      const probe = path.join(this.tmpDir, `.probe-${randomUUID()}`);
      const handle = await fsp.open(probe, 'wx', 0o600);
      try {
        await handle.writeFile('ok');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.unlink(probe);
      leftovers = await fsp.readdir(this.tmpDir);
    } catch (err) {
      this.directoryError = `ARTIFACT_CACHE_DIR ${this.root} cannot be used: ${message(err)}`;
      return;
    }
    this.directoryReady = true;
    this.directoryError = null;
    await this.refreshDiskSpace();
    this.track(this.startupCleanup(leftovers));
    this.evictTimer = setInterval(() => void this.evict(), this.opts.evictIntervalMs ?? DEFAULT_EVICT_INTERVAL_MS);
    this.evictTimer.unref();
    this.diskTimer = setInterval(() => void this.refreshDiskSpace(), DISK_REFRESH_MS);
    this.diskTimer.unref();
  }

  /** SIGTERM: no new fills (K2). Fills in progress may finish; their temp files are removed at the next start otherwise. */
  async close(): Promise<void> {
    this.closing = true;
    if (this.evictTimer) clearInterval(this.evictTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.evictTimer = null;
    this.diskTimer = null;
    await this.evicting?.catch(() => undefined);
  }

  /** Resolves when no fill, eviction or background deletion is running. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  stats(): CacheStats {
    const since = Math.floor(this.now() / HOUR_MS) - 23;
    let hits = 0;
    let misses = 0;
    for (const bucket of this.hourly) {
      if (bucket.hour < since) continue;
      hits += bucket.hits;
      misses += bucket.misses;
    }
    return {
      pod: this.podName,
      state: this._state,
      enabled: this.wanted,
      available: this.available,
      lastError: this._lastError,
      sizeBytes: this.totals.bytes,
      maxSizeBytes: this.maxSize(),
      limitedByDisk: this.maxSize() < this.limits.maxSizeBytes,
      files: this.totals.files,
      maxFiles: this.limits.maxFiles,
      hits24h: hits,
      misses24h: misses,
    };
  }

  /** Counts a download that did not consult the cache (no known public remote, or a file type it never keeps). */
  countBypass(ecosystem: string): void {
    this.count(ecosystem, 'bypass');
  }

  /** L3: the stored file, opened, or null for a miss. An expired, incomplete or unreadable entry is a miss. */
  async lookup(ref: ArtifactRef): Promise<CacheHit | null> {
    if (!this.accepts(ref)) return null;
    const loc = locate(this.root, ref);
    let meta: EntryMeta | null;
    let metaStat: Stats;
    try {
      [meta, metaStat] = await Promise.all([this.readMeta(loc.metaPath), fsp.stat(loc.metaPath)]);
    } catch {
      return null;
    }
    const place = this.placeOf(ref.ecosystem, loc.packageDir, loc.key);
    if (!meta) {
      await this.removeEntry(loc.metaPath, loc.dataPath, 0, null, place);
      return null;
    }
    const now = this.now();
    const expired = this.expiryReason(Date.parse(meta.storedAt), metaStat.mtimeMs, now);
    if (expired) {
      await this.removeEntry(loc.metaPath, loc.dataPath, meta.size, expired, place);
      return null;
    }
    let handle: FileHandle;
    try {
      handle = await fsp.open(loc.dataPath, 'r');
    } catch (err) {
      if (errorCode(err) === 'ENOENT') await this.removeEntry(loc.metaPath, loc.dataPath, meta.size, null, place);
      return null;
    }
    try {
      const stat = await handle.stat();
      if (stat.size !== meta.size) {
        await handle.close();
        await this.removeEntry(loc.metaPath, loc.dataPath, meta.size, null, place);
        return null;
      }
    } catch {
      await handle.close().catch(() => undefined);
      return null;
    }
    // L4: last access moves at most once per interval, and the hit does not wait for it.
    if (now - metaStat.mtimeMs >= (this.opts.touchIntervalMs ?? HOUR_MS)) {
      const at = new Date(now);
      fsp.utimes(loc.metaPath, at, at).catch(() => undefined);
    }
    this.count(ref.ecosystem, 'hit');
    return { stream: handle.createReadStream(), size: meta.size, contentType: meta.contentType, meta };
  }

  /**
   * W1–W4: streams `body` to the client and, when the file may be stored, to a temp file at the same time.
   * The returned body is what the client reads; the commit happens after it ends, never while it waits.
   */
  async fill(ref: ArtifactRef, body: Readable, info: { contentType: string; contentLength: number | null }): Promise<FillResult> {
    let stream: FillStream | null = null;
    // Before the first await: an upstream body from fetch can fail while the temp file opens, and an error
    // with no listener would be an uncaught exception.
    body.on('error', (err) => stream?.destroy(err));
    const bypass = (): FillResult => {
      this.count(ref.ecosystem, 'bypass');
      return { body, result: 'BYPASS' };
    };
    if (!this.accepts(ref) || this.closing) return bypass();
    if (info.contentLength !== null && info.contentLength > this.limits.maxFileBytes) return bypass();
    const loc = locate(this.root, ref);
    if (this.filling.has(loc.key)) return bypass();
    if (!this.hasRoom(info.contentLength ?? 0)) {
      this.triggerEviction();
      return bypass();
    }
    this.filling.add(loc.key);
    const tmpPath = path.join(this.tmpDir, randomUUID());
    let handle: FileHandle;
    try {
      handle = await fsp.open(tmpPath, 'wx', 0o640);
    } catch (err) {
      this.filling.delete(loc.key);
      this.writeFailed(err);
      return bypass();
    }
    if (body.destroyed) {
      await this.discard(tmpPath, handle);
      this.filling.delete(loc.key);
      return bypass();
    }
    const fill = new FillStream(handle, this.limits.maxFileBytes);
    stream = fill;
    const settled = new Promise<void>((resolve) => {
      fill.onSettled = (outcome) => {
        void this.commit(ref, loc, tmpPath, handle, outcome, info).finally(() => {
          this.filling.delete(loc.key);
          resolve();
        });
      };
    });
    this.track(settled);
    // A client that disconnects destroys the fill, which stops the upstream body and discards the temp file (W2).
    fill.on('close', () => {
      if (!body.destroyed) body.destroy();
    });
    body.pipe(fill);
    this.count(ref.ecosystem, 'miss');
    return { body: fill, result: 'MISS' };
  }

  /** P1: one package (every version, or one), or everything. Runs on this pod's disk only, switched on or off. */
  async purge(target: PurgeTarget): Promise<PurgeResult> {
    if (!this.directoryReady) return { files: 0, bytes: 0 };
    if ('all' in target) return this.purgeAll();
    const dir = packageDir(this.root, target.ecosystem, target.packageName);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return { files: 0, bytes: 0 };
    }
    const result = { files: 0, bytes: 0 };
    for (const name of names) {
      if (!META_PATTERN.test(name)) continue;
      const metaPath = path.join(dir, name);
      const dataPath = metaPath.slice(0, -'.json'.length);
      const place = this.placeOf(target.ecosystem, dir, name.slice(0, 64));
      const meta = await this.readMeta(metaPath).catch(() => null);
      if (target.version && (!meta || !sameVersion(target.ecosystem, meta.version, target.version))) continue;
      const size = meta?.size ?? (await fsp.stat(dataPath).catch(() => null))?.size ?? 0;
      if (await this.removeEntry(metaPath, dataPath, size, 'purge', place)) {
        result.files += 1;
        result.bytes += size;
      }
    }
    if (!target.version) {
      for (const name of names) {
        if (KEY_PATTERN.test(name) && !this.filling.has(name)) await fsp.unlink(path.join(dir, name)).catch(() => undefined);
      }
    }
    await fsp.rmdir(dir).catch(() => undefined);
    return result;
  }

  /**
   * X2: one eviction at a time. Expired files first, then the least recently used while a limit is at 95 %.
   * Also runs while the cache is switched off, so the files it left behind still expire.
   */
  evict(): Promise<EvictionResult> {
    if (this.evicting) return this.evicting;
    if (!this.directoryReady || this.closing) return Promise.resolve(NO_EVICTION);
    const run = this.runEviction()
      .catch((err: unknown) => {
        this.opts.log?.warn({ err: message(err) }, 'Artifact cache eviction failed');
        return NO_EVICTION;
      })
      .finally(() => {
        if (this.evicting === run) this.evicting = null;
      });
    this.evicting = run;
    this.track(run);
    return run;
  }

  /** Starts an eviction in the background unless one is running. */
  triggerEviction(): void {
    void this.evict();
  }

  private async startupCleanup(leftovers: string[]): Promise<void> {
    for (const name of leftovers) await fsp.rm(path.join(this.tmpDir, name), { recursive: true, force: true }).catch(() => undefined);
    await this.evict();
  }

  private accepts(ref: ArtifactRef): boolean {
    return this.isActive() && ref.remote.source === 'public';
  }

  private hasRoom(bytes: number): boolean {
    return this.totals.bytes + bytes <= this.maxSize() && this.totals.files + 1 <= this.limits.maxFiles;
  }

  private atHighWater(): boolean {
    return this.totals.bytes >= this.maxSize() * HIGH_WATER || this.totals.files >= this.limits.maxFiles * HIGH_WATER;
  }

  private expiryReason(storedAt: number, lastAccess: number, now: number): EvictionReason | null {
    const { maxAgeMs, maxIdleMs } = this.limits;
    if (maxAgeMs > 0 && (!Number.isFinite(storedAt) || now - storedAt >= maxAgeMs)) return 'age';
    if (maxIdleMs > 0 && now - lastAccess >= maxIdleMs) return 'idle';
    return null;
  }

  private count(ecosystem: string, result: CacheResult): void {
    artifactCacheRequestsTotal.inc({ ecosystem, result });
    const hour = Math.floor(this.now() / HOUR_MS);
    const bucket = this.hourly[hour % 24];
    if (bucket.hour !== hour) {
      bucket.hour = hour;
      bucket.hits = 0;
      bucket.misses = 0;
    }
    if (result === 'hit') bucket.hits += 1;
    else bucket.misses += 1;
  }

  private track<T>(promise: Promise<T>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
  }

  private updateGauges(): void {
    artifactCacheSizeBytes.set(this.totals.bytes);
    artifactCacheFiles.set(this.totals.files);
  }

  private placeOf(ecosystem: CacheEcosystem, dir: string, key: string): Place {
    return { eco: CACHE_ECOSYSTEMS.indexOf(ecosystem), prefix: path.basename(path.dirname(dir)), hash: path.basename(dir), key };
  }

  /**
   * Whether the walk that is recounting has gone past `place`: it counted that entry already, or it listed the
   * entry's directory (or a parent) without it, so it will never see it. What it will still read is not behind.
   */
  private behindWalk(place: Place): boolean {
    const r = this.recount;
    if (!r) return false;
    if (place.eco !== r.eco) return place.eco < r.eco;
    if (!r.prefixes.has(place.prefix)) return true;
    if (place.prefix !== r.prefix) return place.prefix < r.prefix;
    if (!r.pkgs.has(place.hash)) return true;
    if (place.hash !== r.pkg) return place.hash < r.pkg;
    return r.counted.has(place.key) || !r.entries.has(place.key);
  }

  /**
   * Applies a change to the totals and, while a walk recounts them, keeps the change when the walk cannot see
   * it any more. `place` null means the walk made the change itself, so its count already leaves it out.
   */
  private adjustTotals(bytes: number, files: number, place: Place | null): void {
    this.totals.bytes = Math.max(0, this.totals.bytes + bytes);
    this.totals.files = Math.max(0, this.totals.files + files);
    this.updateGauges();
    if (place && this.recount && this.behindWalk(place)) {
      this.recount.bytes += bytes;
      this.recount.files += files;
    }
  }

  private async readMeta(metaPath: string): Promise<EntryMeta | null> {
    const raw = await fsp.readFile(metaPath, 'utf8');
    try {
      const meta = JSON.parse(raw) as EntryMeta;
      if (typeof meta?.size !== 'number' || typeof meta.storedAt !== 'string' || typeof meta.contentType !== 'string') return null;
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * Deletes the `.json` first, so a `.json` always means a complete data file. Only the caller that removed
   * the `.json` deletes the data and updates the totals, so concurrent removals count once.
   */
  private async removeEntry(
    metaPath: string,
    dataPath: string,
    size: number,
    reason: EvictionReason | null,
    place: Place | null
  ): Promise<boolean> {
    try {
      await fsp.unlink(metaPath);
    } catch {
      return false;
    }
    await fsp.unlink(dataPath).catch(() => undefined);
    this.adjustTotals(-size, -1, place);
    if (reason) artifactCacheEvictedTotal.inc({ reason });
    return true;
  }

  /**
   * W2 and L2: commit only a complete download that fits; data first, then its `.json`. With a Content-Length,
   * complete means every announced byte arrived: a client may close the connection after the last byte and
   * before the upstream's end reaches the fill. Without one, the upstream body must have ended.
   */
  private async commit(
    ref: ArtifactRef,
    loc: EntryLocation,
    tmpPath: string,
    handle: FileHandle,
    outcome: FillOutcome,
    info: { contentType: string; contentLength: number | null }
  ): Promise<void> {
    let handleOpen = true;
    let dataMoved = false;
    try {
      if (outcome.writeError) throw outcome.writeError;
      const complete = !outcome.tooLarge && (info.contentLength === null ? outcome.ended : outcome.bytes === info.contentLength);
      if (!complete) {
        await this.discard(tmpPath, handle);
        return;
      }
      if (!this.hasRoom(outcome.bytes)) {
        this.triggerEviction();
        await this.discard(tmpPath, handle);
        return;
      }
      await handle.sync();
      await handle.close();
      handleOpen = false;
      const previous = await this.readMeta(loc.metaPath).catch(() => null);
      await this.moveIntoPlace(tmpPath, loc);
      dataMoved = true;
      const meta: EntryMeta = {
        ecosystem: ref.ecosystem,
        remoteId: ref.remote.id,
        remoteKey: ref.remote.key,
        package: ref.packageName,
        version: ref.version,
        size: outcome.bytes,
        sha256: outcome.sha256,
        contentType: info.contentType,
        storedAt: new Date(this.now()).toISOString(),
      };
      await this.writeFileSynced(loc.metaPath, JSON.stringify(meta));
      this.adjustTotals(outcome.bytes - (previous?.size ?? 0), previous ? 0 : 1, this.placeOf(ref.ecosystem, loc.packageDir, loc.key));
      // The disk works again: a write error reported earlier no longer describes this pod.
      if (this._state === 'ok') this._lastError = null;
      if (this.atHighWater()) this.triggerEviction();
    } catch (err) {
      if (handleOpen) await handle.close().catch(() => undefined);
      await fsp.unlink(dataMoved ? loc.dataPath : tmpPath).catch(() => undefined);
      this.writeFailed(err);
    }
  }

  private async discard(tmpPath: string, handle: FileHandle): Promise<void> {
    await handle.close().catch(() => undefined);
    await fsp.unlink(tmpPath).catch(() => undefined);
  }

  /** An eviction may remove an empty package directory between the mkdir and the rename. */
  private async moveIntoPlace(tmpPath: string, loc: EntryLocation): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await fsp.mkdir(loc.packageDir, { recursive: true });
      try {
        await fsp.rename(tmpPath, loc.dataPath);
        return;
      } catch (err) {
        if (errorCode(err) !== 'ENOENT' || attempt >= 2) throw err;
      }
    }
  }

  private async writeFileSynced(target: string, contents: string): Promise<void> {
    const tmp = path.join(this.tmpDir, `${randomUUID()}.json`);
    const handle = await fsp.open(tmp, 'wx', 0o640);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /** X4: the download is still served. A full disk starts an eviction. */
  private writeFailed(err: unknown): void {
    const code = errorCode(err);
    if (code === 'ENOSPC' || code === 'EDQUOT') this.triggerEviction();
    this._lastError = `Write failed: ${message(err)}`;
    const now = this.now();
    if (now - this.lastWriteErrorLog >= WRITE_ERROR_LOG_INTERVAL_MS) {
      this.lastWriteErrorLog = now;
      this.opts.log?.warn({ err: message(err), code }, 'Artifact cache could not store a file; it was served without being stored');
    }
  }

  private async purgeAll(): Promise<PurgeResult> {
    const result = { files: this.totals.files, bytes: this.totals.bytes };
    this.generation += 1;
    const tree = path.join(this.root, LAYOUT_VERSION);
    const doomed = path.join(this.tmpDir, `purge-${randomUUID()}`);
    try {
      await fsp.rename(tree, doomed);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') throw err;
    }
    await fsp.mkdir(tree, { recursive: true });
    this.totals = { bytes: 0, files: 0 };
    this.updateGauges();
    if (result.files > 0) artifactCacheEvictedTotal.inc({ reason: 'purge' }, result.files);
    this.track(fsp.rm(doomed, { recursive: true, force: true }).catch(() => undefined));
    return result;
  }

  /**
   * X3: one package directory in memory at a time, ecosystems in CACHE_ECOSYSTEMS order and directories sorted.
   * Every listing is a snapshot: an entry is what its directory held when it was read, and `recount`, when set,
   * learns each listing so that changes the walk can no longer see are kept apart.
   */
  private async *walk(): AsyncGenerator<WalkEntry> {
    const tree = path.join(this.root, LAYOUT_VERSION);
    for (const [eco, ecosystem] of CACHE_ECOSYSTEMS.entries()) {
      const ecoDir = path.join(tree, ecosystem);
      const prefixes = await subdirectories(ecoDir);
      if (this.recount) Object.assign(this.recount, { eco, prefixes: new Set(prefixes), prefix: '', pkgs: new Set(), pkg: '', entries: new Set(), counted: new Set() });
      for (const prefix of prefixes) {
        if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
        const pkgs = await subdirectories(path.join(ecoDir, prefix));
        if (this.recount) Object.assign(this.recount, { prefix, pkgs: new Set(pkgs), pkg: '', entries: new Set(), counted: new Set() });
        for (const pkg of pkgs) {
          if (!KEY_PATTERN.test(pkg)) continue;
          const dir = path.join(ecoDir, prefix, pkg);
          // Listed from here on, even when the directory is gone or empty: a commit may recreate it behind the walk.
          if (this.recount) Object.assign(this.recount, { pkg, entries: new Set(), counted: new Set() });
          let names: string[];
          try {
            names = await fsp.readdir(dir);
          } catch {
            continue;
          }
          if (names.length === 0) {
            await fsp.rmdir(dir).catch(() => undefined);
            continue;
          }
          const entries = new Map<string, WalkEntry>();
          const entry = (key: string) => {
            let found = entries.get(key);
            if (!found) {
              found = { key, dataPath: path.join(dir, key), metaPath: path.join(dir, `${key}.json`), hasData: false, hasMeta: false };
              entries.set(key, found);
            }
            return found;
          };
          for (const name of names) {
            if (KEY_PATTERN.test(name)) entry(name).hasData = true;
            else if (META_PATTERN.test(name)) entry(name.slice(0, 64)).hasMeta = true;
          }
          if (this.recount) this.recount.entries = new Set(entries.keys());
          yield* entries.values();
        }
      }
    }
  }

  private async statPair(entry: WalkEntry): Promise<{ data: Stats; meta: Stats } | null> {
    try {
      const [data, meta] = await Promise.all([fsp.stat(entry.dataPath), fsp.stat(entry.metaPath)]);
      return { data, meta };
    } catch {
      return null;
    }
  }

  private async pause(deleted: number): Promise<void> {
    if (deleted > 0 && deleted % DELETE_BATCH === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    else await nextTick();
  }

  /**
   * Removes an unpaired file the walk found, unless a fill of it is in progress, it is too young to be sure it is
   * not one (ORPHAN_GRACE_MS), or its pair has appeared since the directory was listed: then it is a whole entry.
   */
  private async removeOrphan(entry: WalkEntry, now: number): Promise<'removed' | 'kept' | 'paired'> {
    if (this.filling.has(entry.key)) return 'kept';
    const target = entry.hasData ? entry.dataPath : entry.metaPath;
    const other = entry.hasData ? entry.metaPath : entry.dataPath;
    const [stat, paired] = await Promise.all([fsp.stat(target).catch(() => null), fsp.stat(other).then(() => true, () => false)]);
    if (paired) return 'paired';
    if (!stat || now - stat.mtimeMs < ORPHAN_GRACE_MS || this.filling.has(entry.key)) return 'kept';
    await fsp.unlink(target).catch(() => undefined);
    return 'removed';
  }

  private async runEviction(): Promise<EvictionResult> {
    const result: EvictionResult = { expired: 0, leastRecentlyUsed: 0, orphans: 0 };
    const generation = this.generation;
    const now = this.now();
    let bytes = 0;
    let files = 0;
    let deleted = 0;
    const recount: Recount = { eco: -1, prefixes: new Set(), prefix: '', pkgs: new Set(), pkg: '', entries: new Set(), counted: new Set(), bytes: 0, files: 0 };
    this.recount = recount;
    try {
      for await (const entry of this.walk()) {
        if (this.closing) return result;
        if (!entry.hasData || !entry.hasMeta) {
          const orphan = await this.removeOrphan(entry, now);
          if (orphan === 'removed') {
            result.orphans += 1;
            await this.pause(++deleted);
          }
          if (orphan !== 'paired') continue;
        }
        const stats = await this.statPair(entry);
        if (!stats) continue;
        // The data file is written once, so its mtime is when it was stored; the `.json` mtime is the last access.
        const reason = this.expiryReason(stats.data.mtimeMs, stats.meta.mtimeMs, now);
        if (reason) {
          if (await this.removeEntry(entry.metaPath, entry.dataPath, stats.data.size, reason, null)) result.expired += 1;
          await this.pause(++deleted);
          continue;
        }
        bytes += stats.data.size;
        files += 1;
        recount.counted.add(entry.key);
      }
    } finally {
      this.recount = null;
    }
    if (generation === this.generation) {
      // What the walk counted, plus what changed behind it while it ran.
      this.totals = { bytes: Math.max(0, bytes + recount.bytes), files: Math.max(0, files + recount.files) };
      this.updateGauges();
    }
    await this.refreshDiskSpace();
    if (this.atHighWater()) result.leastRecentlyUsed = await this.evictLeastRecentlyUsed();
    return result;
  }

  private async evictLeastRecentlyUsed(): Promise<number> {
    const targetBytes = Math.floor(this.maxSize() * LOW_WATER);
    const targetFiles = Math.floor(this.limits.maxFiles * LOW_WATER);
    const oldest = new OldestEntries(Math.max(0, this.totals.bytes - targetBytes), Math.max(0, this.totals.files - targetFiles));
    for await (const entry of this.walk()) {
      if (this.closing) return 0;
      if (!entry.hasData || !entry.hasMeta) continue;
      const stats = await this.statPair(entry);
      if (!stats) continue;
      oldest.offer({ metaPath: entry.metaPath, dataPath: entry.dataPath, size: stats.data.size, lastAccess: stats.meta.mtimeMs });
    }
    let removed = 0;
    for (const victim of oldest.oldestFirst()) {
      if (this.closing) break;
      if (this.totals.bytes <= targetBytes && this.totals.files <= targetFiles) break;
      // Read since the walk: it is no longer among the least recently used.
      const current = await fsp.stat(victim.metaPath).catch(() => null);
      if (!current || current.mtimeMs > victim.lastAccess) continue;
      const reason: EvictionReason = this.totals.bytes > targetBytes ? 'size' : 'files';
      if (await this.removeEntry(victim.metaPath, victim.dataPath, victim.size, reason, null)) removed += 1;
      await this.pause(removed);
    }
    return removed;
  }
}
