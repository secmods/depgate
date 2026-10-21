import { ECOSYSTEMS, namesFor, namesWhere } from './catalog.js';

/** Created by setup() and deleted by teardown(). Cleanup also matches this prefix. */
export const POLICY_PREFIX = 'k6-load:';

/** Disabled policy whose description remembers policies this run paused, so a killed run can be restored. */
export const RESTORE_NAME = `${POLICY_PREFIX} restore`;

export const SCENARIOS = ['mixed', 'allow', 'block-package', 'block-license', 'block-cve', 'allowlist', 'scoped', 'namespace', 'scorecard', 'epss', 'cached'];

/** Overall minimum of the scorecard scenario: low enough that no catalog project falls below it. */
export const SCORECARD_MIN = 0.5;

/** Reserved patterns per ecosystem in the namespace scenario. None matches a catalog name. */
export const NAMESPACE_PATTERNS = 50;

/** Decoy policies per ecosystem in the scoped scenario. They are scoped to another repository. */
export const SCOPED_DECOYS = 10;

export const SCENARIO_NOTES = {
  mixed: 'One ALLOW policy and one BLOCK policy per ecosystem. Other enabled policies are paused for the run.',
  allow: 'No k6 allow or block rules. Other enabled policies are paused, so this is a clean passthrough.',
  'block-package': 'One BLOCK policy whose package list is the deny set in catalog.js.',
  'block-license': 'BLOCK when the license matches *MIT*, *GPL*, or *MPL*. This loads license facts.',
  'block-cve': 'BLOCK when OSV reports HIGH or CRITICAL. This is the vulnerability lookup path.',
  allowlist: 'ALLOW the approve set, BLOCK other semver versions, then BLOCK the deny set by name.',
  scoped:
    'The mixed policies scoped to the default remote, behind 10 BLOCK decoys per ecosystem scoped to a decoy remote that never serves. Run with REPO=all and compare with mixed.',
  namespace:
    'The mixed policies, plus one Internal namespace policy per ecosystem with 50 reserved patterns that no catalog name falls in. Compare with mixed.',
  epss: 'BLOCK when OSV reports HIGH or CRITICAL and that same vulnerability has EPSS ≥ 10 %. Compare with block-cve (severity only).',
  scorecard:
    'The mixed policies behind one enforced Project health (OpenSSF Scorecard) policy per ecosystem, evaluated first: overall at least 0.5, unknown and unavailable let through. Run it twice (the first run fills the Scorecard caches) and compare the second with mixed.',
  cached:
    'No k6 rules. Clears the artifact cache, installs each ecosystem once cold (files fetched and stored), then repeats warm (files served from the cache). Needs ARTIFACT_CACHE_ENABLED on the gateway.',
};

/** Scenarios whose deny pins must 403 and whose approve pins must download. */
export function expectsNameSplit(scenario) {
  return (
    scenario === 'mixed' ||
    scenario === 'block-package' ||
    scenario === 'allowlist' ||
    scenario === 'scoped' ||
    scenario === 'namespace' ||
    scenario === 'scorecard'
  );
}

/**
 * Policies for one scenario. Empty for allow, which is the passthrough baseline.
 * packageBlockList is the engine's name matcher; the decision field says allow or block.
 */
export function policiesFor(scenario, ecosystems = ECOSYSTEMS, repositories = {}) {
  if (scenario === 'mixed') return mixedPolicies(ecosystems);
  if (scenario === 'scoped') return scopedPolicies(ecosystems, repositories);
  if (scenario === 'namespace') return [...mixedPolicies(ecosystems), ...namespacePolicies(ecosystems)];
  if (scenario === 'scorecard') return [...scorecardPolicies(ecosystems), ...mixedPolicies(ecosystems)];
  if (scenario === 'allow' || scenario === 'cached') return [];

  if (scenario === 'block-package') {
    return [
      {
        name: `${POLICY_PREFIX} block named packages`,
        description: 'k6 load test. Safe to delete.',
        decision: 'BLOCK',
        priority: 10,
        isEnabled: true,
        conditions: { packageBlockList: namesWhere('deny') },
      },
    ];
  }

  if (scenario === 'block-license') {
    return [
      {
        name: `${POLICY_PREFIX} deny copyleft and MIT`,
        description: 'k6 load test. Safe to delete.',
        decision: 'BLOCK',
        priority: 10,
        isEnabled: true,
        conditions: { licenseDenyList: ['*MIT*', '*GPL*', '*MPL*'] },
      },
    ];
  }

  if (scenario === 'block-cve') {
    return [
      {
        name: `${POLICY_PREFIX} block high severity CVEs`,
        description: 'k6 load test. Safe to delete.',
        decision: 'BLOCK',
        priority: 10,
        isEnabled: true,
        conditions: { cveSeverityThreshold: 'HIGH' },
      },
    ];
  }

  if (scenario === 'epss') {
    return [
      {
        name: `${POLICY_PREFIX} block likely-exploited HIGH CVEs`,
        description: 'k6 load test. Safe to delete.',
        decision: 'BLOCK',
        priority: 10,
        isEnabled: true,
        conditions: { cveSeverityThreshold: 'HIGH', epssMin: 0.1 },
      },
    ];
  }

  if (scenario === 'allowlist') {
    return [
      {
        name: `${POLICY_PREFIX} allow approved packages`,
        description: 'k6 load test. Safe to delete.',
        decision: 'ALLOW',
        priority: 1,
        isEnabled: true,
        conditions: { packageBlockList: namesWhere('approve') },
      },
      {
        name: `${POLICY_PREFIX} default deny versions`,
        description: 'k6 load test. Safe to delete. Semver only; four-part versions fall through.',
        decision: 'BLOCK',
        priority: 50,
        isEnabled: true,
        // A version rule needs package names; ** matches every name, scoped and slashed ones included.
        conditions: { packageBlockList: ['**'], versionRange: '>=0.0.0' },
      },
      {
        name: `${POLICY_PREFIX} default deny names`,
        description: 'k6 load test. Safe to delete. Catches deny-set versions semver does not parse.',
        decision: 'BLOCK',
        priority: 90,
        isEnabled: true,
        conditions: { packageBlockList: namesWhere('deny') },
      },
    ];
  }

  throw new Error(`Unknown scenario "${scenario}". Use one of: ${SCENARIOS.join(', ')}`);
}

