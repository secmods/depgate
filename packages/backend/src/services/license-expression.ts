import { Minimatch } from 'minimatch';

/**
 * A package's license as a small SPDX-style expression tree.
 *
 * Registries report licenses in different shapes: SPDX expressions (`MIT OR Apache-2.0`),
 * Cargo's old `MIT/Apache-2.0`, plain names (`Apache License 2.0`), PyPI classifiers, and
 * lists without AND or OR. Lists that do not say are read as AND, the cautious choice:
 * every license applies.
 */
export type LicenseNode =
  | { kind: 'id'; text: string; exception?: string }
  | { kind: 'and' | 'or'; items: LicenseNode[] };

/** Values that say nothing about the license. */
const UNKNOWN = new Set(['', 'unknown', 'noassertion', 'none', 'other', 'n/a', 'na', 'null', 'undefined', 'license']);

/** Longer than any identifier: a pasted license text, not a name. */
const MAX_ID_LENGTH = 100;

/** Common names and PyPI classifier names mapped to their SPDX id. Lowercase keys. */
const ALIASES: Record<string, string> = {
  'mit license': 'MIT',
  'the mit license': 'MIT',
  'mit/x11': 'MIT',
  'expat': 'MIT',
  'apache 2': 'Apache-2.0',
  'apache 2.0': 'Apache-2.0',
  'apache-2': 'Apache-2.0',
  'apache license 2.0': 'Apache-2.0',
  'apache license, version 2.0': 'Apache-2.0',
  'apache license version 2.0': 'Apache-2.0',
  'the apache license, version 2.0': 'Apache-2.0',
  'the apache software license, version 2.0': 'Apache-2.0',
  'apache software license 2.0': 'Apache-2.0',
  'apache software license': 'Apache-2.0',
  'asl 2.0': 'Apache-2.0',
  'bsd 3-clause': 'BSD-3-Clause',
  'bsd-3': 'BSD-3-Clause',
  'new bsd license': 'BSD-3-Clause',
  'modified bsd license': 'BSD-3-Clause',
  'bsd 2-clause': 'BSD-2-Clause',
  'simplified bsd license': 'BSD-2-Clause',
  'isc license': 'ISC',
  'isc license (iscl)': 'ISC',
  'python software foundation license': 'PSF-2.0',
  'mozilla public license 2.0': 'MPL-2.0',
  'mozilla public license 2.0 (mpl 2.0)': 'MPL-2.0',
  'eclipse public license 1.0': 'EPL-1.0',
  'eclipse public license - v 1.0': 'EPL-1.0',
  'eclipse public license 2.0': 'EPL-2.0',
  'eclipse public license - v 2.0': 'EPL-2.0',
  'gnu general public license v2 (gplv2)': 'GPL-2.0-only',
  'gnu general public license v3 (gplv3)': 'GPL-3.0-only',
  'gnu lesser general public license v3 (lgplv3)': 'LGPL-3.0-only',
  'gnu affero general public license v3': 'AGPL-3.0-only',
  'the unlicense (unlicense)': 'Unlicense',
  'public domain': 'Unlicense',
  'zlib/libpng license': 'Zlib',
};

/** PyPI classifiers name a license after the last `::`. */
const CLASSIFIER = /^License\s*::\s*(?:OSI Approved\s*::\s*)?(.+)$/i;

export function licenseFromClassifiers(classifiers: unknown): string | undefined {
  if (!Array.isArray(classifiers)) return undefined;
  const names = classifiers
    .map((item) => (typeof item === 'string' ? CLASSIFIER.exec(item)?.[1]?.trim() : undefined))
    .filter((name): name is string => !!name && name.toLowerCase() !== 'osi approved');
  if (names.length === 0) return undefined;
  return names.map(canonicalId).join(' AND ');
}

/** The SPDX id for a known name; otherwise the name as given. */
export function canonicalId(name: string): string {
  const trimmed = name.trim();
  return ALIASES[trimmed.toLowerCase()] ?? trimmed;
}

type Token = { type: 'word'; value: string } | { type: 'op'; value: 'and' | 'or' | 'with' } | { type: '(' | ')' };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  // Cargo's old `MIT/Apache-2.0` means OR. Commas and semicolons separate a plain list (AND).
  const spaced = text.replace(/\s*\/\s*/g, ' OR ').replace(/\s*[,;]\s*/g, ' AND ');
  for (const part of spaced.match(/\(|\)|[^\s()]+/g) ?? []) {
    if (part === '(' || part === ')') {
      tokens.push({ type: part });
      continue;
    }
    const lower = part.toLowerCase();
    if (lower === 'or' || lower === 'and' || lower === 'with') tokens.push({ type: 'op', value: lower });
    else tokens.push({ type: 'word', value: part });
  }
  return tokens;
}

/**
 * Parses `a OR (b AND c WITH x)`. Consecutive words form one name, so `Apache License 2.0`
 * stays together. Returns null for an expression it cannot read.
 */
