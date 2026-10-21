import { describe, expect, it } from 'vitest';
import {
  appendSnapshot,
  assertManifest,
  decideSync,
  resolveFeedFile,
  selectChangeOps,
  sha256Hex,
  type Manifest,
  type SnapshotRecord,
} from './malicious-feed.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const generatedAt = '2026-10-02T07:42:35Z';
const changesSince = '2026-10-02T05:38:49Z';

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: '2.0.0',
    generated_at: generatedAt,
    upstream_repo: 'https://github.com/ossf/malicious-packages.git',
    upstream_commit: 'abc',
    changes_since: changesSince,
    changes_window_days: 180,
    shard_max_bytes: 26214400,
    total_records: 1,
    ecosystems: {
      npm: {
        files: [{ file: 'npm.jsonl', sha256: 'aa', bytes: 1, records: 1 }],
        records: 1,
        bytes: 1,
        changes_file: 'npm.changes.jsonl',
        changes_sha256: 'bb',
        changes_bytes: 0,
        changes_records: 0,
        max_modified: generatedAt,
      },
    },
    ...overrides,
  };
}

describe('decideSync', () => {
  const feed = manifest();

  it('full-loads when there is no watermark', () => {
    expect(decideSync(feed, null)).toBe('full');
  });

  it('full-loads when the watermark is older than changes_since', () => {
    expect(decideSync(feed, '2026-01-01T00:00:00Z')).toBe('full');
  });

  it('does nothing when the watermark matches generated_at', () => {
    expect(decideSync(feed, generatedAt)).toBe('none');
  });

  it('does nothing when the watermark is ahead of generated_at', () => {
    expect(decideSync(feed, '2026-10-03T00:00:00Z')).toBe('none');
  });

  it('applies changes when the watermark is inside the window', () => {
    expect(decideSync(feed, '2026-10-02T06:00:00Z')).toBe('changes');
  });
});

describe('selectChangeOps', () => {
  const body = [
    '{"op":"upsert","modified":"2026-10-02T07:42:35Z","name":"embiggen","id":"MAL-1"}',
    '{"op":"delete","modified":"2026-10-02T06:30:00Z","name":"gone"}',
    '{"op":"upsert","modified":"2026-10-02T05:38:49Z","name":"already"}',
    '{"op":"delete","modified":"2026-10-02T05:00:00Z","name":"older"}',
  ].join('\n');

  it('stops at the first op already covered by the watermark', () => {
    const ops = selectChangeOps(body, '2026-10-02T06:00:00Z');
    expect(ops.map((op) => op.name)).toEqual(['embiggen', 'gone']);
    expect(ops[0]).toMatchObject({ op: 'upsert', id: 'MAL-1' });
    expect(ops[1]).toMatchObject({ op: 'delete' });
  });

  it('returns every op when the watermark is older than all of them', () => {
    expect(selectChangeOps(body, '2026-10-02T04:00:00Z')).toHaveLength(4);
  });

  it('returns nothing when the newest op is already applied', () => {
    expect(selectChangeOps(body, generatedAt)).toEqual([]);
  });

  it('rejects a malformed line', () => {
    expect(() => selectChangeOps('{"op":', generatedAt)).toThrow(/malformed/);
  });
});

describe('assertManifest', () => {
  it('accepts schema 2.x', () => {
    expect(assertManifest(manifest()).schema_version).toBe('2.0.0');
  });

  it('rejects an unsupported major version', () => {
    expect(() => assertManifest(manifest({ schema_version: '3.0.0' }))).toThrow(/Unsupported schema_version 3.0.0/);
  });

  it('rejects a manifest without changes_since', () => {
    expect(() => assertManifest(manifest({ changes_since: '' }))).toThrow(/changes_since/);
  });

  it('rejects an ecosystem with no snapshot files', () => {
    const feed = manifest();
    feed.ecosystems.npm.files = [];
    expect(() => assertManifest(feed)).toThrow(/npm: manifest has no files/);
  });
});

describe('appendSnapshot', () => {
  it('loads a shard larger than the spread argument limit', () => {
    const count = 150_000;
    const body = `${'{"name":"pkg","id":"MAL-1"}\n'.repeat(count)}`;
    const records: SnapshotRecord[] = [];
    appendSnapshot(records, body);
    expect(records).toHaveLength(count);
    expect(records[0]).toEqual({ name: 'pkg', id: 'MAL-1' });
    expect(records[count - 1]).toEqual({ name: 'pkg', id: 'MAL-1' });
  });
});

describe('feed file paths', () => {
  it('hashes file bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('rejects a snapshot name that leaves the extract directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'depgate-feed-'));
    expect(() => resolveFeedFile(root, '../secret')).toThrow(/Unsafe feed path/);
    expect(() => resolveFeedFile(root, '/etc/passwd')).toThrow(/Unsafe feed path/);
  });
});
