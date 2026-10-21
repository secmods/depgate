import semver from 'semver';

/**
 * Version-range checks for every ecosystem the proxy serves.
 *
 * The stored range syntax is the one the policy UI writes: comparators
 * (`=`, `>=`, `<=`, `>`, `<`), inclusive hyphen ranges (`1.0.0 - 2.0.0`),
 * and `||`. npm, Go, and Cargo also accept the rest of the npm range
 * syntax. The version being tested is ordered by the ecosystem's own rules.
 */
export type RangeVerdict = 'match' | 'miss' | 'unknown';

type Scheme = 'semver' | 'pep440' | 'maven' | 'ruby' | 'dotted';

function schemeFor(ecosystem: string | undefined): Scheme {
  switch ((ecosystem ?? '').trim().toLowerCase()) {
    case 'pypi':
    case 'python':
      return 'pep440';
    case 'maven':
      return 'maven';
    case 'rubygems':
    case 'ruby':
    case 'gem':
      return 'ruby';
    case 'nuget':
    case 'composer':
    case 'packagist':
      return 'dotted';
    default:
      return 'semver';
  }
}

/**
 * One version as a person types it, named versions included: 1.2.3-rc.1, 2.0.0rc1,
 * 1.0.post1, 1.0.dev1, 1.0-SNAPSHOT, 1.2.3.Final, 31.1-jre, 1.0.0.pre, v1.2.3, 1!2.0.
 * Operators, wildcards, commas, brackets, and spaces are not part of a version.
 */
// A lone x segment (1.x, 1.2.x) is a wildcard, not a version.
const VERSION_INPUT = /^(?!(?:.*[.-])?x(?:[.-]|$))(?:\d+!)?v?\d(?:[0-9a-z._+-]*[0-9a-z])?$/i;
/** Composer branch versions such as dev-main or dev-feature/login. */
const COMPOSER_BRANCH = /^dev-[0-9a-z][0-9a-z._/-]*$/i;
/** Anything a stored range can compare. Operator text such as `~>` or `[1.0,2.0)` is not. */
const BOUND_TOKEN = /^[0-9a-z][0-9a-z._+!/-]*$/i;
const COMPARATOR = /^(>=|<=|>|<|=)?(.*)$/;
const COMPARATOR_PREFIX = /^(>=|<=|>|<|=)/;
const HYPHEN_RANGE = /^(\S+)\s+-\s+(\S+)$/;
const ALL_ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'];

/** Length of the version columns on waivers, exceptions, and malicious packages. */
export const STORED_VERSION_MAX_LENGTH = 128;

export function isVersionInput(value: string, ecosystems?: readonly string[]): boolean {
  if (VERSION_INPUT.test(value)) return true;
  return !!ecosystems?.length && ecosystems.every((eco) => eco === 'composer') && COMPOSER_BRANCH.test(value);
}

/**
 * Why a stored version spec cannot be saved, or null when it can. The spec is what the
 * dialogs write: versions, `>=`/`<=`/`=` comparators, and `start - end` ranges joined by `||`.
 * Policies scoped only to npm, Go, or Cargo also keep the npm range syntax for API clients.
 * An empty ecosystem list means every ecosystem.
 */
export function versionSpecError(
  spec: string | null | undefined,
  ecosystems?: readonly string[],
  maxLength?: number
): string | null {
  const trimmed = (spec ?? '').trim();
  if (!trimmed || trimmed === '*') return null;
  if (maxLength != null && trimmed.length > maxLength) {
    return `Versions must be ${maxLength} characters or fewer`;
  }
  const scope = ecosystems?.length ? ecosystems : ALL_ECOSYSTEMS;
  const semverOnly = scope.every((eco) => schemeFor(eco) === 'semver');
  for (const clause of trimmed.split('||').map((part) => part.trim())) {
    if (!clause) return 'Each "||" must have a version on both sides';
    const problem = clauseError(clause, scope);
    if (!problem) continue;
    // npm range syntax such as ^1.2 is not a version, but npm, Go, and Cargo understand it.
    if (problem.syntax && semverOnly && semver.validRange(clause) != null) continue;
    return problem.error;
  }
  return null;
}