function parseTokens(tokens: Token[]): LicenseNode | null {
  let index = 0;

  const parseOr = (): LicenseNode | null => {
    const items: LicenseNode[] = [];
    const first = parseAnd();
    if (!first) return null;
    items.push(first);
    while (tokens[index]?.type === 'op' && (tokens[index] as { value: string }).value === 'or') {
      index += 1;
      const next = parseAnd();
      if (!next) return null;
      items.push(next);
    }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  };

  const parseAnd = (): LicenseNode | null => {
    const items: LicenseNode[] = [];
    const first = parseAtom();
    if (!first) return null;
    items.push(first);
    while (tokens[index]?.type === 'op' && (tokens[index] as { value: string }).value === 'and') {
      index += 1;
      const next = parseAtom();
      if (!next) return null;
      items.push(next);
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  };

  const parseAtom = (): LicenseNode | null => {
    const token = tokens[index];
    if (!token) return null;
    if (token.type === '(') {
      index += 1;
      const inner = parseOr();
      if (!inner || tokens[index]?.type !== ')') return null;
      index += 1;
      return inner;
    }
    const words: string[] = [];
    while (tokens[index]?.type === 'word') {
      words.push((tokens[index] as { value: string }).value);
      index += 1;
    }
    if (words.length === 0) return null;
    const node: LicenseNode = { kind: 'id', text: canonicalId(words.join(' ')) };
    if (tokens[index]?.type === 'op' && (tokens[index] as { value: string }).value === 'with') {
      index += 1;
      const exception: string[] = [];
      while (tokens[index]?.type === 'word') {
        exception.push((tokens[index] as { value: string }).value);
        index += 1;
      }
      if (exception.length === 0) return null;
      node.exception = exception.join(' ');
    }
    return node;
  };

  const tree = parseOr();
  return tree && index === tokens.length ? tree : null;
}

/**
 * The license as an expression tree, or null when it is unknown: missing, a placeholder such as
 * NOASSERTION, a pointer such as `SEE LICENSE IN LICENSE.md`, or a pasted license text.
 */
export function parseLicense(text: string | null | undefined): LicenseNode | null {
  const trimmed = (text ?? '').trim();
  if (UNKNOWN.has(trimmed.toLowerCase())) return null;
  if (/^see license in\b/i.test(trimmed) || /\n/.test(trimmed) || trimmed.length > 4 * MAX_ID_LENGTH) return null;
  const whole = ALIASES[trimmed.toLowerCase()];
  if (whole) return { kind: 'id', text: whole };
  const tokens = tokenize(trimmed);
  const tree = tokens ? parseTokens(tokens) : null;
  if (tree && everyId(tree, (id) => id.text.length <= MAX_ID_LENGTH)) return tree;
  // Not an expression: one name, as long as it is short enough to be a name.
  return trimmed.length <= MAX_ID_LENGTH ? { kind: 'id', text: canonicalId(trimmed) } : null;
}

function everyId(node: LicenseNode, test: (id: Extract<LicenseNode, { kind: 'id' }>) => boolean): boolean {
  return node.kind === 'id' ? test(node) : node.items.every((item) => everyId(item, test));
}

export function compileLicensePatterns(patterns: readonly string[]): Minimatch[] {
  return patterns
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new Minimatch(pattern, { nocase: true }));
}

/**
 * The names one license can be listed under: as written, without an exception, and without the
 * SPDX `-only`, `-or-later` or `+` suffix. So a list entry `GPL-3.0` covers `GPL-3.0-only`,
 * `GPL-3.0-or-later` and `GPL-3.0+`.
 */
function names(node: Extract<LicenseNode, { kind: 'id' }>): string[] {
  const base = node.text.replace(/(-only|-or-later|\+)$/i, '');
  const out = new Set<string>([node.text, base]);
  if (node.exception) {
    out.add(`${node.text} WITH ${node.exception}`);
    out.add(`${base} WITH ${node.exception}`);
  }
  return [...out];
}

function listed(node: Extract<LicenseNode, { kind: 'id' }>, matchers: Minimatch[]): boolean {
  return names(node).some((name) => matchers.some((matcher) => matcher.match(name)));
}

/** Every license that applies is approved. Under OR one approved choice is enough. */
export function licenseApproved(node: LicenseNode, matchers: Minimatch[]): boolean {
  if (node.kind === 'id') return listed(node, matchers);
  if (node.kind === 'and') return node.items.every((item) => licenseApproved(item, matchers));
  return node.items.some((item) => licenseApproved(item, matchers));
}

/** A denied license cannot be avoided. Under OR it is denied only when every choice is. */
export function licenseDenied(node: LicenseNode, matchers: Minimatch[]): boolean {
  if (node.kind === 'id') return listed(node, matchers);
  if (node.kind === 'and') return node.items.some((item) => licenseDenied(item, matchers));
  return node.items.every((item) => licenseDenied(item, matchers));
}

/** The expression as one line, for reasons and the UI. */
export function formatLicense(node: LicenseNode, nested = false): string {
  if (node.kind === 'id') return node.exception ? `${node.text} WITH ${node.exception}` : node.text;
  const joined = node.items.map((item) => formatLicense(item, true)).join(node.kind === 'and' ? ' AND ' : ' OR ');
  return nested ? `(${joined})` : joined;
}
