/**
 * Reserved namespaces of the Internal namespace rule (dependency confusion). Patterns and names
 * are canonicalised the same way per ecosystem, and matching is on segment boundaries, so
 * `com.acme` never matches `com.acmecorp`.
 */

export type NamespacePatternKind =
  /** One package name. */
  | 'exact'
  /** Names that start with a prefix ending in a separator: `acme-*`, `Acme.*`, `acme/*`. */
  | 'prefix'
  /** A path or group and everything below it: npm `@acme`, Go `github.com/acme`, Maven `com.acme`. */
  | 'tree';

export type CompiledNamespacePattern = {
  /** As the admin typed it. Shown in reasons and reports. */
  raw: string;
  kind: NamespacePatternKind;
  /** Canonical value: the name, the prefix (with its separator) or the tree root. */
  value: string;
  /** Tree only: the characters that may follow the root (`/` for a Go path, `.` or `:` for a Maven group). */
  boundary?: string;
};

/** Separators a prefix pattern must end with before `*`, so `acme*` cannot reserve `acmecorp`. */
const PREFIX_SEPARATORS: Record<string, string> = {
  npm: '-_.',
  pypi: '-',
  nuget: '.-_',
  cargo: '-',
  composer: '/-_.',
  rubygems: '-',
  maven: '-_.',
};

/** Hosts shared by many owners. One of them alone would reserve every module hosted there. */
const SHARED_GO_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'golang.org',
  'golang.org/x',
  'google.golang.org',
  'gopkg.in',
  'go.googlesource.com',
  'cloud.google.com',
  'k8s.io',
  'sigs.k8s.io',
  'go.uber.org',
  'go.opentelemetry.io',
  'codeberg.org',
  'sr.ht',
  'git.sr.ht',
]);

/** Go module proxy `!x` case-encoding back to plain text. */
function decodeGoPath(path: string): string {
  return path.replace(/!([a-z])/g, (_m, letter: string) => letter.toUpperCase());
}

/** The name as the rule compares it. */
export function canonicalName(ecosystem: string, name: string): string {
  const trimmed = (name ?? '').trim();
  switch (ecosystem) {
    case 'pypi':
      return trimmed.toLowerCase().replace(/[-_.]+/g, '-');
    case 'cargo':
    case 'rubygems':
      return trimmed.toLowerCase().replace(/_/g, '-');
    case 'go':
      return decodeGoPath(trimmed).toLowerCase().replace(/\/+$/, '');
    default:
      return trimmed.toLowerCase();
  }
}

type Parsed = { pattern: CompiledNamespacePattern } | { error: string };

function prefixPattern(ecosystem: string, raw: string, body: string, example: string): Parsed {
  const value = canonicalName(ecosystem, body);
  const separators = PREFIX_SEPARATORS[ecosystem] ?? '-';
  const last = value.slice(-1);
  if (!last || !separators.includes(last)) {
    return { error: `"${raw}": end the prefix with a separator before *, e.g. "${example}", so it cannot match longer names` };
  }
  if (value.length < 3) return { error: `"${raw}" is too short to reserve; use a distinctive prefix such as "${example}"` };
  return { pattern: { raw, kind: 'prefix', value } };
}

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const NPM_SCOPE = /^@[a-z0-9~][a-z0-9._~-]*$/;
const SIMPLE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const GO_PATH = /^[a-z0-9.!_~+-]+(?:\/[a-z0-9.!_~+-]+)*$/;
const MAVEN_GROUP = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
const MAVEN_ARTIFACT = /^[a-z0-9_.-]+$/;
const COMPOSER_PART = /^[a-z0-9][a-z0-9_.-]*$/;

function parseNpm(raw: string, value: string): Parsed {
  if (value.startsWith('@')) {
    if (value.includes('*')) {
      if (/^@[^/]+\/\*$/.test(value)) return parseNpm(raw, value.slice(0, -2));
      return { error: `"${raw}": a scope is reserved whole (e.g. "@acme"); a prefix such as "acme-*" is for unscoped names` };
    }
    if (NPM_SCOPE.test(value)) return { pattern: { raw, kind: 'tree', value, boundary: '/' } };
    if (NPM_NAME.test(value)) return { pattern: { raw, kind: 'exact', value } };
    return { error: `"${raw}" is not an npm scope or package name` };
  }
  if (value.endsWith('*')) {
    const body = value.slice(0, -1);
    if (!SIMPLE_NAME.test(body.replace(/[-_.]$/, '') || '-')) return { error: `"${raw}" is not a valid npm name prefix` };
    return prefixPattern('npm', raw, body, 'acme-*');
  }
  return NPM_NAME.test(value) ? { pattern: { raw, kind: 'exact', value } } : { error: `"${raw}" is not a valid npm package name` };
}

