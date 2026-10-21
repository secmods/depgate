import { describe, expect, it } from 'vitest';
import { policyConditionsError, policyRules, ruleDecisionError } from './policy-rules.js';

describe('policyRules', () => {
  it('names the rule each condition belongs to', () => {
    expect(policyRules({ packageBlockList: ['lodash'], versionRange: '<4.17.21' })).toEqual(['packages']);
    expect(policyRules({ releaseTypes: ['prerelease'] })).toEqual(['releaseType']);
    expect(policyRules({ releaseAgeMaxHours: 72 })).toEqual(['releaseAge']);
    expect(policyRules({ cvssMin: 7 })).toEqual(['vulnerability']);
    expect(policyRules({ licenseDenyList: ['GPL-3.0'] })).toEqual(['license']);
    expect(policyRules({ ecosystem: ['npm'], packageBlockList: [], releaseTypes: [] })).toEqual([]);
  });
});

describe('policyConditionsError', () => {
  it('accepts one rule with an optional ecosystem', () => {
    expect(policyConditionsError({ ecosystem: ['maven'], releaseTypes: ['prerelease', 'snapshot'] })).toBeNull();
    expect(policyConditionsError({ releaseTypes: ['prerelease', 'dev', 'snapshot', 'pseudo'] })).toBeNull();
    expect(policyConditionsError({ ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '<4.17.21' })).toBeNull();
    expect(policyConditionsError({ cveBlockList: ['CVE-2024-1234'], cvssMin: 7 })).toBeNull();
    expect(policyConditionsError({ releaseAgeMinDays: 365 })).toBeNull();
    expect(policyConditionsError({ releaseAgeMinDays: 365, releaseAgeMaxHours: 72 })).toBeNull();
  });

  it('requires exactly one rule', () => {
    expect(policyConditionsError({})).toMatch(/Choose a rule/);
    expect(policyConditionsError({ ecosystem: ['npm'] })).toMatch(/Choose a rule/);
    expect(policyConditionsError({ packageBlockList: ['lodash'], licenseDenyList: ['GPL-3.0'] })).toBe(
      'A policy has one rule, but this one has packages and license. Create a policy for each rule'
    );
    expect(policyConditionsError({ cvssMin: 7, releaseTypes: ['prerelease'] })).toMatch(
      /release type and vulnerability/
    );
  });

  it('checks the fields of the chosen rule', () => {
    expect(policyConditionsError({ versionRange: '<2.0.0' })).toMatch(/package name/);
    expect(policyConditionsError({ packageBlockList: ['x'], versionRange: '~> 1.2' })).toMatch(/is not a version/);
    expect(policyConditionsError({ cveSeverityThreshold: 'SEVERE' })).toMatch(/replaced by cvssMin/);
    expect(policyConditionsError({ cvssMin: 7.25 })).toMatch(/one decimal/);
    expect(policyConditionsError({ cvssMin: 0 })).toMatch(/0.1 to 10/);
    expect(policyConditionsError({ cvssUnknown: 'match', cvssMin: 7, licenseDenyList: ['MIT'] })).toMatch(/vulnerability and license/);
    expect(policyConditionsError({ ecosystem: ['bower'], licenseDenyList: ['MIT'] })).toMatch(/Unknown ecosystem/);
  });

  it('a severity threshold saved before CVSS is still accepted, as its CVSS minimum', () => {
    expect(policyRules({ cveSeverityThreshold: 'HIGH' })).toEqual(['vulnerability']);
    expect(policyConditionsError({ cveSeverityThreshold: 'critical', epssMin: 0.1 })).toBeNull();
  });

  it('EPSS belongs to the Vulnerability rule, alone or with a CVSS minimum', () => {
    expect(policyRules({ epssMin: 0.1 })).toEqual(['vulnerability']);
    expect(policyRules({ cvssMin: 7, epssPercentileMin: 0.95 })).toEqual(['vulnerability']);
    expect(policyConditionsError({ ecosystem: ['npm'], cvssMin: 7, epssMin: 0.1, epssUnknown: 'ignore' })).toBeNull();
    expect(policyConditionsError({ epssMin: 0.1, epssPercentileMin: 0.9 })).toMatch(/not both/);
    expect(policyConditionsError({ cvssMin: 7, epssMin: 1.5 })).toMatch(/at most 1/);
    expect(policyConditionsError({ cvssMin: 7, epssUnknown: 'ignore' })).toMatch(/needs epssMin/);
    expect(policyConditionsError({ epssMin: 0.1, licenseDenyList: ['GPL-3.0'] })).toMatch(/vulnerability and license/);
    expect(ruleDecisionError('ALLOW', { epssMin: 0.1 })).toMatch(/Vulnerability policies can block/);
  });

  it('project health (Scorecard): an overall minimum, check minimums, or both; Block only', () => {
    expect(policyRules({ scorecardMinScore: 5 })).toEqual(['scorecard']);
    expect(policyRules({ scorecardChecks: [{ name: 'Maintained', minScore: 1 }] })).toEqual(['scorecard']);
    expect(policyRules({ scorecardUnknown: 'block' })).toEqual([]);
    expect(policyConditionsError({ ecosystem: ['npm'], scorecardMinScore: 4.5, scorecardUnknown: 'allow', scorecardUnavailable: 'block' })).toBeNull();
    expect(policyConditionsError({ scorecardChecks: [{ name: 'dangerous-workflow', minScore: 10 }] })).toBeNull();
    expect(policyConditionsError({ scorecardMinScore: 10.5 })).toMatch(/from 0 to 10/);
    expect(policyConditionsError({ scorecardChecks: [{ name: 'Webhooks', minScore: 5 }] })).toMatch(/never in public results/);
    expect(policyConditionsError({ scorecardChecks: [{ name: 'Fuzz', minScore: 5 }] })).toMatch(/Unknown Scorecard check/);
    expect(policyConditionsError({ scorecardMinScore: 5, licenseDenyList: ['GPL-3.0'] })).toMatch(/license and project health/);
    expect(ruleDecisionError('ALLOW', { scorecardMinScore: 5 })).toMatch(/Project health policies can block, not allow/);
    expect(ruleDecisionError('BLOCK', { scorecardMinScore: 5 })).toBeNull();
  });

  it('accepts only release types that exist in the policy ecosystem', () => {
    expect(policyConditionsError({ releaseTypes: ['stable'] })).toMatch(/allowed values are prerelease, dev, snapshot, pseudo/);
    expect(policyConditionsError({ ecosystem: ['npm'], releaseTypes: ['snapshot'] })).toBe('snapshot applies only to Maven');
    expect(policyConditionsError({ ecosystem: ['npm'], releaseTypes: ['dev'] })).toBe('dev applies only to PyPI and Composer');
    expect(policyConditionsError({ ecosystem: ['go'], releaseTypes: ['pseudo', 'prerelease'] })).toBeNull();
  });
});

