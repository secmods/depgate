import type { PolicyConditions } from './policy-engine.js';
import type { PolicyDecision } from '../db/entities/Policy.js';
import {
  RELEASE_TYPE_ECOSYSTEMS,
  SELECTABLE_RELEASE_TYPES,
  releaseTypeApplies,
  type SelectableReleaseType,
} from './release-type.js';
import { versionSpecError } from './version-range.js';
import { compileNamespacePatterns, namespacePatternError, publicPackageError } from './namespace-patterns.js';
import { hasScorecardRule, scorecardConditionsError } from './scorecard-rule.js';
import { epssConditionsError, hasEpssThreshold } from './epss-rule.js';
import { cvssConditionsError, hasCvssThreshold, withCvssMin } from './cvss.js';

/**
 * A policy has an ecosystem scope and exactly one rule. Package names and versions belong
 * to the Packages rule; the other rules apply to every package in the ecosystem.
 */
export type PolicyRule = 'packages' | 'releaseType' | 'releaseAge' | 'vulnerability' | 'license' | 'namespace' | 'scorecard';

const RULE_LABELS: Record<PolicyRule, string> = {
  packages: 'packages',
  releaseType: 'release type',
  releaseAge: 'release age',
  vulnerability: 'vulnerability',
  license: 'license',
  namespace: 'internal namespace',
  scorecard: 'project health',
};

const ALL_ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];
const ECOSYSTEM_LABELS: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  cargo: 'Cargo',
  composer: 'Composer',
  rubygems: 'RubyGems',
};

function filled(list: unknown): boolean {
  return Array.isArray(list) && list.some((item) => String(item ?? '').trim() !== '');
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && value > 0;
}

/** The rules a stored condition object uses. A valid policy has exactly one. */
export function policyRules(conditions: PolicyConditions | undefined): PolicyRule[] {
  const c = conditions ?? {};
  const rules: PolicyRule[] = [];
  if (filled(c.packageBlockList) || (typeof c.versionRange === 'string' && c.versionRange.trim())) {
    rules.push('packages');
  }
  if (filled(c.releaseTypes)) rules.push('releaseType');
  if (positive(c.releaseAgeMinDays) || positive(c.releaseAgeMaxHours)) rules.push('releaseAge');
  if (filled(c.cveBlockList) || hasCvssThreshold(c) || hasEpssThreshold(c)) {
    rules.push('vulnerability');
  }
  if (filled(c.licenseDenyList) || filled(c.licenseAllowList)) rules.push('license');
  if (filled(c.reservedNamespaces)) rules.push('namespace');
  if (hasScorecardRule(c) || c.scorecardMinScore != null || filled(c.scorecardChecks)) rules.push('scorecard');
  return rules;
}

/**
 * Allow is only for the Packages rule. The other rules apply to every package in the
 * ecosystem, so an Allow there would skip every lower-priority policy for all of them.
 */
export const RULE_DECISIONS: Record<PolicyRule, readonly PolicyDecision[]> = {
  packages: ['ALLOW', 'BLOCK'],
  releaseType: ['BLOCK'],
  releaseAge: ['BLOCK'],
  vulnerability: ['BLOCK'],
  license: ['BLOCK'],
  namespace: ['BLOCK'],
  scorecard: ['BLOCK'],
};

