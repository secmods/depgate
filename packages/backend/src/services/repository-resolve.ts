import { DataSource, In } from 'typeorm';
import { createHash } from 'node:crypto';
import { PackageRepository, type RepositorySource } from '../db/entities/PackageRepository.js';
import { PackageRepositoryMember } from '../db/entities/PackageRepositoryMember.js';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { rememberRepoKey, rememberRepoKeys, shareRepoKey, unshareRepoKey } from './repo-keys.js';
import { bumpRepositories, readReference } from './reference-cache.js';
import { detachRepository, type DetachResult } from './repository-scope.js';

export type RemoteTarget = {
  id: string;
  /** Repository key, e.g. `default` or `acme-artifactory`. */
  key: string;
  url: string;
  timeoutMs: number;
  retryCount: number;
  authType: string | null;
  authEncrypted: string | null;
  source: RepositorySource;
};

export const PUBLIC_REMOTES: Array<{ ecosystem: string; key: string; url: string }> = [
  { ecosystem: 'npm', key: 'default', url: 'https://registry.npmjs.org' },
  { ecosystem: 'pypi', key: 'default', url: 'https://pypi.org' },
  { ecosystem: 'go', key: 'default', url: 'https://proxy.golang.org' },
  { ecosystem: 'maven', key: 'default', url: 'https://repo1.maven.org/maven2' },
  { ecosystem: 'nuget', key: 'default', url: 'https://api.nuget.org' },
  { ecosystem: 'cargo', key: 'default', url: 'https://crates.io' },
  { ecosystem: 'composer', key: 'default', url: 'https://repo.packagist.org' },
  { ecosystem: 'rubygems', key: 'default', url: 'https://rubygems.org' },
];

/** Keys used for the public remote before it was renamed to `default`. */
const LEGACY_PUBLIC_KEYS: Record<string, string> = {
  npm: 'npmjs',
  pypi: 'pypi-org',
  go: 'goproxy',
  maven: 'central',
  nuget: 'nuget-org',
  cargo: 'crates',
  composer: 'packagist',
  rubygems: 'rubygems-org',
};

function toTarget(row: PackageRepository): RemoteTarget {
  return {
    id: row.id,
    key: row.key,
    url: (row.upstreamUrl ?? '').replace(/\/$/, ''),
    timeoutMs: row.timeoutMs,
    retryCount: row.retryCount,
    authType: row.authType,
    authEncrypted: row.authEncrypted,
    // The reserved `default` remote is the public registry whatever the column says.
    source: row.source === 'internal' && !row.isReserved ? 'internal' : 'public',
  };
}

type RepoSnapshot = {
  repos: PackageRepository[];
  members: PackageRepositoryMember[];
  upstreams: UpstreamRegistry[];
};

async function ecosystemSnapshot(db: DataSource, ecosystem: string): Promise<RepoSnapshot> {
  return readReference(`repos:${ecosystem}`, async () => {
    const repos = await db.getRepository(PackageRepository).find({ where: { ecosystem } });
    const ids = repos.map((row) => row.id);
    const members = ids.length
      ? await db.getRepository(PackageRepositoryMember).find({ where: { virtualId: In(ids) } })
      : [];
    const upstreams = await db.getRepository(UpstreamRegistry).find({
      where: { ecosystem, isEnabled: true },
      order: { priority: 'ASC' },
    });
    return { repos, members, upstreams };
  });
}

function repoByKey(snapshot: RepoSnapshot, key: string): PackageRepository | null {
  return snapshot.repos.find((row) => row.key === key) ?? null;
}

/** The ID of an ecosystem's repository by key, from the cached snapshot, or null when there is none. */
export async function repositoryIdFor(db: DataSource, ecosystem: string, key: string): Promise<string | null> {
  return repoByKey(await ecosystemSnapshot(db, ecosystem), key || 'default')?.id ?? null;
}

const signatures = new WeakMap<RepoSnapshot, string>();

/**
 * Changes whenever a remote of the ecosystem is added, removed, repointed, enabled or reclassified.
 * Part of the namespace epoch, so a source change gives reserved names fresh cache keys.
 */
