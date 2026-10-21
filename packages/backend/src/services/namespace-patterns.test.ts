import { describe, expect, it } from 'vitest';
import {
  canonicalName,
  compileNamespacePatterns,
  compilePublicPackages,
  firstMatchingPattern,
  goNoSumDb,
  namespacePatternError,
  publicPackageError,
} from './namespace-patterns.js';

function reserves(ecosystem: string, pattern: string, name: string): boolean {
  const compiled = compileNamespacePatterns(ecosystem, [pattern]);
  expect(compiled, `${ecosystem} pattern "${pattern}" compiles`).toHaveLength(1);
  return firstMatchingPattern(ecosystem, compiled, name) !== null;
}

/** The matching table of requirements §7, with the boundary cases of §11. */
const TABLE: Array<{ ecosystem: string; pattern: string; matches: string[]; misses: string[] }> = [
  { ecosystem: 'npm', pattern: '@acme', matches: ['@acme/billing', '@ACME/Billing', '@acme/a.b-c'], misses: ['@acmecorp/x', 'acme', '@acme-x/y', 'acme-auth'] },
  { ecosystem: 'npm', pattern: '@acme/*', matches: ['@acme/billing'], misses: ['@acmecorp/billing'] },
  { ecosystem: 'npm', pattern: 'acme-*', matches: ['acme-auth', 'ACME-auth'], misses: ['acme', 'acme-', 'acmeauth', '@acme/auth', 'notacme-auth'] },
  { ecosystem: 'npm', pattern: '@acme/billing', matches: ['@acme/billing'], misses: ['@acme/billing-ui', '@acme/bill'] },
  { ecosystem: 'pypi', pattern: 'acme-*', matches: ['acme_auth', 'Acme.Auth', 'acme-auth', 'ACME__auth'], misses: ['acmeauth', 'acme', 'xacme-auth'] },
  { ecosystem: 'pypi', pattern: 'acme_*', matches: ['acme-auth', 'acme.auth'], misses: ['acmecorp'] },
  { ecosystem: 'pypi', pattern: 'Acme.Auth', matches: ['acme-auth', 'acme_auth', 'ACME.AUTH'], misses: ['acme-auth2'] },
  {
    ecosystem: 'go',
    pattern: 'github.com/acme',
    matches: ['github.com/acme/svc', 'github.com/acme/svc/v2', 'github.com/!acme/svc', 'github.com/acme'],
    misses: ['github.com/acmecorp/x', 'github.com/acme-x/y', 'gitlab.com/acme/svc'],
  },
  { ecosystem: 'go', pattern: 'go.acme.com', matches: ['go.acme.com/svc', 'go.acme.com'], misses: ['go.acme.com.evil.io/x', 'go.acme.company/x'] },
  { ecosystem: 'go', pattern: 'github.com/acme/*', matches: ['github.com/acme/svc'], misses: ['github.com/acmecorp/svc'] },
  {
    ecosystem: 'maven',
    pattern: 'com.acme',
    matches: ['com.acme:core', 'com.acme.billing:api', 'COM.ACME:Core'],
    misses: ['com.acmecorp:core', 'com.acme-x:core', 'org.acme:core'],
  },
  { ecosystem: 'maven', pattern: 'com.acme:core', matches: ['com.acme:core'], misses: ['com.acme:core-api', 'com.acme.x:core'] },
  { ecosystem: 'maven', pattern: 'com.acme:core-*', matches: ['com.acme:core-api'], misses: ['com.acme:core', 'com.acme:coreapi', 'com.acme.sub:core-api'] },
  { ecosystem: 'nuget', pattern: 'Acme.*', matches: ['Acme.Billing', 'acme.billing', 'ACME.Billing.Api'], misses: ['Acme', 'AcmeCorp.Billing', 'Acmes.Billing'] },
  { ecosystem: 'nuget', pattern: 'Acme.Billing', matches: ['acme.billing'], misses: ['acme.billing.api'] },
  { ecosystem: 'cargo', pattern: 'acme-*', matches: ['acme_core', 'acme-core', 'ACME-core'], misses: ['acmecore', 'acme'] },
  { ecosystem: 'cargo', pattern: 'acme_*', matches: ['acme-core'], misses: ['acmecore'] },
  { ecosystem: 'composer', pattern: 'acme/*', matches: ['acme/billing', 'ACME/Billing'], misses: ['acmecorp/billing', 'acme-x/billing', 'other/acme'] },
  { ecosystem: 'composer', pattern: 'acme/pkg-*', matches: ['acme/pkg-billing'], misses: ['acme/pkg', 'acme/billing', 'acme/pkgbilling'] },
  { ecosystem: 'composer', pattern: 'acme/billing', matches: ['acme/billing'], misses: ['acme/billing-ui'] },
  { ecosystem: 'rubygems', pattern: 'acme-*', matches: ['acme_billing', 'acme-billing'], misses: ['acmebilling', 'acme'] },
  { ecosystem: 'rubygems', pattern: 'acme_*', matches: ['acme-billing', 'acme_billing'], misses: ['acmebilling'] },
];

