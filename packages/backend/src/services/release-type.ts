import { parsePep440 } from './version-range.js';

/**
 * Release stage of a version, by its ecosystem's own rules. Every version gets exactly one
 * type; when several markers are present the first of snapshot, pseudo, dev, prerelease wins.
 * Build and local metadata (`+...`) never change the type.
 */
export type ReleaseType = 'stable' | 'prerelease' | 'dev' | 'snapshot' | 'pseudo' | 'unknown';

/** The types a policy can select. Stable is what remains, and unknown never matches. */
export const SELECTABLE_RELEASE_TYPES = ['prerelease', 'dev', 'snapshot', 'pseudo'] as const;
export type SelectableReleaseType = (typeof SELECTABLE_RELEASE_TYPES)[number];

/** Ecosystems where each type can occur. A null list means every ecosystem. */
export const RELEASE_TYPE_ECOSYSTEMS: Record<SelectableReleaseType, readonly string[] | null> = {
  prerelease: null,
  dev: ['pypi', 'composer'],
  snapshot: ['maven'],
  pseudo: ['go'],
};

export type ReleaseClass = {
  type: ReleaseType;
  /** The part of the version that decided the type, e.g. `rc`, `SNAPSHOT`, a Go commit id. */
  marker?: string;
  /** How the ecosystem's rules are named in reasons, e.g. `PEP 440`. */
  scheme: string;
};

export function releaseTypeApplies(type: SelectableReleaseType, ecosystem: string): boolean {
  const list = RELEASE_TYPE_ECOSYSTEMS[type];
  return list == null || list.includes(ecosystem);
}

export function classifyRelease(ecosystem: string | undefined, version: string): ReleaseClass {
  const value = version.trim();
  switch ((ecosystem ?? '').toLowerCase()) {
    case 'pypi':
      return classifyPep440(value);
    case 'maven':
      return classifyMaven(value);
    case 'rubygems':
      return classifyRuby(value);
    case 'composer':
      return classifyComposer(value);
    case 'go':
      return classifyGo(value);
    case 'nuget':
      return classifySemver(value, 'NuGet');
    default:
      return classifySemver(value, 'SemVer');
  }
}

/** The ledger sentence for a classified version, e.g. `Version 2.0.0rc1 is a pre-release (PEP 440 "rc")`. */
export function releaseTypeReason(version: string, release: ReleaseClass): string {
  const marker = release.marker ?? '';
  switch (release.type) {
    case 'prerelease':
      return `Version ${version} is a pre-release (${release.scheme} "${marker}")`;
    case 'dev':
      return release.scheme === 'Composer'
        ? `Version ${version} is a dev branch (Composer "${marker}")`
        : `Version ${version} is a dev release (${release.scheme} "${marker}")`;
    case 'snapshot':
      return `Version ${version} is a snapshot (Maven "${marker}")`;
    case 'pseudo':
      return `Version ${version} is a pseudo-version (untagged Go commit ${marker})`;
    default:
      return `Version ${version} is ${release.type}`;
  }
}

// --- npm, Cargo, NuGet: anything after `-` and before `+` is a pre-release ---

