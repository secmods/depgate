import { In, type DataSource, type EntityManager } from 'typeorm';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import { Policy } from '../db/entities/Policy.js';
import { Exception } from '../db/entities/Exception.js';
import { WaiverRequest } from '../db/entities/WaiverRequest.js';
import { noteReferenceWrite } from './reference-cache.js';

/**
 * Repository scope of policies, exceptions and waiver requests. An empty list means every
 * repository. Scope matches the repository the client asked for (the key in the URL), never
 * the member remote of a virtual repository that served the package.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RepositoryRef = { id: string; ecosystem: string; key: string; type: string };

/** The stored list as a set, or null when it covers every repository. */
export function scopeIds(list: readonly string[] | null | undefined): Set<string> | null {
  return Array.isArray(list) && list.length > 0 ? new Set(list) : null;
}

/** Whether a request on `repositoryId` is inside the scope. An unknown repository is outside every limited scope. */
export function inRepositoryScope(scope: Set<string> | null, repositoryId: string | null): boolean {
  if (!scope) return true;
  return repositoryId !== null && scope.has(repositoryId);
}

/** Request body value to a deduplicated ID list, or an error. Undefined stays undefined (field not sent). */
export function parseScopeIds(value: unknown): { ids?: string[]; error?: string } {
  if (value === undefined) return {};
  if (value === null) return { ids: [] };
  if (!Array.isArray(value)) return { error: 'repositoryIds must be a list of repository IDs' };
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !UUID.test(item)) return { error: 'repositoryIds must be a list of repository IDs' };
    const id = item.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

