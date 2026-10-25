import { createHash } from 'crypto';
import path from 'path';
import { STORED_VERSION_MAX_LENGTH, versionSpecError } from './version-range.js';

/** Ecosystems DepGate imports. VS Code feeds are ignored. */
export const SYNC_ECOSYSTEMS = [
  'npm',
  'pypi',
  'go',
  'maven',
  'nuget',
  'crates.io',
  'rubygems',
] as const;

/** Previously imported; removed on a full load. */
export const DROPPED_ECOSYSTEMS = ['vscode', 'vscode:open-vsx.org'] as const;

export const SUPPORTED_SCHEMA_MAJOR = 2;
export const FEED_STATE_ID = 'default';

export type SyncMode = 'full' | 'none' | 'changes';

export type ManifestFile = {
  file: string;
  sha256: string;
  bytes: number;
  records: number;
};

export type ManifestEcosystem = {
  files: ManifestFile[];
  records: number;
  bytes: number;
  changes_file: string;
  changes_sha256: string;
  changes_bytes: number;
  changes_records: number;
  max_modified: string | null;
};

export type Manifest = {
  schema_version: string;
  generated_at: string;
  upstream_repo: string | null;
  upstream_commit: string | null;
  changes_since: string;
  changes_window_days: number;
  shard_max_bytes: number;
  total_records: number;
  ecosystems: Record<string, ManifestEcosystem>;
};

export type SnapshotRecord = {
  name: string;
  id?: string;
  /** Present when the feed pins specific malicious releases; omitted means every version. */
  versions?: string[];
};

export type ChangeOp = {
  op: 'upsert' | 'delete';
  modified: string;
  name: string;
  id?: string;
  versions?: string[];
};

/** Parse the feed `versions` field; absent means all versions, present must be a string array. */
export function parseFeedVersions(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error('Feed versions must be an array of strings');
  }
  return value;
}

const VERSION_ORDER = new Intl.Collator('en', { numeric: true });

/**
 * Map a feed `versions` list to the stored version_range syntax.
 * Omitted or empty `versions` means every release is malicious (null range). A list that does
 * not fit the column or holds a version the range syntax cannot express also blocks every
 * release: dropping part of the list would let those malicious versions through.
 */
export function feedVersionsToRange(ecosystem: string, versions: string[] | undefined): string | null {
  const unique = [...new Set((versions ?? []).map((v) => v.trim()))].sort(VERSION_ORDER.compare);
  if (unique.length === 0 || unique.includes('')) return null;
  const spec = unique.map((v) => `=${v}`).join('||');
  return versionSpecError(spec, [ecosystem], STORED_VERSION_MAX_LENGTH) == null ? spec : null;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Same decision as the reference client:
 * no watermark, or watermark < changes_since -> full
 * watermark >= generated_at -> nothing
 * otherwise -> changes
 */
export function decideSync(manifest: Manifest, watermark: string | null): SyncMode {
  if (watermark == null || watermark < manifest.changes_since) return 'full';
  if (watermark >= manifest.generated_at) return 'none';
  return 'changes';
}

export function assertManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object') throw new Error('Manifest is not an object');
  const manifest = value as Manifest;
  if (typeof manifest.schema_version !== 'string' || !manifest.schema_version) {
    throw new Error('Manifest has no schema_version');
  }
  const major = Number(manifest.schema_version.split('.')[0]);
  if (major !== SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(
      `Unsupported schema_version ${manifest.schema_version}; this client understands ${SUPPORTED_SCHEMA_MAJOR}.x`
    );
  }
  if (typeof manifest.generated_at !== 'string' || !manifest.generated_at) {
    throw new Error('Manifest has no generated_at');
  }
  if (typeof manifest.changes_since !== 'string' || !manifest.changes_since) {
    throw new Error('Manifest has no changes_since');
  }
  if (!manifest.ecosystems || typeof manifest.ecosystems !== 'object') {
    throw new Error('Manifest has no ecosystems');
  }
  for (const [eco, entry] of Object.entries(manifest.ecosystems)) {
    if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`${eco}: manifest has no files[]`);
    }
    for (const file of entry.files) {
      if (!file?.file || !file.sha256) throw new Error(`${eco}: snapshot file is missing file or sha256`);
    }
    if (!entry.changes_file || !entry.changes_sha256) {
      throw new Error(`${eco}: manifest has no changes file`);
    }
  }
  return manifest;
}

export function parseSnapshot(content: string): SnapshotRecord[] {
  const rows: SnapshotRecord[] = [];
  appendSnapshot(rows, content);
  return rows;
}

/** Append parsed rows one at a time. Spreading a shard into push() overflows the stack (npm is ~200k rows). */
export function appendSnapshot(target: SnapshotRecord[], content: string): void {
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { name?: string; id?: string; versions?: unknown };
      if (!obj?.name) continue;
      let versions: string[] | undefined;
      try {
        versions = parseFeedVersions(obj.versions);
      } catch {
        continue;
      }
      target.push({ name: obj.name, id: obj.id, versions });
    } catch {
      /* skip malformed snapshot line */
    }
  }
}

/** Read a changes file newest-first and stop at the first op already covered by the watermark. */
export function selectChangeOps(content: string, watermark: string): ChangeOp[] {
  const ops: ChangeOp[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let raw: ChangeOp & { versions?: unknown };
    try {
      raw = JSON.parse(line) as ChangeOp & { versions?: unknown };
    } catch {
      throw new Error('Changes file has a malformed JSON line');
    }
    if (typeof raw.modified !== 'string') throw new Error('Change op is missing modified');
    if (raw.modified <= watermark) break;
    if (raw.op !== 'upsert' && raw.op !== 'delete') throw new Error(`Unknown change op: ${String(raw.op)}`);
    if (!raw.name) throw new Error('Change op is missing name');
    let versions: string[] | undefined;
    if (raw.op === 'upsert') {
      try {
        versions = parseFeedVersions(raw.versions);
      } catch {
        throw new Error('Change upsert has invalid versions');
      }
    }
    ops.push({ op: raw.op, modified: raw.modified, name: raw.name, id: raw.id, versions });
  }
  return ops;
}

export function verifySha256(file: string, content: Buffer, expected: string): void {
  const actual = sha256Hex(content);
  if (actual !== expected) throw new Error(`${file}: sha256 does not match manifest`);
}

export function trackedRecordCount(manifest: Manifest): number {
  let total = 0;
  for (const ecosystem of SYNC_ECOSYSTEMS) {
    total += manifest.ecosystems[ecosystem]?.records ?? 0;
  }
  return total;
}

/** Manifest file names are a single path segment. Reject anything that could escape the extract dir. */
export function resolveFeedFile(root: string, file: string): string {
  if (!file || file.includes('..') || file.includes('/') || file.includes('\\') || path.isAbsolute(file)) {
    throw new Error(`Unsafe feed path: ${file}`);
  }
  const base = path.resolve(root);
  const full = path.resolve(base, file);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Unsafe feed path: ${file}`);
  }
  return full;
}
