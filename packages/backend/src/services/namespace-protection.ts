import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { In, MoreThan, type DataSource } from 'typeorm';
import { Exception } from '../db/entities/Exception.js';
import type { Policy } from '../db/entities/Policy.js';
import {
  compilePolicy,
  getCompiledPolicies,
  type CompiledPolicy,
  type MonitorMatch,
  type PolicyResult,
} from './policy-engine.js';
import {
  remoteSourcesSignature,
  repositoryIdFor,
  resolveRemoteTargets,
  type RemoteTarget,
} from './repository-resolve.js';
import { inRepositoryScope, policyCovers, scopeIds } from './repository-scope.js';
import { canonicalName, firstMatchingPattern } from './namespace-patterns.js';
import { hostIsPublicRegistry } from './deps-dev.js';

/**
 * Internal namespace rule (dependency confusion). A name in an enforced reserved namespace is
 * fetched only from internal remotes, through every repository including `all` and other virtual
 * ones, and is never looked up on a public registry or public data service.
 */

export type NamespaceMatch = {
  policyId: string;
  policyName: string;
  mode: 'enforce' | 'monitor';
  /** The reserved pattern as the admin wrote it, e.g. `@acme`. */
  pattern: string;
  /** When monitoring (re)started, so monitor counters restart with it. */
  modeEpoch?: number;
  /** Remotes the policy allows for the names; null for every internal remote (R6). */
  allowedRemoteIds?: readonly string[] | null;
};

/** Whether a remote may serve names the match reserves: an allowed remote, or by default an internal one. */
export function remoteAllowed(match: Pick<NamespaceMatch, 'allowedRemoteIds'>, remote: Pick<RemoteTarget, 'id' | 'source'>): boolean {
  return match.allowedRemoteIds?.length ? match.allowedRemoteIds.includes(remote.id) : remote.source === 'internal';
}

export type PackageRoute = {
  ecosystem: string;
  repoKey: string;
  /** Null for documents that are not about one package (Composer `packages.json`, RubyGems `versions`). */
  packageName: string | null;
  /** What to fetch from, in order. For an enforced reserved name, internal remotes only. */
  targets: RemoteTarget[];
  /**
   * Repository part of metadata and facts cache keys. For an enforced reserved name it carries the
   * namespace epoch, so a document cached before the policy (possibly from a public remote) is never served.
   */
  cacheScope: string;
  /** The enforced namespace policy that restricts this name, or null. */
  reserved: NamespaceMatch | null;
  /** Monitor-mode namespace policies the name falls in. Resolution is unchanged for them. */
  monitored: NamespaceMatch[];
  /** Public remotes the repository has that were not consulted. */
  skipped: RemoteTarget[];
  /** Set when the repository has no internal remote: every request for the name is blocked. */
  block: PolicyResult | null;
  /**
   * The remote that serves (or listed) the package, for policies scoped to a member remote (R5).
   * Memoized; may probe the remotes. Null when unknown. Unset: the route never tracked it.
   */
  servingSource?: () => Promise<RemoteTarget | null>;
};

/** Why a namespace policy that the name falls in does not restrict it. */
export type NamespaceLift = 'publicPackages' | 'exception' | 'scope';

export type NamespaceEvaluation = {
  matches: Array<NamespaceMatch & { lifted: NamespaceLift | null }>;
};

type EcosystemRules = { rules: CompiledPolicy[]; signature: string };

const rulesCache = new WeakMap<CompiledPolicy[], Map<string, EcosystemRules>>();

/** Enabled namespace policies of one ecosystem, in priority order, with a signature of their settings. */
function namespaceRules(policies: CompiledPolicy[], ecosystem: string): EcosystemRules {
  let byEco = rulesCache.get(policies);
  if (!byEco) {
    byEco = new Map();
    rulesCache.set(policies, byEco);
  }
  let entry = byEco.get(ecosystem);
  if (!entry) {
    const rules = policies.filter((policy) => policy.namespace?.ecosystem === ecosystem);
    const signature = rules
      .map((policy) =>
        JSON.stringify([
          policy.id,
          policy.mode,
          policy.namespace!.patterns.map((pattern) => pattern.raw),
          policy.namespace!.publicPackages.length,
          policy.namespace!.allowedRemoteIds ? [...policy.namespace!.allowedRemoteIds].sort() : null,
          policy.repositoryIds ? [...policy.repositoryIds].sort() : null,
        ])
      )
      .join('\n');
    entry = { rules, signature };
    byEco.set(ecosystem, entry);
  }
  return entry;
}

