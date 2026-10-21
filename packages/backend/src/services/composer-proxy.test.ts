import { describe, expect, it } from 'vitest';
import {
  composerRootDocument,
  createComposerArtifactMatcher,
  extractComposerVersions,
  filterComposerVersions,
  parseComposerPath,
  composerDistHref,
  rewriteComposerDistUrls,
} from './composer-proxy.js';

describe('composer-proxy service', () => {
  it('parses known composer metadata paths', () => {
    expect(parseComposerPath('packages.json')).toEqual({ type: 'metadata', path: 'packages.json' });
    expect(parseComposerPath('packages/monolog/monolog.json')).toEqual({
      type: 'metadata',
      packageName: 'monolog/monolog',
      path: 'packages/monolog/monolog.json',
    });
    expect(parseComposerPath('p2/monolog/monolog.json')).toEqual({
      type: 'metadata',
      packageName: 'monolog/monolog',
      path: 'p2/monolog/monolog.json',
    });
  });

  it('extracts and filters composer versions from p2 payload', () => {
    const doc = {
      packages: {
        'monolog/monolog': [
          { version: '2.9.0', dist: { shasum: 'a'.repeat(40) } },
          { version: '3.0.0', dist: { shasum: 'b'.repeat(40) } },
        ],
      },
    };
    const versions = extractComposerVersions(doc);
    expect(versions.map((v) => v.version)).toEqual(['2.9.0', '3.0.0']);

    const blocked = new Map<string, Set<string>>([['monolog/monolog', new Set(['2.9.0'])]]);
    const filtered = filterComposerVersions(doc, blocked) as {
      packages: { 'monolog/monolog': Array<{ version: string }> };
    };
    expect(filtered.packages['monolog/monolog'].map((v) => v.version)).toEqual(['3.0.0']);
  });

  it('matches dist urls by commit hash instead of the first version', () => {
    const hash1 = 'a'.repeat(40);
    const hash2 = `${'abc1234'}${'b'.repeat(33)}`;
    const hash3 = `${'abc1234'}${'c'.repeat(33)}`;
    const url1 = `https://api.github.com/repos/Seldaek/monolog/zipball/${hash1}`;
    const url2 = `https://api.github.com/repos/Seldaek/monolog/zipball/${hash2}`;
    const doc = {
      packages: {
        'monolog/monolog': [
          { version: '1.0.0', dist: { url: url1, reference: hash1, shasum: '1'.repeat(40) } },
          { version: '2.0.0', version_normalized: '2.0.0.0', dist: { url: url2, reference: hash2, shasum: '2'.repeat(40) } },
          { version: '2.1.0', dist: { url: `https://example.com/archive/${hash3}.zip`, reference: hash3 } },
        ],
      },
    };
    const match = createComposerArtifactMatcher(extractComposerVersions(doc));

    expect(match(url2)?.version).toBe('2.0.0');
    expect(match(url2)?.distUrl).toBe(url2);
    expect(match(`https://codeload.github.com/Seldaek/monolog/legacy.zip/${hash2}`)?.version).toBe('2.0.0');
    expect(match(`https://gitlab.com/group/proj/-/archive/${hash2.slice(0, 12)}/proj.zip`)?.version).toBe('2.0.0');
    expect(match(url1)?.version).toBe('1.0.0');
    // A short hash shared by two versions must not be assigned to the first one.
    expect(match('https://example.com/archive/abc1234.zip')).toBeUndefined();
    expect(match('https://github.com/Seldaek/monolog.git')).toBeUndefined();
  });

  it('rewrites every absolute url and builds dist links with no upstream address', () => {
    const input = {
      dist: { url: 'https://codeload.github.com/owner/repo/legacy.zip/hash', shasum: 'abc' },
      'metadata-url': '/composer/p2/%package%.json',
    };
    const out = rewriteComposerDistUrls(input, () => composerDistHref('http://localhost:3050', 'owner/repo', '1.0.0', 'default/'));
    expect(out.dist.url).toBe('http://localhost:3050/composer/default/dist/owner/repo/1.0.0');
    expect(out['metadata-url']).toBe('/composer/p2/%package%.json');
    expect(composerDistHref('http://localhost:3050', 'acme/pkg', 'dev-main#1')).toBe('http://localhost:3050/composer/dist/acme/pkg/dev-main%231');
  });

  it('root packages.json points metadata-url at the gateway and drops upstream endpoints', () => {
    const upstream = {
      packages: [],
      'notify-batch': 'https://packagist.org/downloads/',
      'metadata-url': 'https://repo.packagist.org/p2/%package%.json',
      search: 'https://packagist.org/search.json?q=%query%&type=%type%',
      'security-advisories': { metadata: true, 'api-url': 'https://packagist.org/api/security-advisories/' },
    };
    const root = composerRootDocument(upstream, 'default/');
    expect(root).toEqual({ packages: [], 'metadata-url': '/composer/default/p2/%package%.json' });
    const rewritten = rewriteComposerDistUrls(root, () => 'http://localhost:3050/composer/dist/unlisted');
    expect(rewritten['metadata-url']).toBe('/composer/default/p2/%package%.json');
    expect(composerRootDocument(upstream)['metadata-url']).toBe('/composer/p2/%package%.json');
  });
});