const SEMVER_LIKE = /^v?\d+(?:\.\d+)*(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function classifySemver(version: string, scheme: string): ReleaseClass {
  const match = SEMVER_LIKE.exec(version);
  if (!match) return { type: 'unknown', scheme };
  if (!match[1]) return { type: 'stable', scheme };
  return { type: 'prerelease', marker: labelOf(match[1].split('.')[0]), scheme };
}

/** `beta1` reads as `beta` and `canary-5d29478` as `canary`; a numeric label stays as it is. */
function labelOf(identifier: string): string {
  return /^[A-Za-z]+/.exec(identifier)?.[0] ?? identifier;
}

// --- Go: pseudo-versions are untagged commits; the pattern is golang.org/x/mod/module's ---

const GO_PSEUDO =
  /^v[0-9]+\.(0\.0-|\d+\.\d+-([^+]*\.)?0\.)\d{14}-([A-Za-z0-9]+)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function classifyGo(version: string): ReleaseClass {
  const pseudo = GO_PSEUDO.exec(version);
  if (pseudo) return { type: 'pseudo', marker: pseudo[3], scheme: 'Go' };
  return classifySemver(version, 'SemVer');
}

// --- PyPI: PEP 440 ---

function classifyPep440(version: string): ReleaseClass {
  const parsed = parsePep440(version);
  if (!parsed) return { type: 'unknown', scheme: 'PEP 440' };
  if (parsed.dev != null) return { type: 'dev', marker: '.dev', scheme: 'PEP 440' };
  if (Array.isArray(parsed.pre)) return { type: 'prerelease', marker: parsed.pre[0], scheme: 'PEP 440' };
  return { type: 'stable', scheme: 'PEP 440' };
}

// --- Maven: SNAPSHOT, then pre-release qualifiers as whole tokens ---

const MAVEN_TIMESTAMPED_SNAPSHOT = /^.*-(\d{8}\.\d{6}-\d+)$/;
const MAVEN_PRERELEASE_WORDS = new Set(['alpha', 'beta', 'milestone', 'rc', 'cr', 'pre', 'preview', 'ea']);
/** Maven reads these single letters as alpha, beta, and milestone only when a digit follows. */
const MAVEN_PRERELEASE_LETTERS = new Set(['a', 'b', 'm']);

function classifyMaven(version: string): ReleaseClass {
  if (/snapshot$/i.test(version)) return { type: 'snapshot', marker: 'SNAPSHOT', scheme: 'Maven' };
  const timestamped = MAVEN_TIMESTAMPED_SNAPSHOT.exec(version);
  if (timestamped) return { type: 'snapshot', marker: timestamped[1], scheme: 'Maven' };
  const lower = version.toLowerCase();
  for (const token of lower.matchAll(/[a-z]+/g)) {
    const word = token[0];
    if (MAVEN_PRERELEASE_WORDS.has(word)) return { type: 'prerelease', marker: word, scheme: 'Maven' };
    const next = lower[token.index + word.length];
    if (MAVEN_PRERELEASE_LETTERS.has(word) && next != null && next >= '0' && next <= '9') {
      return { type: 'prerelease', marker: word, scheme: 'Maven' };
    }
  }
  return { type: 'stable', scheme: 'Maven' };
}

// --- RubyGems: any letter makes a pre-release, as Gem::Version#prerelease? does ---

function classifyRuby(version: string): ReleaseClass {
  const letters = /[A-Za-z]+/.exec(version);
  if (!letters) return { type: 'stable', scheme: 'RubyGems' };
  return { type: 'prerelease', marker: letters[0], scheme: 'RubyGems' };
}

// --- Composer: stability flags, as VersionParser::parseStability reads them ---

const COMPOSER_VERSION =
  /^v?\d+(?:\.\d+){0,3}[._-]?(?:(stable|beta|b|rc|alpha|a|patch|pl|p)(\d*(?:[.-]\d+)*))?$/i;

function classifyComposer(version: string): ReleaseClass {
  if (/^dev-/i.test(version)) return { type: 'dev', marker: 'dev-', scheme: 'Composer' };
  if (/[.-]dev$/i.test(version)) return { type: 'dev', marker: '-dev', scheme: 'Composer' };
  const match = COMPOSER_VERSION.exec(version);
  if (!match) return { type: 'unknown', scheme: 'Composer' };
  const flag = (match[1] ?? '').toLowerCase();
  if (flag === 'alpha' || flag === 'a') return { type: 'prerelease', marker: 'alpha', scheme: 'Composer' };
  if (flag === 'beta' || flag === 'b') return { type: 'prerelease', marker: 'beta', scheme: 'Composer' };
  if (flag === 'rc') return { type: 'prerelease', marker: 'RC', scheme: 'Composer' };
  return { type: 'stable', scheme: 'Composer' };
}