export async function remoteSourcesSignature(db: DataSource, ecosystem: string): Promise<string> {
  const snapshot = await ecosystemSnapshot(db, ecosystem);
  let signature = signatures.get(snapshot);
  if (!signature) {
    const rows = snapshot.repos
      .filter((row) => row.type === 'remote')
      .map((row) => `${row.id}|${row.upstreamUrl ?? ''}|${row.isEnabled ? 1 : 0}|${toTarget(row).source}`)
      .sort();
    signature = createHash('sha1').update(rows.join('\n')).digest('hex').slice(0, 12);
    signatures.set(snapshot, signature);
  }
  return signature;
}

/** Every remote of the ecosystem, enabled or not, for admin views such as the namespace remotes panel. */
export async function listRemotes(db: DataSource, ecosystem: string): Promise<Array<RemoteTarget & { isEnabled: boolean }>> {
  const snapshot = await ecosystemSnapshot(db, ecosystem);
  return snapshot.repos
    .filter((row) => row.type === 'remote' && row.upstreamUrl)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((row) => ({ ...toTarget(row), isEnabled: row.isEnabled }));
}

export async function listEnabledUpstreams(db: DataSource, ecosystem: string): Promise<UpstreamRegistry[]> {
  return (await ecosystemSnapshot(db, ecosystem)).upstreams;
}

export async function resolveRemoteTargets(
  db: DataSource,
  ecosystem: string,
  repoKey: string
): Promise<RemoteTarget[]> {
  const snapshot = await ecosystemSnapshot(db, ecosystem);
  if (snapshot.repos.length === 0) {
    return snapshot.upstreams.map((row) => ({
      id: row.id,
      key: 'default',
      url: row.url.replace(/\/$/, ''),
      timeoutMs: row.timeoutMs,
      retryCount: row.retryCount,
      authType: row.authType,
      authEncrypted: row.authEncrypted,
      source: 'public' as const,
    }));
  }

  const repo = repoByKey(snapshot, repoKey);
  if (!repo || !repo.isEnabled) return [];
  if (repo.type === 'remote') {
    return repo.upstreamUrl ? [toTarget(repo)] : [];
  }
  if (repo.key === 'all') {
    return snapshot.repos
      .filter((row) => row.type === 'remote' && row.isEnabled && row.upstreamUrl)
      .sort(compareAllOrder)
      .map(toTarget);
  }

  const members = snapshot.members
    .filter((member) => member.virtualId === repo.id)
    .sort((a, b) => a.position - b.position);
  if (members.length === 0) return [];
  const byId = new Map(snapshot.repos.map((row) => [row.id, row]));
  return members
    .map((member) => byId.get(member.memberId))
    .filter((row): row is PackageRepository => !!row && row.type === 'remote' && row.isEnabled && !!row.upstreamUrl)
    .map(toTarget);
}

/** The `all` search order: saved positions first, then remotes nobody placed, by key (the order before R2). */
export function compareAllOrder(
  a: Pick<PackageRepository, 'allPosition' | 'key'>,
  b: Pick<PackageRepository, 'allPosition' | 'key'>
): number {
  const pa = a.allPosition ?? Number.POSITIVE_INFINITY;
  const pb = b.allPosition ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.key.localeCompare(b.key);
}

/**
 * Position for a remote added to an ecosystem: the end of `all`'s saved order, or null when
 * `all` was never ordered (it then keeps sorting by key).
 */
export async function nextAllPosition(db: DataSource, ecosystem: string): Promise<number | null> {
  const [row]: Array<{ max: number | null }> = await db.query(
    `SELECT max(all_position) AS max FROM package_repositories WHERE ecosystem = $1 AND type = 'remote'`,
    [ecosystem]
  );
  return row?.max == null ? null : Number(row.max) + 1;
}

function slugFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return host.slice(0, 48) || 'remote';
  } catch {
    return 'remote';
  }
}

async function uniqueKey(db: DataSource, ecosystem: string, base: string): Promise<string> {
  const repo = db.getRepository(PackageRepository);
  let key = base;
  let n = 2;
  while (await repo.findOne({ where: { ecosystem, key } })) {
    key = `${base}-${n}`;
    n += 1;
  }
  return key;
}

export async function refreshRepoKeyCache(db: DataSource): Promise<void> {
  const rows = await db.getRepository(PackageRepository).find({ select: { ecosystem: true, key: true } });
  rememberRepoKeys(rows);
}

