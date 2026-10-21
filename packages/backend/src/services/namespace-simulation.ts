import type { DataSource } from 'typeorm';
import type { PolicyConditions } from './policy-engine.js';
import {
  canonicalName,
  compileNamespacePatterns,
  compilePublicPackages,
  firstMatchingPattern,
} from './namespace-patterns.js';
import type { SimulationEntry, SimulationReport } from './policy-simulation.js';

export type NamespaceSourceGroup = {
  /** `npm/acme-artifactory`, or null when the row predates source recording. */
  sourceRepository: string | null;
  sourceType: 'internal' | 'public' | null;
  /** Downloads in the window. */
  count: number;
  /** Distinct `name@version`, newest first, at most 20. */
  packages: string[];
};

export type NamespaceSimulation = {
  /** Unaffected: an internal remote served them. */
  servedInternal: number;
  /** Would be blocked: a public remote served them. */
  servedPublic: number;
  /** Rows without a recorded source; enforcing may or may not change them. */
  noSource: number;
  groups: NamespaceSourceGroup[];
};

/** Usage rows read to find matching names: allowed versions, newest first. */
const SCAN_ROWS = 2000;

/**
 * What enforcing an internal namespace policy would change, from the versions most recently downloaded
 * (`package_usage`) whose names fall in its reserved namespaces, grouped by the remote that served them (§8).
 */
export async function simulateNamespacePolicy(
  db: DataSource,
  conditions: PolicyConditions,
  limit: number,
  name = 'This policy'
): Promise<SimulationReport & { namespace: NamespaceSimulation }> {
  const ecosystem = conditions.ecosystem?.[0] ?? '';
  const patterns = compileNamespacePatterns(ecosystem, conditions.reservedNamespaces);
  const publicPackages = compilePublicPackages(ecosystem, conditions.publicPackages);
  const usage: Array<{ package_name: string; version: string; source_repository: string | null; source_type: string | null }> =
    await db.query(
      `SELECT package_name, version, source_repository, source_type FROM package_usage
        WHERE ecosystem = $1 AND decision = 'ALLOW' ORDER BY last_seen_at DESC LIMIT $2`,
      [ecosystem, SCAN_ROWS]
    );
  const rows = usage.map((row) => ({
    packageName: row.package_name,
    resolvedVersion: row.version,
    metadata: { sourceRepository: row.source_repository ?? undefined, sourceType: row.source_type ?? undefined },
  }));

  const matching = rows
    .filter((row) => {
      if (!firstMatchingPattern(ecosystem, patterns, row.packageName)) return false;
      const canonical = canonicalName(ecosystem, row.packageName);
      return !publicPackages.some((matches) => matches(canonical));
    })
    .slice(0, Math.max(limit, 1));

  const groups = new Map<string, NamespaceSourceGroup>();
  const entries: SimulationEntry[] = [];
  const result: NamespaceSimulation = { servedInternal: 0, servedPublic: 0, noSource: 0, groups: [] };
  for (const row of matching) {
    const sourceRepository = row.metadata?.sourceRepository ?? null;
    const raw = row.metadata?.sourceType;
    const sourceType = raw === 'internal' || raw === 'public' ? raw : null;
    if (sourceType === 'internal') result.servedInternal += 1;
    else if (sourceType === 'public') result.servedPublic += 1;
    else result.noSource += 1;
    const key = `${sourceRepository ?? ''}|${sourceType ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { sourceRepository, sourceType, count: 0, packages: [] };
      groups.set(key, group);
    }
    group.count += 1;
    const label = `${row.packageName}@${row.resolvedVersion}`;
    if (group.packages.length < 20 && !group.packages.includes(label)) group.packages.push(label);
    const pattern = firstMatchingPattern(ecosystem, patterns, row.packageName)!;
    const blocked = sourceType === 'public';
    entries.push({
      ecosystem,
      name: row.packageName,
      version: row.resolvedVersion!,
      baselineDecision: null,
      simulatedDecision: blocked ? 'BLOCK' : null,
      changed: blocked,
      matchedPolicyName: blocked ? name : undefined,
      reasons: blocked
        ? [`Served from public remote ${sourceRepository}; in reserved namespace "${pattern.raw}"`]
        : sourceType === 'internal'
          ? [`Served from internal remote ${sourceRepository}; unaffected`]
          : ['No source recorded for this download'],
    });
  }
  result.groups = [...groups.values()].sort((a, b) => b.count - a.count);
  return {
    summary: {
      total: entries.length,
      changed: result.servedPublic,
      newlyBlocked: result.servedPublic,
      newlyAllowed: 0,
      outOfScope: 0,
    },
    entries,
    namespace: result,
  };
}
