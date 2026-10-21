import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { sha256Hex, type Manifest } from './malicious-feed.js';
import {
  applyChanges,
  applySnapshot,
  executeMaliciousSync,
  isMaliciousPackage,
  type MaliciousPackageStore,
} from './malicious-sync.js';

const execFileAsync = promisify(execFile);

describe('malicious-sync isMaliciousPackage', () => {
  const findOne = vi.fn();
  const db = {
    getRepository: vi.fn(() => ({ findOne })),
  } as unknown as DataSource;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns blocked false when package is not in list', async () => {
    findOne.mockResolvedValueOnce(null);
    const res = await isMaliciousPackage(db, 'npm', 'lodash', '1.0.0');
    expect(res.blocked).toBe(false);
  });

  it('returns blocked false when override is ALLOW', async () => {
    findOne.mockResolvedValueOnce({
      name: 'requests',
      ecosystem: 'pypi',
      overrideStatus: 'ALLOW',
      versionRange: null,
    });
    const res = await isMaliciousPackage(db, 'pypi', 'requests', '2.0.0');
    expect(res.blocked).toBe(false);
  });

  it('returns blocked true when package is listed and no version range', async () => {
    findOne.mockResolvedValueOnce({
      name: 'mime',
      ecosystem: 'npm',
      reason: 'malicious',
      overrideStatus: 'BLOCK',
      versionRange: null,
    });
    const res = await isMaliciousPackage(db, 'npm', 'mime', '3.0.0');
    expect(res.blocked).toBe(true);
    expect(res.reason).toBe('malicious');
  });

  it('respects semver version range', async () => {
    findOne.mockResolvedValueOnce({
      name: 'rsc.io/quote',
      ecosystem: 'go',
      reason: 'bad range',
      overrideStatus: 'BLOCK',
      versionRange: '<2.0.0',
    });
    const hit = await isMaliciousPackage(db, 'go', 'rsc.io/quote', '1.5.2');
    const miss = await isMaliciousPackage(db, 'go', 'rsc.io/quote', '2.1.0');
    expect(hit.blocked).toBe(true);
    expect(miss.blocked).toBe(false);
  });

  it('matches non-semver versions against the ecosystem order', async () => {
    findOne.mockResolvedValueOnce({
      name: 'requests',
      ecosystem: 'pypi',
      reason: 'bad range',
      overrideStatus: 'BLOCK',
      versionRange: '<2.0.0',
    });
    const hit = await isMaliciousPackage(db, 'pypi', 'requests', '2.0.0rc1');
    expect(hit.blocked).toBe(true);
  });

  it('stays blocked when a ranged malicious entry cannot order the version', async () => {
    findOne.mockResolvedValueOnce({
      name: 'requests',
      ecosystem: 'pypi',
      reason: 'bad range',
      overrideStatus: 'BLOCK',
      versionRange: '<2.0.0',
    });
    const hit = await isMaliciousPackage(db, 'pypi', 'requests', 'not-a-version');
    expect(hit.blocked).toBe(true);
  });
});

type MemRow = {
  name: string;
  ecosystem: string;
  source: 'default' | 'custom';
  reason: string | null;
  overrideStatus: 'BLOCK' | 'ALLOW';
};

