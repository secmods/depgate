/** Fills a waiver or exception dialog from another page, e.g. a Package check row. */
export interface PackagePrefill {
  ecosystem: string;
  packageName: string;
  version?: string;
  /** Repository key the package was checked or blocked on; preselected as the scope. */
  repository?: string;
}

export interface WaiverVersionConstraint {
  kind: 'exact' | 'range';
  version: string;
  from: string;
  to: string;
}

function blank(): Pick<WaiverVersionConstraint, 'version' | 'from' | 'to'> {
  return { version: '', from: '', to: '' };
}

export function parseVersion(version: string | undefined): WaiverVersionConstraint[] {
  const trimmed = version?.trim() ?? '';
  if (!trimmed || trimmed === '*') return [];
  return trimmed
    .split(/\s*\|\|\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseVersionPart);
}

function parseVersionPart(part: string): WaiverVersionConstraint {
  const empty = blank();
  const both = /^>=\s*([^\s]+)\s+<=\s*([^\s]+)$/.exec(part);
  if (both) return { kind: 'range', ...empty, from: both[1], to: both[2] };
  const spaced = /^(.+?)\s+-\s+(.+)$/.exec(part);
  if (spaced) return { kind: 'range', ...empty, from: spaced[1].trim(), to: spaced[2].trim() };
  const gte = /^>=\s*([^\s]+)$/.exec(part);
  if (gte) return { kind: 'range', ...empty, from: gte[1], to: '' };
  const lte = /^<=\s*([^\s]+)$/.exec(part);
  if (lte) return { kind: 'range', ...empty, from: '', to: lte[1] };
  const exact = /^=\s*(.+)$/.exec(part);
  if (exact) return { kind: 'exact', ...empty, version: exact[1].trim() };
  return { kind: 'exact', ...empty, version: part };
}

export function buildVersion(constraints: WaiverVersionConstraint[]): string {
  const parts: string[] = [];
  for (const item of constraints) {
    if (item.kind === 'exact') {
      const version = item.version.trim();
      if (version) parts.push(version.replace(/^=\s*/, ''));
      continue;
    }
    const from = item.from.trim();
    const to = item.to.trim();
    if (from && to) parts.push(`${from} - ${to}`);
    else if (from) parts.push(`>=${from}`);
    else if (to) parts.push(`<=${to}`);
  }
  return parts.join(' || ') || '*';
}

/**
 * One version as a person types it, named versions included: 1.2.3-rc.1, 2.0.0rc1, 1.0.post1,
 * 1.0.dev1, 1.0-SNAPSHOT, 1.2.3.Final, 31.1-jre, 1.0.0.pre, v1.2.3. The backend applies the same rule.
 */
// A lone x segment (1.x, 1.2.x) is a wildcard, not a version.
const VERSION_INPUT = /^(?!(?:.*[.-])?x(?:[.-]|$))(?:\d+!)?v?\d(?:[0-9a-z._+-]*[0-9a-z])?$/i;
/** Composer branch versions such as dev-main. */
const COMPOSER_BRANCH = /^dev-[0-9a-z][0-9a-z._/-]*$/i;

/** Why a typed version is not accepted, or null. An empty box is left to each dialog. */
export function versionInputError(value: string, ecosystem?: string): string | null {
  const version = value.trim();
  if (!version || VERSION_INPUT.test(version)) return null;
  if (ecosystem === 'composer' && COMPOSER_BRANCH.test(version)) return null;
  return 'Enter a single version, e.g. 1.2.3, 2.0.0-rc.1, or 1.0-SNAPSHOT';
}

export function constraintError(item: WaiverVersionConstraint, ecosystem?: string): string | null {
  if (item.kind === 'exact') return versionInputError(item.version, ecosystem);
  return versionInputError(item.from, ecosystem) ?? versionInputError(item.to, ecosystem);
}

export function hasInvalidVersion(constraints: WaiverVersionConstraint[], ecosystem?: string): boolean {
  return constraints.some((item) => constraintError(item, ecosystem) != null);
}