/** Separate ALLOW and BLOCK policies so each ecosystem's decision is its own rule. */
function mixedPolicies(ecosystems) {
  const policies = [];
  ecosystems.forEach((eco, index) => {
    const approve = namesFor(eco, 'approve');
    const deny = namesFor(eco, 'deny');
    const base = 10 + index * 2;
    if (approve.length > 0) {
      policies.push(rule(`${POLICY_PREFIX} allow ${eco}`, 'ALLOW', base, { ecosystem: [eco], packageBlockList: approve }));
    }
    if (deny.length > 0) {
      policies.push(rule(`${POLICY_PREFIX} block ${eco}`, 'BLOCK', base + 1, { ecosystem: [eco], packageBlockList: deny }));
    }
  });
  return policies;
}

/**
 * The mixed policies scoped to the `default` remote, and ahead of them decoys that block the
 * approve pins but are scoped to a remote that never serves. Through `all`, the policies must
 * follow the serving remote (R5): a decoy that applied would turn approve pins into 403s, and a
 * scoped policy that did not apply would let deny pins through; both count as unexpected.
 * `repositories[eco]` is `{ target, other }`: repository IDs.
 */
function scopedPolicies(ecosystems, repositories) {
  const policies = [];
  for (const eco of ecosystems) {
    const ids = repositories[eco];
    if (!ids || !ids.target || !ids.other) throw new Error(`scoped scenario: no repositories for ${eco}`);
    const approve = namesFor(eco, 'approve');
    for (let i = 0; i < SCOPED_DECOYS && approve.length > 0; i += 1) {
      policies.push({
        ...rule(`${POLICY_PREFIX} decoy ${eco} ${i + 1}`, 'BLOCK', 1, { ecosystem: [eco], packageBlockList: approve }),
        repositoryIds: [ids.other],
      });
    }
  }
  for (const policy of mixedPolicies(ecosystems)) {
    const eco = policy.conditions.ecosystem[0];
    policies.push({ ...policy, repositoryIds: [repositories[eco].target] });
  }
  return policies;
}

/** Reserved namespace patterns in each ecosystem's syntax, never matching the catalog (`k6-ns` names). */
export function namespacePatterns(eco, count = NAMESPACE_PATTERNS) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    switch (eco) {
      case 'npm':
        out.push(i % 2 === 0 ? `@k6-ns-${i}` : `k6-ns-${i}-*`);
        break;
      case 'go':
        out.push(`example.test/k6-ns-${i}`);
        break;
      case 'maven':
        out.push(`test.k6ns${i}`);
        break;
      case 'nuget':
        out.push(`K6Ns${i}.*`);
        break;
      case 'composer':
        out.push(`k6-ns-${i}/*`);
        break;
      default:
        out.push(`k6-ns-${i}-*`);
    }
  }
  return out;
}

/** One enforced Internal namespace policy per ecosystem. Catalog names are outside every pattern. */
function namespacePolicies(ecosystems) {
  return ecosystems.map((eco) =>
    rule(`${POLICY_PREFIX} namespace ${eco}`, 'BLOCK', 100, { ecosystem: [eco], reservedNamespaces: namespacePatterns(eco) })
  );
}

/**
 * One enforced Project health policy per ecosystem, ahead of the mixed ALLOW policies so every
 * request loads its Scorecard fact. No catalog project scores below SCORECARD_MIN.
 */
function scorecardPolicies(ecosystems) {
  return ecosystems.map((eco) => rule(`${POLICY_PREFIX} scorecard ${eco}`, 'BLOCK', 1, { ecosystem: [eco], scorecardMinScore: SCORECARD_MIN }));
}

function rule(name, decision, priority, conditions) {
  return {
    name,
    description: 'k6 load test. Safe to delete.',
    decision,
    priority,
    isEnabled: true,
    conditions,
  };
}