describe('ruleDecisionError', () => {
  it('allows Allow only on the Packages rule', () => {
    expect(ruleDecisionError('ALLOW', { packageBlockList: ['@acme/*'] })).toBeNull();
    expect(ruleDecisionError('BLOCK', { packageBlockList: ['lodash'] })).toBeNull();
    expect(ruleDecisionError('ALLOW', { releaseTypes: ['prerelease'] })).toBe(
      'Release type policies can block, not allow. Use an exception or a waiver to let specific packages through'
    );
    expect(ruleDecisionError('ALLOW', { cvssMin: 7 })).toMatch(/^Vulnerability policies/);
    expect(ruleDecisionError('ALLOW', { releaseAgeMaxHours: 24 })).toMatch(/^Release age policies/);
    expect(ruleDecisionError('ALLOW', { licenseDenyList: ['GPL-3.0'] })).toMatch(/^License policies/);
  });

  it('accepts Block on every rule', () => {
    for (const conditions of [
      { releaseTypes: ['prerelease'] },
      { releaseAgeMinDays: 365 },
      { cvssMin: 7 },
      { licenseDenyList: ['GPL-3.0'] },
    ]) {
      expect(ruleDecisionError('BLOCK', conditions)).toBeNull();
    }
  });

  it('treats an approved list as the license rule, and refuses both lists in one policy', () => {
    expect(policyRules({ licenseAllowList: ['MIT'] })).toEqual(['license']);
    expect(policyConditionsError({ licenseAllowList: ['MIT'] })).toBeNull();
    expect(policyConditionsError({ licenseAllowList: ['MIT'], allowUnknownLicense: true })).toBeNull();
    expect(policyConditionsError({ licenseAllowList: ['MIT'], licenseDenyList: ['GPL-3.0'] })).toMatch(/not both/);
    expect(ruleDecisionError('ALLOW', { licenseAllowList: ['MIT'] })).toMatch(/^License policies/);
  });
});

describe('internal namespace rule', () => {
  const npm = { ecosystem: ['npm'], reservedNamespaces: ['@acme', 'acme-*'] };

  it('is its own rule, Block only', () => {
    expect(policyRules(npm)).toEqual(['namespace']);
    expect(policyConditionsError(npm)).toBeNull();
    expect(ruleDecisionError('BLOCK', npm)).toBeNull();
    expect(ruleDecisionError('ALLOW', npm)).toMatch(/^Internal namespace policies can block, not allow/);
  });

  it('needs exactly one ecosystem', () => {
    expect(policyConditionsError({ reservedNamespaces: ['@acme'] })).toMatch(/exactly one ecosystem/);
    expect(policyConditionsError({ ecosystem: ['npm', 'pypi'], reservedNamespaces: ['acme-*'] })).toMatch(/exactly one ecosystem/);
  });

  it('validates each pattern for the ecosystem', () => {
    expect(policyConditionsError({ ecosystem: ['go'], reservedNamespaces: ['github.com'] })).toMatch(/every module on github\.com/);
    expect(policyConditionsError({ ecosystem: ['maven'], reservedNamespaces: ['com'] })).toMatch(/top-level group/);
    expect(policyConditionsError({ ecosystem: ['npm'], reservedNamespaces: ['@acme-*'] })).toMatch(/scope is reserved whole/);
    expect(policyConditionsError({ ecosystem: ['npm'], reservedNamespaces: ['*'] })).toMatch(/every package/);
  });

  it('checks publicPackages against the reserved namespaces', () => {
    expect(policyConditionsError({ ...npm, publicPackages: ['@acme/eslint-config'] })).toBeNull();
    expect(policyConditionsError({ ...npm, publicPackages: ['lodash'] })).toMatch(/not in any reserved namespace/);
    expect(policyConditionsError({ ecosystem: ['npm'], publicPackages: ['@acme/x'] })).toMatch(/add reserved namespaces/);
  });

  it('cannot be combined with another rule', () => {
    expect(policyConditionsError({ ...npm, packageBlockList: ['lodash'] })).toMatch(/packages and internal namespace/);
  });
});