function clauseError(
  clause: string,
  ecosystems: readonly string[]
): { error: string; syntax: boolean } | null {
  const hyphen = HYPHEN_RANGE.exec(clause);
  if (hyphen) {
    const [, from, to] = hyphen;
    for (const bound of [from, to]) {
      if (!isVersionInput(bound, ecosystems)) return { error: notAVersion(bound), syntax: true };
    }
    for (const eco of ecosystems) {
      const cmp = compareByScheme(schemeFor(eco), from, to);
      if (cmp != null && cmp > 0) return { error: `Range start ${from} is after its end ${to}`, syntax: false };
    }
    return null;
  }
  for (const token of clause.split(/\s+/)) {
    const value = COMPARATOR.exec(token)?.[2] ?? '';
    if (!isVersionInput(value, ecosystems)) return { error: notAVersion(token), syntax: true };
  }
  return null;
}

function notAVersion(value: string): string {
  return `"${value}" is not a version. Enter a single version such as 1.2.3, 2.0.0-rc.1, or 1.0-SNAPSHOT`;
}

export function versionInRange(
  ecosystem: string | undefined,
  version: string,
  range: string
): RangeVerdict {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return 'match';
  if (schemeFor(ecosystem) === 'semver') {
    const verdict = semverVerdict(version, trimmed);
    // Exact entries still decide by text, e.g. a waiver for a version semver cannot parse.
    if (verdict !== 'unknown') return verdict;
  }

  let sawUnknown = false;
  for (const clause of trimmed.split(/\s*\|\|\s*/)) {
    const part = clause.trim();
    if (!part) continue;
    const verdict = matchClause(ecosystem, version, part);
    if (verdict === 'match') return 'match';
    if (verdict === 'unknown') sawUnknown = true;
  }
  return sawUnknown ? 'unknown' : 'miss';
}

function semverVerdict(version: string, range: string): RangeVerdict {
  try {
    // Constructing the range is what throws. satisfies() turns a bad range into false.
    new semver.Range(range);
  } catch {
    return 'unknown';
  }
  if (semver.valid(version) == null) return 'unknown';
  return semver.satisfies(version, range, { includePrerelease: true }) ? 'match' : 'miss';
}

function matchClause(ecosystem: string | undefined, version: string, clause: string): RangeVerdict {
  if (clause === '*') return 'match';
  const hyphen = HYPHEN_RANGE.exec(clause);
  if (hyphen && !COMPARATOR_PREFIX.test(hyphen[1])) {
    if (!BOUND_TOKEN.test(hyphen[1]) || !BOUND_TOKEN.test(hyphen[2])) return 'unknown';
    return andVerdict(
      compareToBound(ecosystem, version, '>=', hyphen[1]),
      compareToBound(ecosystem, version, '<=', hyphen[2])
    );
  }
  const bounds: Array<[string, string]> = [];
  for (const token of clause.split(/\s+/)) {
    if (!token) continue;
    const op = COMPARATOR.exec(token);
    // Range syntax we do not support, such as `~> 1.2` or `[1.0,2.0)`, must not
    // turn into a definite miss through one of its parts.
    if (!op || !BOUND_TOKEN.test(op[2])) return 'unknown';
    bounds.push([op[1] ?? '=', op[2]]);
  }
  let acc: RangeVerdict = 'match';
  for (const [op, bound] of bounds) {
    acc = andVerdict(acc, compareToBound(ecosystem, version, op, bound));
    if (acc === 'miss') return 'miss';
  }
  return acc;
}

function andVerdict(left: RangeVerdict, right: RangeVerdict): RangeVerdict {
  if (left === 'miss' || right === 'miss') return 'miss';
  if (left === 'unknown' || right === 'unknown') return 'unknown';
  return 'match';
}