async function removeVirtualDefault(db: DataSource, ecosystem: string): Promise<void> {
  const repos = db.getRepository(PackageRepository);
  const row = await repos.findOne({ where: { ecosystem, key: 'default', type: 'virtual' } });
  if (!row) return;
  const members = db.getRepository(PackageRepositoryMember);
  await members.delete({ virtualId: row.id });
  await members.delete({ memberId: row.id });
  await repos.remove(row);
}

async function removeLocalRepositories(db: DataSource, ecosystem: string): Promise<void> {
  const repos = db.getRepository(PackageRepository);
  const members = db.getRepository(PackageRepositoryMember);
  const locals = await repos
    .createQueryBuilder('repo')
    .where('repo.ecosystem = :ecosystem', { ecosystem })
    .andWhere('repo.type = :type', { type: 'local' })
    .getMany();
  for (const row of locals) {
    await members.delete({ memberId: row.id });
    await members.delete({ virtualId: row.id });
    await repos.remove(row);
    unshareRepoKey(ecosystem, row.key);
  }
}

async function ensureVirtual(db: DataSource, ecosystem: string, key: 'all'): Promise<PackageRepository> {
  const repo = db.getRepository(PackageRepository);
  let row = await repo.findOne({ where: { ecosystem, key } });
  if (!row) {
    row = await repo.save(
      repo.create({
        ecosystem,
        key,
        type: 'virtual',
        isReserved: true,
        isEnabled: true,
        priority: 0,
        timeoutMs: 30000,
        retryCount: 3,
      })
    );
  }
  rememberRepoKey(ecosystem, key);
  return row;
}

export async function seedPackageRepositories(db: DataSource): Promise<void> {
  const repos = db.getRepository(PackageRepository);
  const members = db.getRepository(PackageRepositoryMember);
  const upstreams = await db.getRepository(UpstreamRegistry).find({ order: { priority: 'ASC' } });

  const ecosystems = [...new Set([...PUBLIC_REMOTES.map((r) => r.ecosystem), ...upstreams.map((u) => u.ecosystem)])];
  for (const ecosystem of ecosystems) {
    await removeLocalRepositories(db, ecosystem);

    const canonical = PUBLIC_REMOTES.find((r) => r.ecosystem === ecosystem);
    const ecoUpstreams = upstreams.filter((u) => u.ecosystem === ecosystem);
    const primaryUpstream =
      ecoUpstreams.find((u) => canonical && u.url.replace(/\/$/, '') === canonical.url) ??
      ecoUpstreams[0];

    await removeVirtualDefault(db, ecosystem);

    let primary: PackageRepository | null = await repos.findOne({ where: { ecosystem, key: 'default' } });
    const legacyKey = LEGACY_PUBLIC_KEYS[ecosystem];
    const legacy = legacyKey ? await repos.findOne({ where: { ecosystem, key: legacyKey, type: 'remote' } }) : null;
    if (primary?.type === 'remote' && legacy) {
      await members.delete({ memberId: legacy.id });
      await members.delete({ virtualId: legacy.id });
      await repos.remove(legacy);
    } else if (!primary && legacy) {
      legacy.key = 'default';
      legacy.isReserved = true;
      legacy.description = legacy.description || 'Public registry';
      primary = await repos.save(legacy);
    }
    if (canonical && !primary) {
      primary = await repos.save(
        repos.create({
          ecosystem,
          key: 'default',
          type: 'remote',
          upstreamUrl: (primaryUpstream?.url ?? canonical.url).replace(/\/$/, ''),
          priority: primaryUpstream?.priority ?? 0,
          isEnabled: primaryUpstream?.isEnabled ?? true,
          isReserved: true,
          timeoutMs: primaryUpstream?.timeoutMs ?? 30000,
          retryCount: primaryUpstream?.retryCount ?? 3,
          authType: primaryUpstream?.authType ?? null,
          authEncrypted: primaryUpstream?.authEncrypted ?? null,
          upstreamRegistryId: primaryUpstream?.id ?? null,
          description: 'Public registry',
        })
      );
    } else if (primary?.type === 'remote') {
      primary.isReserved = true;
      if (!primary.upstreamUrl && canonical) primary.upstreamUrl = canonical.url;
      primary = await repos.save(primary);
    }
    if (primary) rememberRepoKey(ecosystem, primary.key);

    for (const upstream of ecoUpstreams) {
      if (primary?.upstreamRegistryId === upstream.id) continue;
      if (canonical && upstream.url.replace(/\/$/, '') === canonical.url.replace(/\/$/, '')) continue;
      const existing = await repos.findOne({ where: { upstreamRegistryId: upstream.id } });
      if (existing) continue;
      const key = await uniqueKey(db, ecosystem, slugFromUrl(upstream.url));
      const created = await repos.save(
        repos.create({
          ecosystem,
          key,
          type: 'remote',
          upstreamUrl: upstream.url.replace(/\/$/, ''),
          priority: upstream.priority,
          isEnabled: upstream.isEnabled,
          isReserved: false,
          timeoutMs: upstream.timeoutMs,
          retryCount: upstream.retryCount,
          authType: upstream.authType,
          authEncrypted: upstream.authEncrypted,
          upstreamRegistryId: upstream.id,
          allPosition: await nextAllPosition(db, ecosystem),
        })
      );
      rememberRepoKey(ecosystem, created.key);
    }

    await ensureVirtual(db, ecosystem, 'all');
  }

  await refreshRepoKeyCache(db);
}