function createMemoryStore(seed: MemRow[] = []) {
  const rows = seed.map((row) => ({ ...row }));
  let watermark: string | null = null;
  let saved: Manifest | null = null;
  const store: MaliciousPackageStore = {
    async listByEcosystem(ecosystem) {
      return rows.filter((row) => row.ecosystem === ecosystem).map((row) => ({ name: row.name, source: row.source }));
    },
    async listByNames(ecosystem, names) {
      const wanted = new Set(names);
      return rows
        .filter((row) => row.ecosystem === ecosystem && wanted.has(row.name))
        .map((row) => ({ name: row.name, source: row.source }));
    },
    async insertDefault(incoming) {
      for (const row of incoming) {
        const existing = rows.find((item) => item.ecosystem === row.ecosystem && item.name === row.name);
        if (existing?.source === 'custom') continue;
        if (existing) existing.reason = row.reason;
        else rows.push({ ...row, source: 'default', overrideStatus: 'BLOCK' });
      }
    },
    async updateDefault(incoming) {
      for (const row of incoming) {
        const existing = rows.find((item) => item.ecosystem === row.ecosystem && item.name === row.name);
        if (existing?.source === 'default') existing.reason = row.reason;
      }
    },
    async deleteDefaultByName(ecosystem, names) {
      const wanted = new Set(names);
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.ecosystem === ecosystem && row.source === 'default' && wanted.has(row.name)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    async deleteDefaultByEcosystem(ecosystems) {
      const wanted = new Set(ecosystems);
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row.source === 'default' && wanted.has(row.ecosystem)) rows.splice(i, 1);
      }
      return before - rows.length;
    },
    async readWatermark() {
      return watermark;
    },
    async writeState(manifest) {
      watermark = manifest.generated_at;
      saved = manifest;
    },
  };
  return {
    store,
    rows,
    saved: () => saved,
    setWatermark: (value: string | null) => {
      watermark = value;
    },
  };
}

const FEED_URL = 'https://feed.example/malicious-packages';
const ARCHIVE_URL = 'https://feed.example/malicious-packages.tar.gz';
const GENERATED_AT = '2026-10-02T08:00:00Z';
const CHANGES_SINCE = '2026-10-02T05:00:00Z';

function npmManifest(snapshot: string, changes: string, snapshotName = 'npm.jsonl'): Manifest {
  return {
    schema_version: '2.0.0',
    generated_at: GENERATED_AT,
    upstream_repo: 'https://github.com/ossf/malicious-packages.git',
    upstream_commit: 'abc123',
    changes_since: CHANGES_SINCE,
    changes_window_days: 180,
    shard_max_bytes: 26214400,
    total_records: snapshot.split('\n').filter(Boolean).length,
    ecosystems: {
      npm: {
        files: [
          {
            file: snapshotName,
            sha256: sha256Hex(snapshot),
            bytes: Buffer.byteLength(snapshot),
            records: snapshot.split('\n').filter(Boolean).length,
          },
        ],
        records: snapshot.split('\n').filter(Boolean).length,
        bytes: Buffer.byteLength(snapshot),
        changes_file: 'npm.changes.jsonl',
        changes_sha256: sha256Hex(changes),
        changes_bytes: Buffer.byteLength(changes),
        changes_records: changes.split('\n').filter(Boolean).length,
        max_modified: GENERATED_AT,
      },
    },
  };
}