/** Signature of every input that changes which remotes serve a reserved name. */
export async function namespaceEpoch(db: DataSource, ecosystem: string, policies?: CompiledPolicy[]): Promise<string> {
  const list = policies ?? (await getCompiledPolicies(db));
  const { signature } = namespaceRules(list, ecosystem);
  const remotes = await remoteSourcesSignature(db, ecosystem);
  return createHash('sha1').update(`${signature}\n${remotes}`).digest('hex').slice(0, 10);
}

/**
 * Which namespace policies the name falls in, and which of them do not restrict it: a name in the
 * policy's `publicPackages`, an unexpired exception scoped to the policy, or a repository outside its scope.
 * A global exception never lifts the rule (D4).
 */
export async function evaluateNamespace(
  db: DataSource,
  ecosystem: string,
  repoKey: string,
  name: string,
  policies: CompiledPolicy[],
  /** Remotes the repository searches. A policy scoped to one of them covers the request too (R5). */
  memberIds: readonly string[] = []
): Promise<NamespaceEvaluation> {
  const { rules } = namespaceRules(policies, ecosystem);
  if (rules.length === 0) return { matches: [] };
  const canonical = canonicalName(ecosystem, name);
  const hits: Array<{ policy: CompiledPolicy; pattern: string }> = [];
  for (const policy of rules) {
    const pattern = firstMatchingPattern(ecosystem, policy.namespace!.patterns, name);
    if (pattern) hits.push({ policy, pattern: pattern.raw });
  }
  if (hits.length === 0) return { matches: [] };

  const repositoryId = hits.some((hit) => hit.policy.repositoryIds)
    ? await repositoryIdFor(db, ecosystem, repoKey || 'default')
    : null;
  // The rule chooses which remotes may be asked, so it cannot wait for the serving remote:
  // a scope naming any remote the repository searches covers the request.
  const scope = { requestId: repositoryId, sourceId: null, memberIds };
  const candidates = hits.filter(
    (hit) =>
      policyCovers(hit.policy.repositoryIds, scope) &&
      !hit.policy.namespace!.publicPackages.some((matches) => matches(canonical))
  );
  const excepted = new Set<string>();
  // Only real policies can have exceptions; a candidate being tried in the form has a placeholder ID.
  const exceptionPolicyIds = candidates.map((hit) => hit.policy.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (exceptionPolicyIds.length > 0) {
    const rows = await db.getRepository(Exception).find({
      where: { ecosystem, policyId: In(exceptionPolicyIds), expiresAt: MoreThan(new Date()) },
    });
    const exceptionRepoId =
      repositoryId ?? (rows.some((row) => scopeIds(row.repositoryIds)) ? await repositoryIdFor(db, ecosystem, repoKey || 'default') : null);
    for (const row of rows) {
      if (canonicalName(ecosystem, row.packageName) !== canonical) continue;
      if (!inRepositoryScope(scopeIds(row.repositoryIds), exceptionRepoId)) continue;
      if (row.policyId) excepted.add(row.policyId);
    }
  }
  return {
    matches: hits.map((hit) => {
      const base: NamespaceMatch = {
        policyId: hit.policy.id,
        policyName: hit.policy.name,
        mode: hit.policy.mode,
        pattern: hit.pattern,
        modeEpoch: hit.policy.modeEpoch,
        allowedRemoteIds: hit.policy.namespace!.allowedRemoteIds ? [...hit.policy.namespace!.allowedRemoteIds] : null,
      };
      let lifted: NamespaceLift | null = null;
      if (!policyCovers(hit.policy.repositoryIds, scope)) lifted = 'scope';
      else if (hit.policy.namespace!.publicPackages.some((matches) => matches(canonical))) lifted = 'publicPackages';
      else if (excepted.has(hit.policy.id)) lifted = 'exception';
      return { ...base, lifted };
    }),
  };
}

export function remoteLabel(ecosystem: string, target: Pick<RemoteTarget, 'key'>): string {
  return `${ecosystem}/${target.key}`;
}

function listLabels(ecosystem: string, targets: RemoteTarget[]): string {
  return targets.map((target) => remoteLabel(ecosystem, target)).join(', ');
}

/** The reserved pattern behind a namespace block, so its event can say DEPENDENCY_CONFUSION_BLOCKED. */
const namespaceBlocks = new WeakMap<PolicyResult, string>();

export function namespaceBlockPattern(result: PolicyResult | null | undefined): string | undefined {
  return result ? namespaceBlocks.get(result) : undefined;
}

export function namespaceBlockResult(match: NamespaceMatch, ecosystem: string, repoKey: string, name: string): PolicyResult {
  const result: PolicyResult = {
    decision: 'BLOCK',
    policyId: match.policyId,
    policyName: match.policyName,
    reasons: [
      match.allowedRemoteIds?.length
        ? `Package "${name}" is in reserved namespace "${match.pattern}" and repository "${ecosystem}/${repoKey || 'default'}" has none of the remotes allowed to serve it`
        : `Package "${name}" is in reserved namespace "${match.pattern}" and repository "${ecosystem}/${repoKey || 'default'}" has no internal remote`,
    ],
    remediation: match.allowedRemoteIds?.length
      ? 'Use a repository that includes a remote the namespace policy allows, or ask Security to review the policy'
      : 'Add an internal remote that hosts this package to the repository, or ask Security to review the namespace policy',
  };
  namespaceBlocks.set(result, match.pattern);
  return result;
}

/** The D6 outcome: a reserved name that no internal remote has. Answered with 404; the public remotes were never asked. */
export function namespaceNotFoundResult(route: PackageRoute): PolicyResult | null {
  if (!route.reserved || !route.packageName) return null;
  return {
    decision: 'BLOCK',
    policyId: route.reserved.policyId,
    policyName: route.reserved.policyName,
    reasons: [
      route.reserved.allowedRemoteIds?.length
        ? `Package "${route.packageName}" is in reserved namespace "${route.reserved.pattern}" and was not found in the remotes allowed to serve it (${listLabels(route.ecosystem, route.targets)}). Other remotes were not consulted.`
        : `Package "${route.packageName}" is in reserved namespace "${route.reserved.pattern}" and was not found in internal remotes (${listLabels(route.ecosystem, route.targets)}). Public remotes were not consulted.`,
    ],
  };
}

/** Short signature of a target list's order. Part of a virtual repository's cache scope (R2). */
export function orderSignature(targets: ReadonlyArray<Pick<RemoteTarget, 'id'>>): string {
  return createHash('sha1')
    .update(targets.map((target) => target.id).join(','))
    .digest('hex')
    .slice(0, 8);
}

/**
 * A virtual repository's cached documents depend on the order of its remotes (the first that has
 * the package serves it), so its cache scope carries that order: reordering takes effect at once (R2).
 */
function scopeFor(repoKey: string, targets: RemoteTarget[]): string {
  return targets.length > 1 ? `${repoKey}~o-${orderSignature(targets)}` : repoKey;
}

function plainRoute(ecosystem: string, repoKey: string, name: string | null, targets: RemoteTarget[]): PackageRoute {
  return {
    ecosystem,
    repoKey,
    packageName: name,
    targets,
    cacheScope: scopeFor(repoKey, targets),
    reserved: null,
    monitored: [],
    skipped: [],
    block: null,
  };
}

export type ResolveOptions = {
  /** Policies to use instead of the cached list (Package check reads them verified; the form tries a candidate). */
  policies?: CompiledPolicy[];
};

/**
 * The one way to find the remotes for a package request. Every metadata and artifact fetch goes
 * through it (a test enforces that), so no path can skip the internal namespace filter.
 */
export async function resolvePackageTargets(
  db: DataSource,
  ecosystem: string,
  repoKey: string,
  name: string | null | undefined,
  options?: ResolveOptions
): Promise<PackageRoute> {
  const key = repoKey || 'default';
  const targets = await resolveRemoteTargets(db, ecosystem, key);
  if (!name) return plainRoute(ecosystem, key, null, targets);
  const policies = options?.policies ?? (await getCompiledPolicies(db));
  // Most requests stop here: no namespace policy for the ecosystem, or the name is in none of them.
  if (namespaceRules(policies, ecosystem).rules.length === 0) return plainRoute(ecosystem, key, name, targets);
  const { matches } = await evaluateNamespace(
    db,
    ecosystem,
    key,
    name,
    policies,
    targets.map((target) => target.id)
  );
  const active = matches.filter((match) => match.lifted === null);
  if (active.length === 0) return plainRoute(ecosystem, key, name, targets);

  const strip = ({ lifted: _lifted, ...match }: NamespaceMatch & { lifted: NamespaceLift | null }): NamespaceMatch => match;
  const enforced = active.find((match) => match.mode === 'enforce');
  const monitored = active.filter((match) => match.mode === 'monitor').map(strip);
  if (!enforced) return { ...plainRoute(ecosystem, key, name, targets), monitored };

  const reserved = strip(enforced);
  // R6: only the remotes the policy allows, by default every internal one, in the repository's order.
  const internal = targets.filter((target) => remoteAllowed(reserved, target));
  const skipped = targets.filter((target) => !remoteAllowed(reserved, target));
  return {
    ecosystem,
    repoKey: key,
    packageName: name,
    targets: internal,
    cacheScope: `${scopeFor(key, internal)}~ns-${await namespaceEpoch(db, ecosystem, policies)}`,
    reserved,
    monitored: [],
    skipped,
    block: internal.length === 0 ? namespaceBlockResult(reserved, ecosystem, key, name) : null,
  };
}

/** A not-yet-saved policy, compiled like a saved one, for the form's "Try a name" box. */
export function compileCandidate(conditions: Record<string, unknown>, extra?: Partial<Policy>): CompiledPolicy {
  return compilePolicy({
    id: 'candidate',
    name: extra?.name ?? 'This policy',
    description: null,
    decision: 'BLOCK',
    conditions,
    priority: -1,
    isEnabled: true,
    mode: extra?.mode ?? 'enforce',
    modeChangedAt: null,
    repositoryIds: extra?.repositoryIds ?? [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Policy);
}

/** The remote whose URL the address belongs to, or null. */
export function targetForUrl(targets: readonly RemoteTarget[], url: string | undefined | null): RemoteTarget | null {
  if (!url) return null;
  return (
    [...targets]
      .sort((a, b) => b.url.length - a.url.length)
      .find((target) => url === target.url || url.startsWith(`${target.url.replace(/\/$/, '')}/`)) ?? null
  );
}

/**
 * What monitor-mode namespace policies record when a public remote served a reserved name.
 * Nothing when an enforced policy already restricts the name or an internal remote served it.
 */
export function namespaceMonitorMatches(
  route: PackageRoute,
  served: Pick<RemoteTarget, 'id' | 'key' | 'source'> | null
): MonitorMatch[] {
  if (route.reserved || route.monitored.length === 0 || !served) return [];
  const label = remoteLabel(route.ecosystem, served);
  return route.monitored.filter((match) => !remoteAllowed(match, served)).map((match) => ({
    policyId: match.policyId,
    policyName: match.policyName,
    reasons: [
      match.allowedRemoteIds?.length
        ? `Served from ${label}, which the policy does not allow; enforcing would block it`
        : `Served from public remote ${label}; enforcing would block it`,
    ],
    reasonKey: `namespace:${match.pattern}`,
    modeEpoch: match.modeEpoch,
  }));
}

/** Reserved names are internal: their names must not reach OSV, deps.dev or Scorecard. */
export function isPrivateName(route: Pick<PackageRoute, 'reserved' | 'monitored'>): boolean {
  return route.reserved !== null || route.monitored.length > 0;
}

const NOT_FOUND_WINDOW_SECONDS = 60;

/**
 * Whether to write the D6 ledger row. A broken build can ask for the same missing reserved name
 * thousands of times; one row per name, version and repository per minute is enough to see it.
 */
export async function shouldRecordNotFound(redis: Redis | null | undefined, route: PackageRoute, version: string | null): Promise<boolean> {
  if (!redis || typeof redis.set !== 'function') return true;
  try {
    const key = `ns:404:${route.ecosystem}:${route.repoKey}:${route.packageName}:${version ?? ''}`;
    return (await redis.set(key, '1', 'EX', NOT_FOUND_WINDOW_SECONDS, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

const EXTRA_PUBLIC_HOSTS: Record<string, readonly string[]> = {
  composer: ['repo.packagist.org', 'packagist.org'],
};

/** A URL of a well-known public registry. Used to warn about a remote marked internal by mistake. */
export function isKnownPublicRegistry(ecosystem: string, url: string | null | undefined): boolean {
  if (!url) return false;
  if (hostIsPublicRegistry(ecosystem, url)) return true;
  try {
    return (EXTRA_PUBLIC_HOSTS[ecosystem] ?? []).includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