function parseSimple(ecosystem: string, raw: string, value: string, example: string): Parsed {
  if (value.endsWith('*')) {
    const body = value.slice(0, -1);
    if (!SIMPLE_NAME.test(body.replace(/[-_.]$/, '') || '-')) return { error: `"${raw}" is not a valid ${ecosystem} name prefix` };
    return prefixPattern(ecosystem, raw, body, example);
  }
  if (!SIMPLE_NAME.test(value)) return { error: `"${raw}" is not a valid ${ecosystem} package name` };
  return { pattern: { raw, kind: 'exact', value: canonicalName(ecosystem, value) } };
}

function parseGo(raw: string, value: string): Parsed {
  let path = value.replace(/\/(?:\*|\.\.\.)$/, '');
  if (path.includes('*')) return { error: `"${raw}": a Go pattern is a module path prefix such as "github.com/acme"` };
  path = canonicalName('go', path);
  if (!GO_PATH.test(path)) return { error: `"${raw}" is not a Go module path` };
  const [host] = path.split('/');
  if (!host.includes('.')) return { error: `"${raw}": a Go module path starts with a domain name, e.g. "go.acme.com"` };
  if (SHARED_GO_HOSTS.has(path)) {
    return { error: `"${raw}" would reserve every module on ${path}; add the owner, e.g. "${path}/acme"` };
  }
  return { pattern: { raw, kind: 'tree', value: path, boundary: '/' } };
}

function parseMaven(raw: string, value: string): Parsed {
  const [group, artifact, extra] = value.split(':');
  if (extra !== undefined) return { error: `"${raw}": use groupId or groupId:artifactId` };
  const cleanGroup = group.replace(/\.\*$/, '');
  if (cleanGroup.includes('*')) return { error: `"${raw}": the groupId cannot contain *; "com.acme" covers its sub-groups` };
  if (!MAVEN_GROUP.test(cleanGroup)) {
    return {
      error: /^[a-z0-9_-]+$/.test(cleanGroup)
        ? `"${raw}" would reserve a whole top-level group; use at least two parts, e.g. "com.acme"`
        : `"${raw}" is not a valid Maven groupId`,
    };
  }
  // A group covers its sub-groups (`com.acme.billing`) and its own artifacts (`com.acme:core`).
  if (artifact === undefined) return { pattern: { raw, kind: 'tree', value: cleanGroup, boundary: '.:' } };
  if (cleanGroup !== group) return { error: `"${raw}": use "com.acme" for sub-groups or "com.acme:artifact" for one artifact` };
  if (artifact.endsWith('*')) {
    const body = artifact.slice(0, -1);
    if (!body || !MAVEN_ARTIFACT.test(body)) return { error: `"${raw}" is not a valid artifactId prefix` };
    const last = body.slice(-1);
    if (!PREFIX_SEPARATORS.maven.includes(last)) {
      return { error: `"${raw}": end the prefix with a separator before *, e.g. "com.acme:core-*"` };
    }
    return { pattern: { raw, kind: 'prefix', value: `${group}:${body}` } };
  }
  if (!MAVEN_ARTIFACT.test(artifact)) return { error: `"${raw}" is not a valid artifactId` };
  return { pattern: { raw, kind: 'exact', value: `${group}:${artifact}` } };
}

function parseComposer(raw: string, value: string): Parsed {
  const slash = value.indexOf('/');
  if (slash <= 0) return { error: `"${raw}": a Composer pattern is vendor/*, vendor/prefix-* or vendor/package` };
  const vendor = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (vendor.includes('*') || !COMPOSER_PART.test(vendor)) return { error: `"${raw}": the vendor must be a name, not a wildcard` };
  if (rest === '*') return { pattern: { raw, kind: 'prefix', value: `${vendor}/` } };
  if (rest.endsWith('*')) {
    const body = rest.slice(0, -1);
    if (!body || !COMPOSER_PART.test(body.replace(/[-_.]$/, '') || '-')) return { error: `"${raw}" is not a valid package prefix` };
    return prefixPattern('composer', raw, `${vendor}/${body}`, `${vendor}/pkg-*`);
  }
  if (!COMPOSER_PART.test(rest)) return { error: `"${raw}" is not a valid Composer package name` };
  return { pattern: { raw, kind: 'exact', value } };
}

function parseNuget(raw: string, value: string): Parsed {
  if (value.endsWith('*')) {
    const body = value.slice(0, -1);
    if (!SIMPLE_NAME.test(body.replace(/[-_.]$/, '') || '-')) return { error: `"${raw}" is not a valid NuGet ID prefix` };
    return prefixPattern('nuget', raw, body, 'Acme.*');
  }
  return SIMPLE_NAME.test(value) ? { pattern: { raw, kind: 'exact', value } } : { error: `"${raw}" is not a valid NuGet package ID` };
}