async function packArchive(manifest: Manifest, files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), 'depgate-feed-test-'));
  try {
    const dir = path.join(root, 'malicious-packages');
    await mkdir(dir);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body);
    }
    const archive = path.join(root, 'feed.tar.gz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'malicious-packages']);
    return await readFile(archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('applySnapshot', () => {
  it('inserts new rows, updates feed rows, and keeps custom overrides', async () => {
    const mem = createMemoryStore([
      { name: 'kept', ecosystem: 'npm', source: 'default', reason: 'old', overrideStatus: 'ALLOW' },
      { name: 'custom-pkg', ecosystem: 'npm', source: 'custom', reason: 'admin', overrideStatus: 'BLOCK' },
      { name: 'stale', ecosystem: 'npm', source: 'default', reason: 'gone', overrideStatus: 'BLOCK' },
    ]);

    const result = await applySnapshot(mem.store, 'npm', [
      { name: 'kept', id: 'MAL-1' },
      { name: 'fresh', id: 'MAL-2' },
      { name: 'custom-pkg', id: 'MAL-3' },
    ]);

    expect(result).toMatchObject({ added: 1, updated: 1, removed: 1, skippedCustom: 1 });
    expect(mem.rows.find((row) => row.name === 'kept')).toMatchObject({ reason: 'MAL-1', overrideStatus: 'ALLOW' });
    expect(mem.rows.find((row) => row.name === 'fresh')).toMatchObject({ source: 'default', reason: 'MAL-2' });
    expect(mem.rows.find((row) => row.name === 'custom-pkg')).toMatchObject({ source: 'custom', reason: 'admin' });
    expect(mem.rows.find((row) => row.name === 'stale')).toBeUndefined();
  });

  it('does not delete rows outside a limited snapshot', async () => {
    const mem = createMemoryStore([
      { name: 'stale', ecosystem: 'npm', source: 'default', reason: 'old', overrideStatus: 'BLOCK' },
    ]);
    const result = await applySnapshot(
      mem.store,
      'npm',
      [
        { name: 'first', id: 'MAL-1' },
        { name: 'second', id: 'MAL-2' },
      ],
      1
    );
    expect(result).toMatchObject({ added: 1, removed: 0 });
    expect(mem.rows.map((row) => row.name).sort()).toEqual(['first', 'stale']);
  });
});

describe('applyChanges', () => {
  it('upserts and deletes feed rows without touching custom rows', async () => {
    const mem = createMemoryStore([
      { name: 'old-pkg', ecosystem: 'npm', source: 'default', reason: 'MAL-0', overrideStatus: 'BLOCK' },
      { name: 'custom-pkg', ecosystem: 'npm', source: 'custom', reason: 'admin', overrideStatus: 'ALLOW' },
    ]);
    const result = await applyChanges(mem.store, 'npm', [
      { op: 'upsert', modified: '2026-10-02T07:30:00Z', name: 'custom-pkg', id: 'MAL-9' },
      { op: 'upsert', modified: '2026-10-02T07:00:00Z', name: 'new-pkg', id: 'MAL-2' },
      { op: 'delete', modified: '2026-10-02T06:30:00Z', name: 'old-pkg' },
    ]);
    expect(result).toMatchObject({ added: 1, removed: 1, skippedCustom: 1 });
    expect(mem.rows.find((row) => row.name === 'new-pkg')).toMatchObject({ reason: 'MAL-2' });
    expect(mem.rows.find((row) => row.name === 'old-pkg')).toBeUndefined();
    expect(mem.rows.find((row) => row.name === 'custom-pkg')).toMatchObject({ reason: 'admin', overrideStatus: 'ALLOW' });
  });
});

describe('executeMaliciousSync', () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  it('full-loads the release archive and stores the manifest watermark', async () => {
    const snapshot = '{"name":"embiggen","id":"MAL-1"}\n{"name":"kept","id":"MAL-2"}\n';
    const manifest = npmManifest(snapshot, '');
    const archive = await packArchive(manifest, { 'npm.jsonl': snapshot });
    const mem = createMemoryStore([
      { name: 'kept', ecosystem: 'npm', source: 'default', reason: 'old', overrideStatus: 'ALLOW' },
      { name: 'stale', ecosystem: 'npm', source: 'default', reason: 'old', overrideStatus: 'BLOCK' },
      { name: 'custom-pkg', ecosystem: 'npm', source: 'custom', reason: 'admin', overrideStatus: 'BLOCK' },
      { name: 'vs-ext', ecosystem: 'vscode', source: 'default', reason: 'old', overrideStatus: 'BLOCK' },
    ]);
    const urls: string[] = [];

    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async (url) => {
        urls.push(url);
        if (url.endsWith('/manifest.json')) return Buffer.from(JSON.stringify(manifest));
        if (url === ARCHIVE_URL) return archive;
        throw new Error(`unexpected ${url}`);
      },
    });

    expect(result.mode).toBe('full');
    expect(result).toMatchObject({ added: 1, updated: 1, removed: 2 });
    expect(urls).toEqual([`${FEED_URL}/manifest.json`, ARCHIVE_URL]);
    expect(mem.saved()?.generated_at).toBe(GENERATED_AT);
    expect(mem.rows.find((row) => row.name === 'kept')).toMatchObject({ reason: 'MAL-2', overrideStatus: 'ALLOW' });
    expect(mem.rows.find((row) => row.name === 'embiggen')).toMatchObject({ reason: 'MAL-1' });
    expect(mem.rows.find((row) => row.name === 'custom-pkg')?.source).toBe('custom');
    expect(mem.rows.find((row) => row.name === 'stale')).toBeUndefined();
    expect(mem.rows.find((row) => row.name === 'vs-ext')).toBeUndefined();
  });

  it('applies only changes newer than the watermark', async () => {
    const changes = [
      '{"op":"upsert","modified":"2026-10-02T07:30:00Z","name":"custom-pkg","id":"MAL-9"}',
      '{"op":"upsert","modified":"2026-10-02T07:00:00Z","name":"new-pkg","id":"MAL-2"}',
      '{"op":"delete","modified":"2026-10-02T06:30:00Z","name":"old-pkg"}',
      '{"op":"upsert","modified":"2026-10-02T05:00:00Z","name":"already","id":"MAL-0"}',
    ].join('\n');
    const manifest = npmManifest('', changes);
    const mem = createMemoryStore([
      { name: 'old-pkg', ecosystem: 'npm', source: 'default', reason: 'MAL-0', overrideStatus: 'BLOCK' },
      { name: 'custom-pkg', ecosystem: 'npm', source: 'custom', reason: 'admin', overrideStatus: 'ALLOW' },
    ]);
    mem.setWatermark('2026-10-02T06:00:00Z');
    const urls: string[] = [];

    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async (url) => {
        urls.push(url);
        if (url.endsWith('/manifest.json')) return Buffer.from(JSON.stringify(manifest));
        if (url.endsWith('/npm.changes.jsonl')) return Buffer.from(changes);
        throw new Error(`unexpected ${url}`);
      },
    });

    expect(result.mode).toBe('changes');
    expect(urls).toEqual([`${FEED_URL}/manifest.json`, `${FEED_URL}/npm.changes.jsonl`]);
    expect(mem.rows.map((row) => row.name).sort()).toEqual(['custom-pkg', 'new-pkg']);
    expect(mem.rows.find((row) => row.name === 'custom-pkg')).toMatchObject({ reason: 'admin', overrideStatus: 'ALLOW' });
    expect(mem.saved()?.generated_at).toBe(GENERATED_AT);
    expect(mem.saved()?.upstream_commit).toBe('abc123');
  });

  it('downloads only the manifest when the watermark is current', async () => {
    const manifest = npmManifest('', '');
    const mem = createMemoryStore();
    mem.setWatermark(GENERATED_AT);
    const urls: string[] = [];

    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async (url) => {
        urls.push(url);
        return Buffer.from(JSON.stringify(manifest));
      },
    });

    expect(result).toMatchObject({ mode: 'none', added: 0, removed: 0 });
    expect(urls).toEqual([`${FEED_URL}/manifest.json`]);
    expect(mem.saved()).toBeNull();
  });

  it('full-loads again when the watermark is older than changes_since', async () => {
    const snapshot = '{"name":"embiggen","id":"MAL-1"}\n';
    const manifest = npmManifest(snapshot, '');
    const archive = await packArchive(manifest, { 'npm.jsonl': snapshot });
    const mem = createMemoryStore();
    mem.setWatermark('2026-01-01T00:00:00Z');
    const urls: string[] = [];

    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async (url) => {
        urls.push(url);
        if (url.endsWith('/manifest.json')) return Buffer.from(JSON.stringify(manifest));
        if (url === ARCHIVE_URL) return archive;
        throw new Error(`unexpected ${url}`);
      },
    });

    expect(result.mode).toBe('full');
    expect(urls).toContain(ARCHIVE_URL);
    expect(mem.saved()?.generated_at).toBe(GENERATED_AT);
  });

  it('leaves the watermark unchanged when a snapshot hash does not match', async () => {
    const snapshot = '{"name":"embiggen","id":"MAL-1"}\n';
    const manifest = npmManifest(snapshot, '');
    manifest.ecosystems.npm.files[0].sha256 = '0'.repeat(64);
    const archive = await packArchive(manifest, { 'npm.jsonl': snapshot });
    const mem = createMemoryStore();
    mem.setWatermark('2026-01-01T00:00:00Z');

    await expect(
      executeMaliciousSync({
        store: mem.store,
        feedUrl: FEED_URL,
        archiveUrl: ARCHIVE_URL,
        log,
        fetchBuffer: async (url) => {
          if (url.endsWith('/manifest.json')) return Buffer.from(JSON.stringify(manifest));
          if (url === ARCHIVE_URL) return archive;
          throw new Error(`unexpected ${url}`);
        },
      })
    ).rejects.toThrow(/sha256 does not match/);

    expect(mem.saved()).toBeNull();
    expect(mem.rows).toHaveLength(0);
  });

  it('does not download the archive for an unsupported schema', async () => {
    const manifest = npmManifest('', '');
    manifest.schema_version = '3.0.0';
    const mem = createMemoryStore();
    const urls: string[] = [];

    await expect(
      executeMaliciousSync({
        store: mem.store,
        feedUrl: FEED_URL,
        archiveUrl: ARCHIVE_URL,
        log,
        fetchBuffer: async (url) => {
          urls.push(url);
          return Buffer.from(JSON.stringify(manifest));
        },
      })
    ).rejects.toThrow(/Unsupported schema_version/);

    expect(urls).toEqual([`${FEED_URL}/manifest.json`]);
    expect(mem.saved()).toBeNull();
  });
});