/** Why the decision cannot be used with the policy's rule, or null when it can. */
export function ruleDecisionError(decision: PolicyDecision, conditions: PolicyConditions | undefined): string | null {
  for (const rule of policyRules(conditions)) {
    if (!RULE_DECISIONS[rule].includes(decision)) {
      return `${capitalize(RULE_LABELS[rule])} policies can block, not allow. Use an exception or a waiver to let specific packages through`;
    }
  }
  return null;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why the conditions cannot be saved as a policy, or null when they can. */
export function policyConditionsError(conditions: PolicyConditions | undefined): string | null {
  const c = withCvssMin(conditions ?? {});
  const rules = policyRules(c);
  if (rules.length === 0) {
    if (filled(c.publicPackages)) return 'Public packages belong to an internal namespace rule: add reserved namespaces';
    return 'Choose a rule: packages, release type, release age, vulnerability, license, internal namespace, or project health';
  }
  if (rules.length > 1) {
    const labels = rules.map((rule) => RULE_LABELS[rule]);
    const names = `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    return `A policy has one rule, but this one has ${names}. Create a policy for each rule`;
  }
  const ecosystems = Array.isArray(c.ecosystem) ? c.ecosystem.map(String) : [];
  const unknownEcosystem = ecosystems.find((eco) => !ALL_ECOSYSTEMS.includes(eco));
  if (unknownEcosystem) return `Unknown ecosystem "${unknownEcosystem}"`;

  switch (rules[0]) {
    case 'packages':
      if (!filled(c.packageBlockList)) return 'Add at least one package name for the versions to apply to';
      if (c.versionRange != null && typeof c.versionRange !== 'string') return 'versionRange must be a string';
      return versionSpecError(c.versionRange, ecosystems);
    case 'releaseType':
      return releaseTypesError(c.releaseTypes, ecosystems);
    case 'license':
      if (filled(c.licenseDenyList) && filled(c.licenseAllowList)) {
        return 'A license policy either blocks the listed licenses or allows only them, not both. Create a policy for each';
      }
      if (c.allowUnknownLicense != null && typeof c.allowUnknownLicense !== 'boolean') {
        return 'allowUnknownLicense must be true or false';
      }
      return null;
    case 'vulnerability':
      return cvssConditionsError(c) ?? epssConditionsError(c);
    case 'namespace':
      return namespaceRuleError(c, ecosystems);
    case 'scorecard':
      if (!hasScorecardRule(c) && scorecardConditionsError(c) === null) {
        return 'Set an overall minimum score or at least one check minimum';
      }
      return scorecardConditionsError(c);
    default:
      return null;
  }
}

function namespaceRuleError(c: PolicyConditions, ecosystems: string[]): string | null {
  if (ecosystems.length !== 1) {
    return 'An internal namespace policy applies to exactly one ecosystem, because each ecosystem names its namespaces differently';
  }
  const [ecosystem] = ecosystems;
  if (!Array.isArray(c.reservedNamespaces)) return 'reservedNamespaces must be a list';
  for (const pattern of c.reservedNamespaces) {
    const error = namespacePatternError(ecosystem, pattern);
    if (error) return error;
  }
  if (c.allowedRemotes != null) {
    const ids = c.allowedRemotes as unknown;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
      return 'allowedRemotes must be a list of repository IDs';
    }
  }
  if (c.publicPackages != null) {
    if (!Array.isArray(c.publicPackages)) return 'publicPackages must be a list';
    const patterns = compileNamespacePatterns(ecosystem, c.reservedNamespaces);
    for (const entry of c.publicPackages) {
      const error = publicPackageError(ecosystem, entry, patterns);
      if (error) return error;
    }
  }
  return null;
}

function releaseTypesError(types: unknown, ecosystems: string[]): string | null {
  const list = (types as unknown[]).map(String);
  const invalid = list.find((type) => !(SELECTABLE_RELEASE_TYPES as readonly string[]).includes(type));
  if (invalid) {
    return `releaseTypes contains "${invalid}"; allowed values are ${SELECTABLE_RELEASE_TYPES.join(', ')}`;
  }
  if (ecosystems.length === 0) return null;
  for (const type of list as SelectableReleaseType[]) {
    if (!ecosystems.some((eco) => releaseTypeApplies(type, eco))) {
      const where = (RELEASE_TYPE_ECOSYSTEMS[type] ?? []).map((eco) => ECOSYSTEM_LABELS[eco] ?? eco).join(' and ');
      return `${type} applies only to ${where}`;
    }
  }
  return null;
}
