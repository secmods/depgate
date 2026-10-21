import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { Policy, PolicyDecision } from '../db/entities/Policy.js';
import type { PolicyConditions, PolicyResult } from './policy-engine.js';
import { compilePolicy, evaluateConditions, matchPolicyVersions } from './policy-engine.js';
import { cvesOf, evaluateVulnerabilities } from './epss-rule.js';
import { lookupEpss } from './epss.js';
import { hasActiveException } from './exception-service.js';
import { isMaliciousPackage } from './malicious-sync.js';
import { queryOSV, type OSVVuln } from './osv-provider.js';
import { PackageRepository } from '../db/entities/PackageRepository.js';
import { policyCovers, scopeIds, type ScopeContext } from './repository-scope.js';
import { resolveRemoteTargets } from './repository-resolve.js';
import { compileNamespacePatterns, firstMatchingPattern } from './namespace-patterns.js';

export type SimulationPackageInput = {
  ecosystem: string;
  name: string;
  version: string;
  /** Repository key the request went through. Default: `default`. */
  repository?: string;
  /** Key of the remote that served it, from the ledger (`sourceRepository`), when known (R5). */
  source?: string;
};

export type SimulationEntry = {
  ecosystem: string;
  name: string;
  version: string;
  /** null means the package would be allowed (no policy matched) */
  baselineDecision: PolicyDecision | null;
  /** null means the package would be allowed (no policy matched) */
  simulatedDecision: PolicyDecision | null;
  changed: boolean;
  matchedPolicyId?: string;
  matchedPolicyName?: string;
  reasons: string[];
};

export type SimulationSummary = {
  total: number;
  changed: number;
  newlyBlocked: number;
  newlyAllowed: number;
  /** Packages left out because they went through a repository outside the candidate policy's scope. */
  outOfScope: number;
};

export type SimulationReport = {
  /**
   * For toggle simulations: 'enable' if the policy was disabled (simulating enabling it),
   * 'disable' if the policy was enabled (simulating disabling it).
   * Undefined for ad-hoc policy simulations.
   */
  simulatedAction?: 'enable' | 'disable';
  summary: SimulationSummary;
  entries: SimulationEntry[];
};

export type CandidatePolicyDef = {
  name: string;
  decision: PolicyDecision;
  conditions: PolicyConditions;
  priority: number;
  /** Repositories the candidate applies to. Empty or missing: every repository. */
  repositoryIds?: string[];
};

export const AUDIT_LOG_LIMIT_MAX = 200;
export const AUDIT_LOG_LIMIT_DEFAULT = 50;

/**
 * The versions most recently downloaded or refused, from `package_usage` (requirements_event_streaming.md §5.3).
 * The name is kept: the simulation API's `useRecentAuditLog` and `auditLogLimit` choose this source.
 */
