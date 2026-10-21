import { describe, expect, it } from 'vitest';
import {
  extractFlatContainerVersions,
  filterFlatContainerVersions,
  parseNugetPath,
  rewriteNugetUrls,
  isNugetPackageFile,
} from './nuget-proxy.js';

describe('nuget-proxy service', () => {
  it('parses flat container metadata path', () => {
    expect(parseNugetPath('v3-flatcontainer/newtonsoft.json/index.json')).toEqual({
      type: 'metadata',
      packageName: 'newtonsoft.json',
      path: 'v3-flatcontainer/newtonsoft.json/index.json',
    });
  });

  it('parses flat container artifact path', () => {
    expect(
      parseNugetPath('v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg')
    ).toEqual({
      type: 'artifact',
      packageName: 'newtonsoft.json',
      version: '13.0.3',
      fileName: 'newtonsoft.json.13.0.3.nupkg',
      path: 'v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg',
    });
  });

  it('extracts and filters flat container versions', () => {
    const doc = { versions: ['1.0.0', '2.0.0', '3.0.0'] };
    expect(extractFlatContainerVersions(doc)).toEqual(['1.0.0', '2.0.0', '3.0.0']);
    const filtered = filterFlatContainerVersions(doc, new Set(['2.0.0'])) as { versions: string[] };
    expect(filtered.versions).toEqual(['1.0.0', '3.0.0']);
  });

  it('rewrites api.nuget.org flatcontainer urls to gateway urls recursively', () => {
    const input = {
      packageContent: 'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg',
      nested: [
        'https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json',
        { x: 'https://example.com/no-change' },
      ],
    };
    const out = rewriteNugetUrls(input, 'http://localhost:3050');
    expect(out.packageContent).toContain('http://localhost:3050/nuget/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg');
    expect(out.nested[0]).toContain('http://localhost:3050/nuget/v3-flatcontainer/newtonsoft.json/index.json');
    expect((out.nested[1] as { x: string }).x).toBe('https://example.com/no-change');
  });

  it('identifies the package file', () => {
    expect(isNugetPackageFile('pkg.1.0.0.nupkg')).toBe(true);
    expect(isNugetPackageFile('pkg.1.0.0.nupkg.sha512')).toBe(false);
    expect(isNugetPackageFile('pkg.nuspec')).toBe(false);
  });

  it('rewrites the service index PackageBaseAddress, which is the bare flat-container URL', () => {
    const index = {
      resources: [
        { '@id': 'https://api.nuget.org/v3-flatcontainer/', '@type': 'PackageBaseAddress/3.0.0' },
      ],
    };
    const out = rewriteNugetUrls(index, 'http://localhost:3050', 'default/');
    expect(out.resources[0]['@id']).toBe('http://localhost:3050/nuget/default/v3-flatcontainer/');
  });
});