export async function syncUpstreamRegistry(db: DataSource, row: UpstreamRegistry): Promise<void> {
  const repos = db.getRepository(PackageRepository);
  const existing = await repos.findOne({ where: { upstreamRegistryId: row.id } });
  if (existing) {
    existing.upstreamUrl = row.url.replace(/\/$/, '');
    existing.priority = row.priority;
    existing.isEnabled = row.isEnabled;
    existing.timeoutMs = row.timeoutMs;
    existing.retryCount = row.retryCount;
    existing.authType = row.authType;
    existing.authEncrypted = row.authEncrypted;
    await repos.save(existing);
    shareRepoKey(existing.ecosystem, existing.key);
    await bumpRepositories(existing.ecosystem);
    return;
  }
  const canonical = PUBLIC_REMOTES.find(
    (r) => r.ecosystem === row.ecosystem && r.url === row.url.replace(/\/$/, '')
  );
  if (canonical) {
    const primary = await repos.findOne({ where: { ecosystem: row.ecosystem, key: canonical.key } });
    if (primary && !primary.upstreamRegistryId) {
      primary.upstreamRegistryId = row.id;
      primary.upstreamUrl = row.url.replace(/\/$/, '');
      primary.priority = row.priority;
      primary.isEnabled = row.isEnabled;
      primary.authType = row.authType;
      primary.authEncrypted = row.authEncrypted;
      await repos.save(primary);
      await bumpRepositories(row.ecosystem);
      return;
    }
  }
  const key = await uniqueKey(db, row.ecosystem, slugFromUrl(row.url));
  const created = await repos.save(
    repos.create({
      ecosystem: row.ecosystem,
      key,
      type: 'remote',
      upstreamUrl: row.url.replace(/\/$/, ''),
      priority: row.priority,
      isEnabled: row.isEnabled,
      timeoutMs: row.timeoutMs,
      retryCount: row.retryCount,
      authType: row.authType,
      authEncrypted: row.authEncrypted,
      upstreamRegistryId: row.id,
      allPosition: await nextAllPosition(db, row.ecosystem),
    })
  );
  shareRepoKey(created.ecosystem, created.key);
  await bumpRepositories(created.ecosystem);
}

export async function removeUpstreamRepository(
  db: DataSource,
  upstreamId: string
): Promise<{ label: string; detached: DetachResult } | null> {
  const repos = db.getRepository(PackageRepository);
  const row = await repos.findOne({ where: { upstreamRegistryId: upstreamId } });
  if (!row || row.isReserved) return null;
  const detached = await db.transaction(async (manager) => {
    const result = await detachRepository(manager, row.id);
    await manager.getRepository(PackageRepositoryMember).delete({ memberId: row.id });
    await manager.getRepository(PackageRepository).remove(row);
    return result;
  });
  unshareRepoKey(row.ecosystem, row.key);
  await bumpRepositories(row.ecosystem);
  return { label: `${row.ecosystem}/${row.key}`, detached };
}