describe('namespace patterns: matching table (§7)', () => {
  for (const row of TABLE) {
    it(`${row.ecosystem} ${row.pattern}`, () => {
      for (const name of row.matches) expect(reserves(row.ecosystem, row.pattern, name), `${name} is reserved`).toBe(true);
      for (const name of row.misses) expect(reserves(row.ecosystem, row.pattern, name), `${name} is not reserved`).toBe(false);
    });
  }
});

describe('canonicalName', () => {
  it('canonicalises each ecosystem the way its registry compares names', () => {
    expect(canonicalName('npm', '@Acme/Billing')).toBe('@acme/billing');
    expect(canonicalName('pypi', 'Acme.Auth__Lib')).toBe('acme-auth-lib');
    expect(canonicalName('cargo', 'Acme_Core')).toBe('acme-core');
    expect(canonicalName('rubygems', 'acme_billing')).toBe('acme-billing');
    expect(canonicalName('go', 'github.com/!acme/!svc')).toBe('github.com/acme/svc');
    expect(canonicalName('maven', 'Com.Acme:Core')).toBe('com.acme:core');
    expect(canonicalName('nuget', 'Acme.Billing')).toBe('acme.billing');
    expect(canonicalName('composer', 'Acme/Billing')).toBe('acme/billing');
  });
});

describe('namespace patterns: validation', () => {
  const rejected: Array<[string, string, RegExp]> = [
    ['npm', '', /empty/],
    ['npm', '   ', /empty/],
    ['npm', '*', /every package/],
    ['npm', '@', /every package/],
    ['npm', '@acme-*', /scope is reserved whole/],
    ['npm', 'acme*', /separator/],
    ['npm', 'ac*me', /only allowed once, at the end/],
    ['npm', 'a-*', /too short/],
    ['npm', 'acme auth', /spaces/],
    ['pypi', 'acme*', /separator/],
    ['go', 'github.com', /every module on github\.com/],
    ['go', 'gitlab.com', /every module/],
    ['go', 'com', /domain name/],
    ['go', 'github.com/acme*', /module path prefix/],
    ['maven', 'com', /top-level group/],
    ['maven', 'com.*', /top-level group/],
    ['maven', 'com.acme:core*', /separator/],
    ['maven', 'com.acme:core:jar', /groupId or groupId:artifactId/],
    ['maven', 'com.ac*me', /only allowed once, at the end/],
    ['nuget', 'Acme*', /separator/],
    ['cargo', 'acme*', /separator/],
    ['composer', 'acme', /vendor\/\*/],
    ['composer', '*/billing', /only allowed once, at the end/],
    ['composer', '*/*', /every package/],
    ['rubygems', 'acme*', /separator/],
    ['unknown', 'acme', /not supported/],
  ];
  for (const [ecosystem, pattern, error] of rejected) {
    it(`${ecosystem}: rejects "${pattern}"`, () => {
      expect(namespacePatternError(ecosystem, pattern)).toMatch(error);
    });
  }

  it('accepts the documented forms', () => {
    const accepted: Array<[string, string]> = [
      ['npm', '@acme'],
      ['npm', 'acme-*'],
      ['npm', '@acme/billing'],
      ['pypi', 'acme-*'],
      ['go', 'github.com/acme'],
      ['go', 'go.acme.com'],
      ['maven', 'com.acme'],
      ['maven', 'com.acme:core'],
      ['maven', 'com.acme:core-*'],
      ['nuget', 'Acme.*'],
      ['cargo', 'acme-*'],
      ['composer', 'acme/*'],
      ['composer', 'acme/pkg-*'],
      ['rubygems', 'acme_*'],
    ];
    for (const [ecosystem, pattern] of accepted) expect(namespacePatternError(ecosystem, pattern), `${ecosystem} ${pattern}`).toBeNull();
  });
});

describe('publicPackages', () => {
  it('matches exact names and globs on canonical names', () => {
    const [exact, glob] = compilePublicPackages('pypi', ['Acme.Lint', 'acme-docs-*']);
    expect(exact('acme-lint')).toBe(true);
    expect(exact('acme-lint2')).toBe(false);
    expect(glob('acme-docs-theme')).toBe(true);
    expect(glob('acme-doc')).toBe(false);
  });

  it('rejects an exact name outside every reserved namespace, and "*"', () => {
    const patterns = compileNamespacePatterns('npm', ['@acme']);
    expect(publicPackageError('npm', '@acme/eslint-config', patterns)).toBeNull();
    expect(publicPackageError('npm', 'lodash', patterns)).toMatch(/not in any reserved namespace/);
    expect(publicPackageError('npm', '*', patterns)).toMatch(/every reserved name/);
    expect(publicPackageError('npm', '@acme/docs-*', patterns)).toBeNull();
  });
});

describe('goNoSumDb', () => {
  it('lists the module path prefixes the go command must not look up on sum.golang.org', () => {
    expect(goNoSumDb(['github.com/acme', 'go.acme.com', 'github.com/acme/*'])).toBe('github.com/acme,go.acme.com');
    expect(goNoSumDb(['github.com'])).toBe('');
  });
});
