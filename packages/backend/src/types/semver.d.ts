declare module 'semver' {
  class Range {
    constructor(range: string);
  }
  function valid(version: string | null | undefined): string | null;
  function validRange(range: string | null | undefined): string | null;
  function compare(a: string, b: string): -1 | 0 | 1;
  function satisfies(
    version: string,
    range: string | Range,
    options?: { includePrerelease?: boolean; loose?: boolean }
  ): boolean;
  function rcompare(a: string, b: string): number;
  function prerelease(version: string): ReadonlyArray<string | number> | null;

  namespace semver {
    export { Range, valid, validRange, compare, satisfies, rcompare, prerelease };
  }
  export = semver;
}
