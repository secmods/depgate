import type { DataSource, EntityManager } from 'typeorm';
import { backfillMaliciousLookupNames } from './malicious-sync.js';
import { canonicalPackageName } from './package-name.js';
import { bumpReference } from './reference-cache.js';

/** Serializes replicas that start together. Any constant unique to this job. */
const LOCK_KEY = 74_201_538;

/** Ecosystems whose canonical name can differ from the stored one; npm and Maven are kept as typed. */
const NORMALIZED_ECOSYSTEMS = ['pypi', 'nuget', 'rubygems', 'composer', 'cargo', 'go'];

export type PackageNameMigration = { malicious: number; exceptions: number; waivers: number };

async function canonicalizeTable(manager: EntityManager, table: 'exceptions' | 'waiver_requests'): Promise<number> {
  const rows: { id: string; ecosystem: string; package_name: string }[] = await manager.query(
    `SELECT id, ecosystem, package_name FROM ${table} WHERE ecosystem = ANY($1::varchar[])`,
    [NORMALIZED_ECOSYSTEMS]
  );
  const changed = rows
    .map((row) => ({ id: row.id, name: canonicalPackageName(row.ecosystem, row.package_name) }))
    .filter((row, i) => row.name !== rows[i].package_name);
  if (changed.length === 0) return 0;
  await manager.query(
    `UPDATE ${table} AS t SET package_name = v.name
     FROM unnest($1::uuid[], $2::varchar[]) AS v(id, name)
     WHERE t.id = v.id`,
    [changed.map((row) => row.id), changed.map((row) => row.name)]
  );
  return changed.length;
}

/**
 * Brings stored package names to canonicalPackageName before requests are served. A startup task
 * outside the migration chain (requirements_schema_migrations.md §6). Idempotent: rows already canonical are left alone.
 * Malicious packages keep the feed's spelling in `name` (the sync compares it with the feed) and
 * get the canonical one in `lookup_name`; exceptions and waivers are rewritten in place.
 */
export async function ensurePackageNames(db: DataSource): Promise<PackageNameMigration> {
  const migrated = await db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const [tables]: { malicious: boolean; exceptions: boolean; waivers: boolean }[] = await manager.query(
      `SELECT to_regclass('public.malicious_packages') IS NOT NULL AS malicious,
              to_regclass('public.exceptions') IS NOT NULL AS exceptions,
              to_regclass('public.waiver_requests') IS NOT NULL AS waivers`
    );
    const result: PackageNameMigration = { malicious: 0, exceptions: 0, waivers: 0 };
    if (tables.malicious) result.malicious = await backfillMaliciousLookupNames(manager);
    if (tables.exceptions) result.exceptions = await canonicalizeTable(manager, 'exceptions');
    if (tables.waivers) result.waivers = await canonicalizeTable(manager, 'waiver_requests');
    return result;
  });
  if (migrated.malicious > 0) await bumpReference('malicious');
  if (migrated.exceptions > 0) await bumpReference('exceptions');
  return migrated;
}