function compareToBound(
  ecosystem: string | undefined,
  version: string,
  op: string,
  bound: string
): RangeVerdict {
  const cmp = compareByScheme(schemeFor(ecosystem), version, bound);
  // Two versions that cannot be ordered are still equal only when they are the same text.
  if (cmp == null) return op === '=' ? (version.trim() === bound ? 'match' : 'miss') : 'unknown';
  const inside =
    (op === '=' && cmp === 0) ||
    (op === '>' && cmp > 0) ||
    (op === '>=' && cmp >= 0) ||
    (op === '<' && cmp < 0) ||
    (op === '<=' && cmp <= 0);
  return inside ? 'match' : 'miss';
}

/**
 * Orders two versions by the ecosystem's own rules: SemVer (npm, Go, Cargo), PEP 440,
 * Maven, RubyGems, and NuGet/Composer. Returns null when either cannot be ordered.
 */
export function compareVersions(ecosystem: string | undefined, left: string, right: string): number | null {
  return compareByScheme(schemeFor(ecosystem), left, right);
}

function compareByScheme(scheme: Scheme, left: string, right: string): number | null {
  switch (scheme) {
    case 'pep440':
      return comparePep440(left, right);
    case 'maven':
      return compareMaven(left, right);
    case 'ruby':
      return compareRuby(left, right);
    case 'dotted':
      return compareDotted(left, right);
    default:
      return semver.valid(left) != null && semver.valid(right) != null ? semver.compare(left, right) : null;
  }
}

// --- PEP 440 (PyPI) ---

type LocalPart = { kind: 'num'; value: bigint } | { kind: 'str'; value: string };

export type Pep440 = {
  epoch: bigint;
  release: bigint[];
  pre: [string, bigint] | 'final' | 'before-alpha';
  post: bigint | null;
  dev: bigint | null;
  local: LocalPart[] | null;
};

const PEP440 =
  /^v?(?:(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d+)?)?(?:(?:[-_.]?(post|rev|r)[-_.]?(\d+)?)|(?:-(\d+)))?(?:[-_.]?(dev)[-_.]?(\d+)?)?)(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;

export function parsePep440(version: string): Pep440 | null {
  const match = PEP440.exec(version.trim());
  if (!match) return null;
  const preLetter = normalizePepLetter(match[3]);
  const postLetter = match[5] ? 'post' : null;
  const postNum = match[6] ?? match[7];
  const devPresent = match[8] != null;
  let pre: Pep440['pre'];
  if (preLetter) pre = [preLetter, BigInt(match[4] ?? '0')];
  else if (!postLetter && postNum == null && devPresent) pre = 'before-alpha';
  else pre = 'final';
  return {
    epoch: BigInt(match[1] ?? '0'),
    release: match[2].split('.').map((part) => BigInt(part)),
    pre,
    post: postNum != null ? BigInt(postNum) : postLetter ? 0n : null,
    dev: devPresent ? BigInt(match[9] ?? '0') : null,
    local: match[10] ? parsePepLocal(match[10]) : null,
  };
}

function normalizePepLetter(letter: string | undefined): string | null {
  if (!letter) return null;
  switch (letter.toLowerCase()) {
    case 'alpha':
    case 'a':
      return 'a';
    case 'beta':
    case 'b':
      return 'b';
    default:
      return 'rc';
  }
}

function parsePepLocal(local: string): LocalPart[] {
  return local.split(/[-_.]/).map((part) =>
    /^\d+$/.test(part) ? { kind: 'num', value: BigInt(part) } : { kind: 'str', value: part.toLowerCase() }
  );
}

function comparePep440(left: string, right: string): number | null {
  const a = parsePep440(left);
  const b = parsePep440(right);
  if (!a || !b) return null;
  return (
    cmpBig(a.epoch, b.epoch) ||
    cmpRelease(a.release, b.release) ||
    cmpPre(a.pre, b.pre) ||
    cmpOptional(a.post, b.post) ||
    cmpDev(a.dev, b.dev) ||
    cmpLocal(a.local, b.local)
  );
}

function cmpBig(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function cmpRelease(left: bigint[], right: bigint[]): number {
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const cmp = cmpBig(left[i] ?? 0n, right[i] ?? 0n);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function cmpPre(left: Pep440['pre'], right: Pep440['pre']): number {
  const rank = (pre: Pep440['pre']): number => (pre === 'before-alpha' ? 0 : pre === 'final' ? 2 : 1);
  const order = rank(left) - rank(right);
  if (order !== 0) return order < 0 ? -1 : 1;
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  return cmpBig(left[1], right[1]);
}

/** A missing post-release is before any post-release. */
function cmpOptional(left: bigint | null, right: bigint | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return cmpBig(left, right);
}

/** A dev release is before the same version without `.dev`. */
function cmpDev(left: bigint | null, right: bigint | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return cmpBig(left, right);
}

function cmpLocal(left: LocalPart[] | null, right: LocalPart[] | null): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const a = left[i];
    const b = right[i];
    if (!a) return -1;
    if (!b) return 1;
    if (a.kind !== b.kind) return a.kind === 'num' ? 1 : -1;
    if (a.kind === 'num' && b.kind === 'num') {
      const cmp = cmpBig(a.value, b.value);
      if (cmp !== 0) return cmp;
    } else if (a.kind === 'str' && b.kind === 'str' && a.value !== b.value) {
      return a.value < b.value ? -1 : 1;
    }
  }
  return 0;
}

// --- Maven ComparableVersion ---

const MAVEN_QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const MAVEN_RELEASE_INDEX = String(MAVEN_QUALIFIERS.indexOf(''));
const MAVEN_ALIASES: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };

type MItem = MNum | MStr | MList;

class MNum {
  readonly type = 'num' as const;
  readonly value: bigint;
  constructor(raw: string) {
    const stripped = raw.replace(/^0+/, '');
    this.value = BigInt(stripped === '' ? '0' : stripped);
  }
  get isNull(): boolean {
    return this.value === 0n;
  }
  compare(other: MItem | null): number {
    if (other == null) return this.isNull ? 0 : 1;
    if (other.type !== 'num') return 1;
    return cmpBig(this.value, other.value);
  }
}

class MStr {
  readonly type = 'str' as const;
  readonly value: string;
  constructor(raw: string, followedByDigit: boolean) {
    let value = raw;
    if (followedByDigit && value.length === 1) {
      if (value === 'a') value = 'alpha';
      else if (value === 'b') value = 'beta';
      else if (value === 'm') value = 'milestone';
    }
    this.value = MAVEN_ALIASES[value] ?? value;
  }
  get isNull(): boolean {
    return mavenQualifier(this.value) === MAVEN_RELEASE_INDEX;
  }
  compare(other: MItem | null): number {
    const mine = mavenQualifier(this.value);
    if (other == null) return strcmp(mine, MAVEN_RELEASE_INDEX);
    if (other.type === 'str') return strcmp(mine, mavenQualifier(other.value));
    return -1;
  }
}

class MList {
  readonly type = 'list' as const;
  readonly items: MItem[] = [];
  get isNull(): boolean {
    return this.items.length === 0;
  }
  add(item: MItem): void {
    this.items.push(item);
  }
  normalize(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const last = this.items[i];
      if (last.isNull) this.items.splice(i, 1);
      else if (last.type !== 'list') break;
    }
  }
  compare(other: MItem | null): number {
    if (other == null) {
      if (this.items.length === 0) return 0;
      for (const item of this.items) {
        const result = item.compare(null);
        if (result !== 0) return result;
      }
      return 0;
    }
    if (other.type === 'num') return -1;
    if (other.type === 'str') return 1;
    const n = Math.max(this.items.length, other.items.length);
    for (let i = 0; i < n; i++) {
      const left = this.items[i] ?? null;
      const right = other.items[i] ?? null;
      const result = left == null ? (right == null ? 0 : -right.compare(null)) : left.compare(right);
      if (result !== 0) return result;
    }
    return 0;
  }
}

function mavenQualifier(qualifier: string): string {
  const index = MAVEN_QUALIFIERS.indexOf(qualifier);
  return index === -1 ? `${MAVEN_QUALIFIERS.length}-${qualifier}` : String(index);
}

