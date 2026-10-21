import { DataSource } from 'typeorm';
import { Exception } from '../db/entities/Exception.js';
import { versionInRange } from './version-range.js';
import { repositoryIdFor } from './repository-resolve.js';
import { exceptionCovers, scopeIds } from './repository-scope.js';
import { canonicalPackageName } from './package-name.js';

function versionMatches(ecosystem: string, requestedVersion: string, storedVersion: string): boolean {
  if (storedVersion === '*') return true;
  if (storedVersion === requestedVersion) return true;
  return versionInRange(ecosystem, requestedVersion, storedVersion) === 'match';
}

export function matchesAnyException(rows: Exception[], version: string, ecosystem: string): boolean {
  return rows.some((row) => versionMatches(ecosystem, version, row.version));
}

/** The first exception that covers the version, so an allowed download can name it without a lookup (R-P2). */
export function matchingException(rows: Exception[], version: string, ecosystem: string): Exception | undefined {
  return rows.find((row) => versionMatches(ecosystem, version, row.version));
}

export async function hasActiveException(
  db: DataSource,
  ecosystem: string,
  packageName: string,
  version: string,
  repoKey?: string,
  sourceKey?: string
): Promise<boolean> {
  return (await findActiveException(db, ecosystem, packageName, version, repoKey, sourceKey)) !== null;
}

/**
 * The exception that lets this version past every policy, newest first, or null.
 * An exception limited to some repositories counts only for a request on one of them
 * (`repoKey`, default `default`).
 */
export async function findActiveException(
  db: DataSource,
  ecosystem: string,
  packageName: string,
  version: string,
  repoKey?: string,
  /** Key of the remote that served the version, for exceptions scoped to it (R5). */
  sourceKey?: string
): Promise<Exception | null> {
  const repo = db.getRepository(Exception);
  const now = new Date();
  const list = await repo
    .createQueryBuilder('e')
    .where('e.ecosystem = :ecosystem', { ecosystem })
    .andWhere('e.packageName = :packageName', { packageName: canonicalPackageName(ecosystem, packageName) })
    .andWhere('e.expiresAt > :now', { now })
    // An exception scoped to one policy does not let a version past the others.
    .andWhere('e.policyId IS NULL')
    .getMany();
  const scoped = list.some((e) => scopeIds(e.repositoryIds));
  const scope = {
    requestId: scoped ? await repositoryIdFor(db, ecosystem, repoKey || 'default') : null,
    sourceId: scoped && sourceKey ? await repositoryIdFor(db, ecosystem, sourceKey) : null,
    memberIds: [],
  };
  const matching = list.filter(
    (e) => versionMatches(ecosystem, version, e.version) && exceptionCovers(scopeIds(e.repositoryIds), scope)
  );
  matching.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
  return matching[0] ?? null;
}