describe('executeMaliciousSync lookup names', () => {
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  async function sync(watermark: string | null, fill: () => Promise<number>) {
    const changes = '{"op":"upsert","modified":"2026-10-02T07:00:00Z","name":"new-pkg","id":"MAL-2"}';
    const manifest = npmManifest('', changes);
    const mem = createMemoryStore();
    mem.setWatermark(watermark);
    const order: string[] = [];
    mem.store.fillLookupNames = async () => {
      order.push('fill');
      return fill();
    };
    const writeState = mem.store.writeState.bind(mem.store);
    mem.store.writeState = async (m) => {
      order.push('writeState');
      return writeState(m);
    };
    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async (url) => {
        if (url.endsWith('/manifest.json')) return Buffer.from(JSON.stringify(manifest));
        if (url.endsWith('/npm.changes.jsonl')) return Buffer.from(changes);
        throw new Error(`unexpected ${url}`);
      },
    });
    return { result, order };
  }

  it('repairs rows an older replica wrote, even when the feed has not changed', async () => {
    const fill = vi.fn(async () => 3);
    const { result, order } = await sync(GENERATED_AT, fill);
    expect(result.mode).toBe('none');
    expect(fill).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['fill']);
  });

  it('repairs them after applying changes, before the watermark moves', async () => {
    const fill = vi.fn(async () => 0);
    const { result, order } = await sync('2026-10-02T06:00:00Z', fill);
    expect(result.mode).toBe('changes');
    expect(order).toEqual(['fill', 'writeState']);
  });

  it('runs without a repair step when the store has none', async () => {
    const manifest = npmManifest('', '');
    const mem = createMemoryStore();
    mem.setWatermark(GENERATED_AT);
    const result = await executeMaliciousSync({
      store: mem.store,
      feedUrl: FEED_URL,
      archiveUrl: ARCHIVE_URL,
      log,
      fetchBuffer: async () => Buffer.from(JSON.stringify(manifest)),
    });
    expect(result.mode).toBe('none');
  });
});
