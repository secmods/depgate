import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §6.2: every place that fetches a package from an upstream goes through resolvePackageTargets,
 * so no path can skip the internal namespace filter. This test reads the source and fails when a
 * new call site fetches upstream some other way.
 */

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'test-support') out.push(...sourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

/** The argument text of each call to `name(` in `text`. */
function calls(text: string, name: string): string[] {
  const found: string[] = [];
  const pattern = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s+$/.test(before)) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < text.length; end += 1) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(text.slice(match.index + match[0].length, end));
  }
  return found;
}

/** Package routes: each one serves package metadata or artifacts from upstream. */
const ECOSYSTEM_ROUTES = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'].map((eco) => `routes/${eco}.ts`);

/** Files that may resolve a repository's remotes directly. None of them fetches a package with the result. */
const RESOLVE_ALLOWED: Record<string, string> = {
  'services/repository-resolve.ts': 'defines it',
  'services/namespace-protection.ts': 'the helper itself',
  'services/upstream-provider.ts': 'fallback when no repository is configured',
  'routes/repositories.ts': 'lists the members of `all` for the admin view',
  'services/deps-dev.ts': 'checks whether every remote is a public host; it never fetches from them',
  'services/policy-simulation.ts': 'lists the remotes a recorded request could have used, for policy scope; it never fetches',
};

describe('every upstream package fetch goes through resolvePackageTargets (§6.2)', () => {
  it('finds the call sites it guards', () => {
    const fetchSites = FILES.flatMap((file) => [
      ...calls(file.text, 'fetchFromUpstream'),
      ...calls(file.text, 'fetchStreamFromUpstream'),
    ]);
    expect(fetchSites.length).toBeGreaterThan(15);
  });

  it('fetchFromUpstream and fetchStreamFromUpstream get a route, or targets taken from one', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file.path === 'services/upstream-provider.ts') continue;
      for (const name of ['fetchFromUpstream', 'fetchStreamFromUpstream']) {
        for (const args of calls(file.text, name)) {
          const viaRoute = /\{\s*route\s*\}|\broute\b\s*[,}]|route:\s*\w+/.test(args);
          const viaTargets = /targets:\s*[^,}]*(?:source|route)/.test(args);
          // Options from trackArtifactSource(route, …) or a packument source: the route's targets, possibly pinned to one (R5).
          // The artifact cache reads the same options first, so a route may hold them in `const options = await fetchOptions()`.
          const viaPinned =
            (/\bawait\s+fetchOptions\(\)/.test(args) ||
              (/,\s*options\s*$/.test(args) && /const options = await fetchOptions\(\);/.test(file.text))) &&
            /track(?:Artifact|Known)Source\(/.test(file.text);
          if (!viaRoute && !viaTargets && !viaPinned) offenders.push(`${file.path}: ${name}(${args.replace(/\s+/g, ' ').slice(0, 100)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no file resolves remote targets for a package outside the allowed list', () => {
    const offenders = FILES.filter((file) => calls(file.text, 'resolveRemoteTargets').length > 0)
      .map((file) => file.path)
      .filter((path) => !(path in RESOLVE_ALLOWED));
    expect(offenders).toEqual([]);
  });

  it('upstream document reads (readUpstreamJson/Text) are given a route', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const name of ['readUpstreamJson', 'readUpstreamText']) {
        for (const args of calls(file.text, name)) {
          const third = args.split(',')[2]?.trim() ?? '';
          if (!/^(route|resolved)$/.test(third)) offenders.push(`${file.path}: ${name}(${args.slice(0, 80)})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('each ecosystem route resolves the package route, and a route that fetches by URL checks it against the route', () => {
    for (const path of ECOSYSTEM_ROUTES) {
      const file = FILES.find((candidate) => candidate.path === path);
      expect(file, path).toBeDefined();
      expect(calls(file!.text, 'packageRoute').length, `${path} calls packageRoute`).toBeGreaterThan(0);
      // A raw fetch() of an upstream URL (signed artifact tokens, sparse index) must be tied to the route.
      const raw = calls(file!.text, 'fetch');
      if (raw.length > 0) {
        expect(/servingTarget\(|route\.targets/.test(file!.text), `${path} checks raw fetches against the route`).toBe(true);
      }
    }
  });

  it('every handler that fetches upstream sits in a file that resolves the route', () => {
    for (const file of FILES) {
      if (!file.path.startsWith('routes/')) continue;
      const fetches = calls(file.text, 'fetchFromUpstream').length + calls(file.text, 'fetchStreamFromUpstream').length;
      if (fetches === 0) continue;
      expect(calls(file.text, 'packageRoute').length, `${file.path} resolves the package route`).toBeGreaterThan(0);
    }
  });
});