function strcmp(left: string, right: string): number {
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const diff = left.charCodeAt(i) - right.charCodeAt(i);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

function parseMaven(version: string): MList {
  const root = new MList();
  let list = root;
  const stack: MList[] = [root];
  const value = version.toLowerCase();
  let isDigit = false;
  let start = 0;
  const pushList = () => {
    const next = new MList();
    list.add(next);
    list = next;
    stack.push(next);
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '.' || c === '-') {
      list.add(i === start ? new MNum('0') : isDigit ? new MNum(value.slice(start, i)) : new MStr(value.slice(start, i), false));
      start = i + 1;
      if (c === '-') pushList();
    } else if (c >= '0' && c <= '9') {
      if (!isDigit && i > start) {
        if (!list.isNull) pushList();
        list.add(new MStr(value.slice(start, i), true));
        start = i;
        pushList();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.add(new MNum(value.slice(start, i)));
        start = i;
        pushList();
      }
      isDigit = false;
    }
  }
  if (value.length > start) {
    if (!isDigit && !list.isNull) pushList();
    list.add(isDigit ? new MNum(value.slice(start)) : new MStr(value.slice(start), false));
  }
  for (let i = stack.length - 1; i >= 0; i--) stack[i].normalize();
  return root;
}

function compareMaven(left: string, right: string): number | null {
  if (!left.trim() || !right.trim()) return null;
  return parseMaven(left.trim()).compare(parseMaven(right.trim()));
}

// --- RubyGems ---

type RubySeg = { kind: 'num'; value: bigint } | { kind: 'str'; value: string };

function parseRuby(version: string): RubySeg[] | null {
  const trimmed = version.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const segs: RubySeg[] = [];
  for (const part of trimmed.split('.')) {
    if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) return null;
    segs.push(/^\d+$/.test(part) ? { kind: 'num', value: BigInt(part) } : { kind: 'str', value: part });
  }
  while (segs.length > 0 && segs[segs.length - 1].kind === 'num' && segs[segs.length - 1].value === 0n) {
    segs.pop();
  }
  return segs;
}

function compareRuby(left: string, right: string): number | null {
  const a = parseRuby(left);
  const b = parseRuby(right);
  if (!a || !b) return null;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const lhs = a[i] ?? { kind: 'num' as const, value: 0n };
    const rhs = b[i] ?? { kind: 'num' as const, value: 0n };
    if (lhs.kind !== rhs.kind) return lhs.kind === 'str' ? -1 : 1;
    if (lhs.kind === 'num' && rhs.kind === 'num') {
      const cmp = cmpBig(lhs.value, rhs.value);
      if (cmp !== 0) return cmp;
    } else if (lhs.kind === 'str' && rhs.kind === 'str' && lhs.value !== rhs.value) {
      return lhs.value < rhs.value ? -1 : 1;
    }
  }
  return 0;
}

// --- NuGet and Composer: up to four numeric components, then a prerelease ---

type Dotted = { nums: bigint[]; pre: string[] };

function parseDotted(version: string): Dotted | null {
  const match =
    /^v?(\d+(?:\.\d+){0,3})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(
      version.trim()
    );
  if (!match) return null;
  const nums = match[1].split('.').map((part) => BigInt(part));
  while (nums.length < 4) nums.push(0n);
  return { nums, pre: match[2] ? match[2].toLowerCase().split('.') : [] };
}

function compareDotted(left: string, right: string): number | null {
  const a = parseDotted(left);
  const b = parseDotted(right);
  if (!a || !b) return null;
  for (let i = 0; i < 4; i++) {
    const cmp = cmpBig(a.nums[i], b.nums[i]);
    if (cmp !== 0) return cmp;
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  const n = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < n; i++) {
    const lhs = a.pre[i];
    const rhs = b.pre[i];
    if (lhs == null) return -1;
    if (rhs == null) return 1;
    const leftNum = /^\d+$/.test(lhs);
    const rightNum = /^\d+$/.test(rhs);
    if (leftNum !== rightNum) return leftNum ? -1 : 1;
    if (leftNum && rightNum) {
      const cmp = cmpBig(BigInt(lhs), BigInt(rhs));
      if (cmp !== 0) return cmp;
    } else if (lhs !== rhs) {
      return lhs < rhs ? -1 : 1;
    }
  }
  return 0;
}