export async function fetchRecentAuditPackages(
  db: DataSource,
  limit: number
): Promise<SimulationPackageInput[]> {
  const cap = Math.min(Math.max(limit, 1), AUDIT_LOG_LIMIT_MAX);
  const rows: Array<{ ecosystem: string; package_name: string; version: string; repository: string | null; source_repository: string | null }> =
    await db.query(
      `SELECT ecosystem, package_name, version, repository, source_repository FROM package_usage
        ORDER BY last_seen_at DESC LIMIT $1`,
      [cap * 6]
    );

  const seen = new Set<string>();
  const result: SimulationPackageInput[] = [];
  for (const row of rows) {
    const repository = row.repository || 'default';
    const key = `${row.ecosystem}::${repository}::${row.package_name}::${row.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const served = row.source_repository;
    const source = served ? served.slice(served.indexOf('/') + 1) : undefined;
    result.push({ ecosystem: row.ecosystem, name: row.package_name, version: row.version, repository, source });
    if (result.length >= cap) break;
  }
  return result;
}

/** Repository IDs by `ecosystem/key`, read once per simulation. */
type RepositoryIds = Map<string, string>;

async function loadRepositoryIds(db: DataSource): Promise<RepositoryIds> {
  const rows = await db.getRepository(PackageRepository).find({ select: { id: true, ecosystem: true, key: true } });
  return new Map(rows.map((row) => [`${row.ecosystem}/${row.key}`, row.id]));
}

function packageRepositoryId(pkg: SimulationPackageInput, ids: RepositoryIds): string | null {
  return ids.get(`${pkg.ecosystem}/${pkg.repository || 'default'}`) ?? null;
}

/**
 * Which repositories a recorded request touched (R5): its URL's repository, and the remote that
 * served it when the ledger recorded one; otherwise every remote the repository searches.
 */
async function packageScope(db: DataSource, pkg: SimulationPackageInput, ids: RepositoryIds): Promise<ScopeContext> {
  const requestId = packageRepositoryId(pkg, ids);
  const sourceId = pkg.source ? (ids.get(`${pkg.ecosystem}/${pkg.source}`) ?? null) : null;
  if (sourceId) return { requestId, sourceId, memberIds: [] };
  const targets = await resolveRemoteTargets(db, pkg.ecosystem, pkg.repository || 'default').catch(() => []);
  return { requestId, sourceId: null, memberIds: targets.map((target) => target.id) };
}

/** The packages a policy with this scope covers (R5). */
async function coveredBy(
  db: DataSource,
  scope: Set<string> | null,
  packages: SimulationPackageInput[],
  ids: RepositoryIds
): Promise<SimulationPackageInput[]> {
  if (!scope) return packages;
  const out: SimulationPackageInput[] = [];
  for (const pkg of packages) {
    if (policyCovers(scope, await packageScope(db, pkg, ids))) out.push(pkg);
  }
  return out;
}

async function runEvalWithPolicies(
  db: DataSource,
  redis: Redis | null,
  policies: Policy[],
  pkg: SimulationPackageInput,
  repositoryIds: RepositoryIds
): Promise<PolicyResult | null> {
  const hasException = await hasActiveException(db, pkg.ecosystem, pkg.name, pkg.version, pkg.repository, pkg.source);
  if (hasException) return null;

  const malicious = await isMaliciousPackage(db, pkg.ecosystem, pkg.name, pkg.version);
  if (malicious.blocked) {
    return {
      decision: 'BLOCK',
      policyId: 'malicious',
      policyName: 'Malicious packages list',
      reasons: [malicious.reason ?? `Package "${pkg.name}" is in the malicious packages list`],
      remediation: 'Contact your administrator to review the malicious package entry.',
    };
  }

  const ctx = { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem };

  const scope = policies.some((policy) => scopeIds(policy.repositoryIds))
    ? await packageScope(db, pkg, repositoryIds)
    : { requestId: null, sourceId: null, memberIds: [] };
  for (const policy of policies) {
    const conditions = (policy.conditions ?? {}) as PolicyConditions;
    if (conditions.ecosystem?.length && !conditions.ecosystem.includes(pkg.ecosystem)) {
      continue;
    }
    if (!policyCovers(scopeIds(policy.repositoryIds), scope)) continue;

    // The Scorecard rule needs the repository's score, which only the engine's fact loading reads.
    const compiled = compilePolicy(policy);
    if (compiled.scorecard) {
      const matched = (
        await matchPolicyVersions(db, redis, compiled, pkg.ecosystem, pkg.name, [pkg.version], pkg.repository || 'default')
      ).get(pkg.version);
      if (matched?.match === true) {
        return { decision: policy.decision, policyId: policy.id, policyName: policy.name, reasons: matched.reasons };
      }
      continue;
    }

    const { match, reasons } = evaluateConditions(ctx, conditions, undefined, policy.decision);
    const hasCveConditions = (conditions.cveBlockList?.length ?? 0) > 0 || compiled.cvss !== null || compiled.epss !== null;
    const hasOtherConditions =
      (conditions.packageBlockList?.length ?? 0) > 0 ||
      (conditions.licenseDenyList?.length ?? 0) > 0 ||
      (conditions.licenseAllowList?.length ?? 0) > 0 ||
      !!conditions.versionRange ||
      (conditions.releaseAgeMinDays != null && conditions.releaseAgeMinDays > 0) ||
      (conditions.releaseAgeMaxHours != null && conditions.releaseAgeMaxHours > 0) ||
      (conditions.releaseTypes?.length ?? 0) > 0;

    if (!hasCveConditions) {
      if (match) {
        return { decision: policy.decision, policyId: policy.id, policyName: policy.name, reasons };
      }
      continue;
    }
    if (!match && hasOtherConditions) continue;
    if (!redis) continue;
    // A reserved internal name is never sent to OSV (internal packages are not there either).
    if (reservedByAny(policies, pkg.ecosystem, pkg.name)) continue;

    try {
      const osvResp = await queryOSV(redis, pkg.ecosystem, pkg.name, pkg.version);
      const vulns = (osvResp.vulns ?? []) as OSVVuln[];
      const epss = compiled.epss ? await lookupEpss(db, cvesOf(vulns)) : null;
      const outcome = evaluateVulnerabilities(
        vulns,
        { cveBlockList: conditions.cveBlockList ?? [], cvss: compiled.cvss, epss: compiled.epss },
        epss
      );
      if (!outcome) continue;
      const cveReasons = outcome.reasons;
      return {
        decision: policy.decision,
        policyId: policy.id,
        policyName: policy.name,
        reasons: [...reasons, ...cveReasons],
      };
    } catch {
      if (match) {
        return { decision: policy.decision, policyId: policy.id, policyName: policy.name, reasons };
      }
    }
  }

  return null;
}

function reservedByAny(policies: Policy[], ecosystem: string, name: string): boolean {
  return policies.some((policy) => {
    const conditions = (policy.conditions ?? {}) as PolicyConditions;
    if (!conditions.reservedNamespaces?.length || conditions.ecosystem?.[0] !== ecosystem) return false;
    return firstMatchingPattern(ecosystem, compileNamespacePatterns(ecosystem, conditions.reservedNamespaces), name) !== null;
  });
}

function buildSummary(entries: SimulationEntry[], outOfScope = 0): SimulationSummary {
  const changed = entries.filter((e) => e.changed);
  return {
    outOfScope,
    total: entries.length,
    changed: changed.length,
    newlyBlocked: changed.filter(
      (e) => e.simulatedDecision === 'BLOCK' && e.baselineDecision !== 'BLOCK'
    ).length,
    // "Newly allowed" = was blocked, will now pass through (null) or be explicitly ALLOWed
    newlyAllowed: changed.filter(
      (e) => (e.simulatedDecision === null || e.simulatedDecision === 'ALLOW') && e.baselineDecision === 'BLOCK'
    ).length,
  };
}

async function diffPolicySets(
  db: DataSource,
  redis: Redis | null,
  baselinePolicies: Policy[],
  simulatedPolicies: Policy[],
  packages: SimulationPackageInput[],
  repositoryIds: RepositoryIds
): Promise<SimulationEntry[]> {
  const entries: SimulationEntry[] = [];
  for (const pkg of packages) {
    const [baselineResult, simulatedResult] = await Promise.all([
      runEvalWithPolicies(db, redis, baselinePolicies, pkg, repositoryIds),
      runEvalWithPolicies(db, redis, simulatedPolicies, pkg, repositoryIds),
    ]);

    const baselineDecision = baselineResult?.decision ?? null;
    const simulatedDecision = simulatedResult?.decision ?? null;
    entries.push({
      ecosystem: pkg.ecosystem,
      name: pkg.name,
      version: pkg.version,
      baselineDecision,
      simulatedDecision,
      changed: baselineDecision !== simulatedDecision,
      matchedPolicyId: simulatedResult?.policyId,
      matchedPolicyName: simulatedResult?.policyName,
      reasons: simulatedResult?.reasons ?? [],
    });
  }
  return entries;
}

/**
 * Simulate adding a new (or hypothetical) policy alongside the current enabled policy set.
 * Baseline: current enabled policies.
 * Simulated: current enabled policies + candidate policy inserted at its priority.
 */
export async function simulatePolicy(
  db: DataSource,
  redis: Redis | null,
  candidate: CandidatePolicyDef,
  packages: SimulationPackageInput[]
): Promise<SimulationReport> {
  const currentPolicies = await db.getRepository(Policy).find({
    where: { isEnabled: true },
    order: { priority: 'ASC' },
  });

  const syntheticPolicy = Object.assign(new Policy(), {
    id: 'simulated',
    name: candidate.name,
    decision: candidate.decision,
    conditions: candidate.conditions,
    priority: candidate.priority,
    isEnabled: true,
    repositoryIds: candidate.repositoryIds ?? [],
  });

  const simulatedPolicies = [...currentPolicies, syntheticPolicy].sort(
    (a, b) => a.priority - b.priority
  );

  const repositoryIds = await loadRepositoryIds(db);
  const inScope = await coveredBy(db, scopeIds(syntheticPolicy.repositoryIds), packages, repositoryIds);
  const entries = await diffPolicySets(db, redis, currentPolicies, simulatedPolicies, inScope, repositoryIds);
  return { summary: buildSummary(entries, packages.length - inScope.length), entries };
}

/**
 * Simulate toggling an existing policy's enabled state.
 * If the policy is currently enabled  → simulate with it removed (shows impact of disabling).
 * If the policy is currently disabled → simulate with it added  (shows impact of enabling).
 */
export async function simulatePolicyToggle(
  db: DataSource,
  redis: Redis | null,
  policy: Policy,
  packages: SimulationPackageInput[]
): Promise<SimulationReport> {
  const currentPolicies = await db.getRepository(Policy).find({
    where: { isEnabled: true },
    order: { priority: 'ASC' },
  });

  let baselinePolicies: Policy[];
  let simulatedPolicies: Policy[];
  let simulatedAction: 'enable' | 'disable';

  if (policy.isEnabled) {
    // Currently ON → simulate turning it OFF
    simulatedAction = 'disable';
    baselinePolicies = currentPolicies;
    simulatedPolicies = currentPolicies.filter((p) => p.id !== policy.id);
  } else {
    // Currently OFF → simulate turning it ON
    simulatedAction = 'enable';
    baselinePolicies = currentPolicies;
    simulatedPolicies = [...currentPolicies, policy].sort((a, b) => a.priority - b.priority);
  }

  const repositoryIds = await loadRepositoryIds(db);
  const inScope = await coveredBy(db, scopeIds(policy.repositoryIds), packages, repositoryIds);
  const entries = await diffPolicySets(db, redis, baselinePolicies, simulatedPolicies, inScope, repositoryIds);
  return { simulatedAction, summary: buildSummary(entries, packages.length - inScope.length), entries };
}