/** One pattern for one ecosystem, compiled, or why it cannot be used. */
export function parseNamespacePattern(ecosystem: string, pattern: unknown): Parsed {
  const raw = typeof pattern === 'string' ? pattern.trim() : '';
  if (!raw) return { error: 'A reserved namespace cannot be empty' };
  if (raw.length > 214) return { error: `"${raw.slice(0, 40)}…" is too long` };
  if (/\s/.test(raw)) return { error: `"${raw}" cannot contain spaces` };
  if (raw === '*' || raw === '@' || raw === '**' || raw === '@*' || raw === '*/*') {
    return { error: `"${raw}" would reserve every package; name your own namespace` };
  }
  if (raw.indexOf('*') !== -1 && raw.indexOf('*') !== raw.length - 1) {
    return { error: `"${raw}": * is only allowed once, at the end` };
  }
  const value = raw.toLowerCase();
  switch (ecosystem) {
    case 'npm':
      return parseNpm(raw, value);
    case 'pypi':
      return parseSimple('pypi', raw, value, 'acme-*');
    case 'cargo':
      return parseSimple('cargo', raw, value, 'acme-*');
    case 'rubygems':
      return parseSimple('rubygems', raw, value, 'acme-*');
    case 'nuget':
      return parseNuget(raw, value);
    case 'go':
      return parseGo(raw, value);
    case 'maven':
      return parseMaven(raw, value);
    case 'composer':
      return parseComposer(raw, value);
    default:
      return { error: `Reserved namespaces are not supported for ecosystem "${ecosystem}"` };
  }
}

export function namespacePatternError(ecosystem: string, pattern: unknown): string | null {
  const parsed = parseNamespacePattern(ecosystem, pattern);
  return 'error' in parsed ? parsed.error : null;
}

export function compileNamespacePatterns(ecosystem: string, patterns: readonly unknown[] | undefined): CompiledNamespacePattern[] {
  const out: CompiledNamespacePattern[] = [];
  for (const pattern of patterns ?? []) {
    const parsed = parseNamespacePattern(ecosystem, pattern);
    if ('pattern' in parsed) out.push(parsed.pattern);
  }
  return out;
}

/** Whether a canonical name falls in the pattern. */
export function namespaceMatches(pattern: CompiledNamespacePattern, canonical: string): boolean {
  switch (pattern.kind) {
    case 'exact':
      return canonical === pattern.value;
    case 'prefix':
      return canonical.length > pattern.value.length && canonical.startsWith(pattern.value);
    case 'tree': {
      if (!canonical.startsWith(pattern.value)) return false;
      if (canonical.length === pattern.value.length) return true;
      return (pattern.boundary ?? '/').includes(canonical.charAt(pattern.value.length));
    }
  }
}

/** The first pattern the name falls in, or null. */
export function firstMatchingPattern(
  ecosystem: string,
  patterns: readonly CompiledNamespacePattern[],
  name: string
): CompiledNamespacePattern | null {
  if (patterns.length === 0) return null;
  const canonical = canonicalName(ecosystem, name);
  return patterns.find((pattern) => namespaceMatches(pattern, canonical)) ?? null;
}

/** Glob in `publicPackages`: `*` matches any run of characters. Compared on canonical names. */
export type PublicPackageMatcher = (canonical: string) => boolean;

export function compilePublicPackages(ecosystem: string, list: readonly unknown[] | undefined): PublicPackageMatcher[] {
  return (list ?? [])
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .map((item) => {
      const parts = item.split('*').map((part) => canonicalName(ecosystem, part));
      if (parts.length === 1) return (canonical: string) => canonical === parts[0];
      const regex = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      return (canonical: string) => regex.test(canonical);
    });
}

/** Why a `publicPackages` entry cannot be saved, or null. An exact name must lie in a reserved namespace. */
export function publicPackageError(
  ecosystem: string,
  entry: unknown,
  patterns: readonly CompiledNamespacePattern[]
): string | null {
  const text = typeof entry === 'string' ? entry.trim() : '';
  if (!text) return 'A public package name cannot be empty';
  if (/\s/.test(text)) return `"${text}" cannot contain spaces`;
  if (text === '*') return '"*" would let every reserved name come from public registries; remove the rule instead';
  if (text.includes('*')) return null;
  return firstMatchingPattern(ecosystem, patterns, text)
    ? null
    : `"${text}" is not in any reserved namespace of this policy, so it needs no exemption`;
}

/**
 * The `GONOSUMDB` value for Go patterns: the module paths the go command must not look up on
 * sum.golang.org. Not GOPRIVATE: it also sets GONOPROXY, which would make go skip DepGate.
 */
export function goNoSumDb(patterns: readonly unknown[] | undefined): string {
  return compileNamespacePatterns('go', patterns)
    .map((pattern) => pattern.value)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(',');
}
