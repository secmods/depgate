import { Minimatch } from 'minimatch';

/**
 * One spelling per package, for every name DepGate stores or looks up: malicious packages
 * entries, exceptions and waivers, and the request's name when it is matched against them.
 * Routes pass names as the client sent them (NuGet and RubyGems lowercased, Go with `!x` for
 * capitals, PyPI as pip normalized them); feeds and administrators use their own spelling.
 * npm, Maven and Go names stay case-sensitive: their registries treat case variants as different
 * packages. Namespace reservation compares more loosely (namespace-patterns canonicalName).
 */
export function canonicalPackageName(ecosystem: string, name: string): string {
  switch (ecosystem) {
    case 'pypi':
      // PEP 503
      return name.toLowerCase().replace(/[-_.]+/g, '-');
    case 'nuget':
    case 'rubygems':
    case 'composer':
      return name.toLowerCase();
    case 'cargo':
    case 'crates.io':
      // crates.io treats `-` and `_` as the same name.
      return name.toLowerCase().replace(/_/g, '-');
    case 'go':
      // Module proxy case encoding: `!x` is `X`. `!` cannot occur in a module path otherwise.
      return name.replace(/!([a-z])/g, (_, letter: string) => letter.toUpperCase());
    default:
      return name;
  }
}

/**
 * A policy's package-name pattern. Matches the name as the client sent it, or failing that both
 * canonical, so `github.com/BufferZoneCorp/*` catches the Go request `github.com/!buffer!zone!corp/x`
 * and `my_pkg` catches pip's `my-pkg`. A leading `!` (negation) is kept as typed.
 */
export class PackagePattern {
  private readonly raw: Minimatch;
  private readonly canonical = new Map<string, Minimatch>();

  constructor(readonly pattern: string) {
    this.raw = new Minimatch(pattern, { nocase: true });
  }

  match(ecosystem: string | undefined, name: string): boolean {
    const raw = this.raw.match(name);
    if (!ecosystem) return raw;
    let matcher = this.canonical.get(ecosystem);
    if (!matcher) {
      const negation = /^!*/.exec(this.pattern)![0];
      const body = canonicalPackageName(ecosystem, this.pattern.slice(negation.length));
      matcher = new Minimatch(negation + body, { nocase: true });
      this.canonical.set(ecosystem, matcher);
    }
    const canonical = matcher.match(canonicalPackageName(ecosystem, name));
    // "Anything but X" must exclude every spelling of X; a plain pattern needs only one to match.
    return this.raw.negate ? raw && canonical : raw || canonical;
  }
}

/** The malicious packages feed stores Cargo entries under OSV's name for the ecosystem. */
export function malwareEcosystems(ecosystem: string): string[] {
  if (ecosystem === 'cargo' || ecosystem === 'crates.io') return ['cargo', 'crates.io'];
  return [ecosystem];
}
