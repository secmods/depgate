/**
 * OpenSSF Scorecard checks a policy may set a minimum for. `Webhooks` needs admin access to the
 * repository and is never in public results, so it is not offered. The UI keeps the same list.
 */
export const SCORECARD_CHECKS = [
  { name: 'Binary-Artifacts', description: 'The repository has no checked-in binaries' },
  { name: 'Branch-Protection', description: 'The default branch is protected against force pushes and unreviewed changes' },
  { name: 'CI-Tests', description: 'Tests run in CI before pull requests are merged' },
  { name: 'CII-Best-Practices', description: 'The project has an OpenSSF Best Practices badge' },
  { name: 'Code-Review', description: 'Changes are reviewed before they are merged' },
  { name: 'Contributors', description: 'Contributors come from several organizations' },
  { name: 'Dangerous-Workflow', description: 'CI workflows have no dangerous patterns such as untrusted code checkout' },
  { name: 'Dependency-Update-Tool', description: 'A tool such as Dependabot or Renovate keeps dependencies up to date' },
  { name: 'Fuzzing', description: 'The project is fuzzed, for example by OSS-Fuzz' },
  { name: 'License', description: 'The repository declares a license' },
  { name: 'Maintained', description: 'The project had commits or issue activity in the last 90 days' },
  { name: 'Packaging', description: 'Releases are published by a CI packaging workflow' },
  { name: 'Pinned-Dependencies', description: 'Build and CI dependencies are pinned by hash' },
  { name: 'SAST', description: 'Static analysis runs on changes' },
  { name: 'Security-Policy', description: 'The project has a security policy (SECURITY.md)' },
  { name: 'Signed-Releases', description: 'Releases are cryptographically signed' },
  { name: 'Token-Permissions', description: 'CI workflow tokens have least-privilege permissions' },
  { name: 'Vulnerabilities', description: 'The project has no open, unfixed vulnerabilities' },
] as const;

export type ScorecardCheckName = (typeof SCORECARD_CHECKS)[number]['name'];

const BY_LOWER = new Map<string, ScorecardCheckName>(SCORECARD_CHECKS.map((check) => [check.name.toLowerCase(), check.name]));

/** The canonical spelling of a check name typed in any case, or null when it is not a selectable check. */
export function canonicalCheckName(name: unknown): ScorecardCheckName | null {
  if (typeof name !== 'string') return null;
  return BY_LOWER.get(name.trim().toLowerCase()) ?? null;
}