export async function loadRepositoryRefs(db: DataSource | EntityManager, ids: readonly string[]): Promise<RepositoryRef[]> {
  if (ids.length === 0) return [];
  const rows = await db.getRepository(PackageRepository).find({ where: { id: In([...ids]) } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is PackageRepository => !!row)
    .map((row) => ({ id: row.id, ecosystem: row.ecosystem, key: row.key, type: row.type }));
}

/** Every repository a set of rows refers to, keyed by ID, in one query. */
export async function repositoryRefMap(
  db: DataSource | EntityManager,
  rows: ReadonlyArray<{ repositoryIds?: string[] | null }>
): Promise<Map<string, RepositoryRef>> {
  const ids = [...new Set(rows.flatMap((row) => row.repositoryIds ?? []))];
  return new Map((await loadRepositoryRefs(db, ids)).map((ref) => [ref.id, ref]));
}

export function refsFor(ids: readonly string[] | null | undefined, refs: Map<string, RepositoryRef>): RepositoryRef[] {
  return (ids ?? []).map((id) => refs.get(id)).filter((ref): ref is RepositoryRef => !!ref);
}

/**
 * Why the repositories cannot scope something limited to `ecosystems` (empty = every ecosystem),
 * or null. Returns the repositories when valid, in the order given.
 */
export async function validateRepositoryScope(
  db: DataSource | EntityManager,
  ids: readonly string[],
  ecosystems: readonly string[]
): Promise<{ error: string } | { refs: RepositoryRef[] }> {
  if (ids.length === 0) return { refs: [] };
  const refs = await loadRepositoryRefs(db, ids);
  if (refs.length !== ids.length) {
    const found = new Set(refs.map((ref) => ref.id));
    return { error: `Repository ${ids.find((id) => !found.has(id))} does not exist` };
  }
  const allError = allScopeError(refs);
  if (allError) return { error: allError };
  if (ecosystems.length > 0) {
    const outside = refs.find((ref) => !ecosystems.includes(ref.ecosystem));
    if (outside) {
      return {
        error: `Repository ${outside.ecosystem}/${outside.key} is not in this policy's ecosystem (${ecosystems.join(', ')}). Remove it or change the ecosystem`,
      };
    }
  }
  return { refs };
}

/** "all repositories", or the repository keys, e.g. "npm/prod, npm/staging". */
export function describeScope(refs: readonly RepositoryRef[]): string {
  return refs.length === 0 ? 'all repositories' : refs.map((ref) => `${ref.ecosystem}/${ref.key}`).join(', ');
}

function containsId(alias: string): string {
  return `${alias}.repository_ids @> :scopeIdJson::jsonb`;
}

export type RepositoryUsage = {
  /** Policies scoped to this repository. */
  policies: Array<{ id: string; name: string; isEnabled: boolean; onlyRepository: boolean }>;
  /** Exceptions scoped to this repository. */
  exceptions: Array<{ id: string; packageName: string; version: string; onlyRepository: boolean }>;
  /** Pending waiver requests scoped to this repository. */
  waivers: Array<{ id: string; packageName: string; version: string; onlyRepository: boolean }>;
  /**
   * Internal namespace policies that allow this remote (R6). `onlyRemote`: their names have no other
   * allowed remote, so after deletion they are blocked everywhere until another remote is allowed.
   */
  namespacePolicies: Array<{ id: string; name: string; onlyRemote: boolean }>;
};

/** Policies, exceptions and pending waivers whose scope names this repository. */
export async function repositoryUsage(db: DataSource | EntityManager, repositoryId: string): Promise<RepositoryUsage> {
  const params = { scopeIdJson: JSON.stringify([repositoryId]) };
  const [policies, exceptions, waivers, namespacePolicies] = await Promise.all([
    db.getRepository(Policy).createQueryBuilder('p').where(containsId('p'), params).orderBy('p.priority', 'ASC').getMany(),
    db.getRepository(Exception).createQueryBuilder('e').where(containsId('e'), params).getMany(),
    db
      .getRepository(WaiverRequest)
      .createQueryBuilder('w')
      .where(containsId('w'), params)
      .andWhere('w.status = :status', { status: 'pending' })
      .getMany(),
    db
      .getRepository(Policy)
      .createQueryBuilder('p')
      .where(`p.conditions->'allowedRemotes' @> :scopeIdJson::jsonb`, params)
      .getMany(),
  ]);
  const only = (ids: string[] | null | undefined) => (ids ?? []).length === 1;
  return {
    policies: policies.map((p) => ({ id: p.id, name: p.name, isEnabled: p.isEnabled, onlyRepository: only(p.repositoryIds) })),
    exceptions: exceptions.map((e) => ({
      id: e.id,
      packageName: e.packageName,
      version: e.version,
      onlyRepository: only(e.repositoryIds),
    })),
    waivers: waivers.map((w) => ({
      id: w.id,
      packageName: w.packageName,
      version: w.version,
      onlyRepository: only(w.repositoryIds),
    })),
    namespacePolicies: namespacePolicies.map((p) => ({
      id: p.id,
      name: p.name,
      onlyRemote: only((p.conditions as { allowedRemotes?: string[] }).allowedRemotes),
    })),
  };
}

export type DetachResult = {
  /** Policies deleted because this was their only repository (`onLastPolicy: 'delete'`). */
  deletedPolicies: Policy[];
  disabledPolicies: Policy[];
  narrowedPolicies: Policy[];
  deletedExceptions: Exception[];
  rejectedWaivers: WaiverRequest[];
};

const DELETED_NOTE = 'Rejected automatically: the only repository it was requested for was deleted';

/**
 * Remove a repository from every scope, inside the caller's transaction. A policy whose last
 * repository this was is disabled, an exception is deleted and a pending waiver is rejected:
 * an empty list would otherwise widen each of them to every repository.
 */
export async function detachRepository(
  manager: EntityManager,
  repositoryId: string,
  options: { onLastPolicy?: 'disable' | 'delete'; reason?: string } = {}
): Promise<DetachResult> {
  const params = { scopeIdJson: JSON.stringify([repositoryId]) };
  const without = (ids: string[] | null | undefined) => (ids ?? []).filter((id) => id !== repositoryId);
  const result: DetachResult = {
    deletedPolicies: [],
    disabledPolicies: [],
    narrowedPolicies: [],
    deletedExceptions: [],
    rejectedWaivers: [],
  };

  const policies = await manager.getRepository(Policy).createQueryBuilder('p').where(containsId('p'), params).getMany();
  for (const policy of policies) {
    policy.repositoryIds = without(policy.repositoryIds);
    if (policy.repositoryIds.length === 0 && options.onLastPolicy === 'delete') {
      // Its approvals go with it through the foreign key; monitor rows too.
      await manager.getRepository(Policy).delete({ id: policy.id });
      result.deletedPolicies.push(policy);
      continue;
    }
    if (policy.repositoryIds.length === 0) {
      // Keep the ID so the policy stays scoped to nothing rather than to everything.
      policy.repositoryIds = [repositoryId];
      policy.isEnabled = false;
      result.disabledPolicies.push(policy);
    } else {
      result.narrowedPolicies.push(policy);
    }
    await manager.getRepository(Policy).save(policy);
  }

  const exceptions = await manager.getRepository(Exception).createQueryBuilder('e').where(containsId('e'), params).getMany();
  for (const exception of exceptions) {
    const rest = without(exception.repositoryIds);
    if (rest.length === 0) {
      await manager.getRepository(Exception).delete({ id: exception.id });
      result.deletedExceptions.push(exception);
    } else {
      await manager.getRepository(Exception).update({ id: exception.id }, { repositoryIds: rest });
    }
  }
  // delete() and update() do not reach the reference subscriber. These bumps wait for the caller's commit.
  if (result.deletedPolicies.length > 0) {
    await noteReferenceWrite({ metadata: { tableName: 'policies' }, queryRunner: manager.queryRunner });
  }
  if (exceptions.length > 0) {
    await noteReferenceWrite({ metadata: { tableName: 'exceptions' }, queryRunner: manager.queryRunner });
  }

  const waivers = await manager.getRepository(WaiverRequest).createQueryBuilder('w').where(containsId('w'), params).getMany();
  for (const waiver of waivers) {
    const rest = without(waiver.repositoryIds);
    if (rest.length === 0 && waiver.status === 'pending') {
      await manager.getRepository(WaiverRequest).update(
        { id: waiver.id },
        { status: 'rejected', reviewedBy: 'DepGate', reviewNote: options.reason ?? DELETED_NOTE, reviewedAt: new Date() }
      );
      result.rejectedWaivers.push(waiver);
    } else if (rest.length > 0) {
      await manager.getRepository(WaiverRequest).update({ id: waiver.id }, { repositoryIds: rest });
    }
  }
  return result;
}

/**
 * Scope may not name `all` (R5): a policy on a remote already covers its packages through `all`, and
 * one limited to `all` is skipped by switching to another URL. Each `all` comes out of every scope.
 * A policy that applied only to `all` is deleted; an exception only for it is deleted; a pending
 * waiver only for it is rejected. Idempotent: nothing to do once no scope names `all`.
 */
export async function removeAllRepositoryScopes(db: DataSource): Promise<Array<{ label: string; detached: DetachResult }>> {
  const alls = await db.getRepository(PackageRepository).find({ where: { key: 'all', type: 'virtual' } });
  const out: Array<{ label: string; detached: DetachResult }> = [];
  for (const all of alls) {
    const detached = await db.transaction((manager) =>
      detachRepository(manager, all.id, {
        onLastPolicy: 'delete',
        reason: 'Rejected automatically: scope can no longer be limited to the all repository',
      })
    );
    const changed =
      detached.deletedPolicies.length +
      detached.disabledPolicies.length +
      detached.narrowedPolicies.length +
      detached.deletedExceptions.length +
      detached.rejectedWaivers.length;
    if (changed > 0) out.push({ label: `${all.ecosystem}/all`, detached });
  }
  return out;
}

/** Why a scope cannot use these repositories: `all` is never a scope (R5). Null when fine. */
export function allScopeError(refs: readonly RepositoryRef[]): string | null {
  const all = refs.find((ref) => ref.key === 'all' && ref.type === 'virtual');
  return all
    ? `${all.ecosystem}/all cannot be chosen: a policy on a remote already covers its packages through all. Use All repositories instead`
    : null;
}

/**
 * Which repositories a request touches, for scope (R5): the repository in the URL, and the remote
 * that serves the package. `sourceId` is null when the request did not need it or it is unknown;
 * `memberIds` then lists every remote that could serve it.
 */
export type ScopeContext = { requestId: string | null; sourceId: string | null; memberIds: readonly string[] };

/**
 * A policy covers the request when its scope names the URL's repository or the serving remote.
 * When the serving remote is unknown, any member counts: an unknown source never skips a policy.
 */
export function policyCovers(scope: Set<string> | null, ctx: ScopeContext): boolean {
  if (!scope) return true;
  if (ctx.requestId !== null && scope.has(ctx.requestId)) return true;
  if (ctx.sourceId !== null) return scope.has(ctx.sourceId);
  return ctx.memberIds.some((id) => scope.has(id));
}

/** An exception covers the request only when its scope names the URL's repository or the known serving remote. */
export function exceptionCovers(scope: Set<string> | null, ctx: ScopeContext): boolean {
  if (!scope) return true;
  if (ctx.requestId !== null && scope.has(ctx.requestId)) return true;
  return ctx.sourceId !== null && scope.has(ctx.sourceId);
}

/**
 * The scope context of a request. The serving remote is looked up (possibly a probe of the
 * remotes) only when some scope names a member remote but not the URL's repository.
 */
export async function scopeContext(
  scopes: ReadonlyArray<Set<string> | null>,
  requestId: () => Promise<string | null>,
  targets: ReadonlyArray<{ id: string }> | undefined,
  servingSource: (() => Promise<{ id: string } | null>) | undefined
): Promise<ScopeContext> {
  const limited = scopes.filter((scope): scope is Set<string> => scope !== null);
  if (limited.length === 0) return { requestId: null, sourceId: null, memberIds: [] };
  const request = await requestId();
  const memberIds = (targets ?? []).map((target) => target.id).filter((id) => id !== request);
  const needsSource = limited.some((scope) => !(request !== null && scope.has(request)) && memberIds.some((id) => scope.has(id)));
  if (!needsSource) return { requestId: request, sourceId: null, memberIds: [] };
  if (targets && targets.length === 1) return { requestId: request, sourceId: targets[0].id, memberIds };
  const source = servingSource ? await servingSource() : null;
  return { requestId: request, sourceId: source?.id ?? null, memberIds };
}

/**
 * Why an internal namespace policy cannot allow these remotes (R6): each must be a remote of the
 * policy's ecosystem. Null when fine, including an empty list (every internal remote).
 */
export async function allowedRemotesError(
  db: DataSource | EntityManager,
  ids: readonly string[] | undefined,
  ecosystem: string | undefined
): Promise<string | null> {
  if (!ids?.length) return null;
  const refs = await loadRepositoryRefs(db, [...new Set(ids)]);
  const found = new Set(refs.map((ref) => ref.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing) return `Allowed remote ${missing} does not exist`;
  const wrong = refs.find((ref) => ref.type !== 'remote' || ref.ecosystem !== ecosystem);
  if (wrong) {
    return wrong.type !== 'remote'
      ? `${wrong.ecosystem}/${wrong.key} is a virtual repository; allowed remotes must be remote repositories`
      : `${wrong.ecosystem}/${wrong.key} is not a ${ecosystem} remote`;
  }
  return null;
}
