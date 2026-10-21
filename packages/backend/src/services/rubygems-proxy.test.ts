import { describe, expect, it } from 'vitest';
import {
  extractRubygemsVersions,
  filterRubygemsVersions,
  parseGemFileName,
  parseRubygemsClientPath,
  parseRubygemsPath,
  rewriteRubygemsUrls,
} from './rubygems-proxy.js';

describe('rubygems-proxy service', () => {
  it('parses rubygems metadata paths', () => {
    expect(parseRubygemsPath('api/v1/versions/rake.json')).toEqual({
      type: 'metadata',
      packageName: 'rake',
      path: 'api/v1/versions/rake.json',
    });
    expect(parseRubygemsPath('api/v1/versions/rake/latest.json')).toEqual({
      type: 'metadata',
      packageName: 'rake',
      path: 'api/v1/versions/rake/latest.json',
    });
  });

  it('extracts and filters rubygems versions', () => {
    const doc = [
      { name: 'rake', number: '13.0.6' },
      { name: 'rake', number: '13.1.0' },
    ];
    const versions = extractRubygemsVersions(doc);
    expect(versions.map((v) => v.version)).toEqual(['13.0.6', '13.1.0']);

    const filtered = filterRubygemsVersions(doc, new Set(['13.0.6'])) as Array<{ number: string }>;
    expect(filtered.map((v) => v.number)).toEqual(['13.1.0']);
  });

  it('points gem download urls at the gateway gems path, with no upstream address in the link', () => {
    const out = rewriteRubygemsUrls(
      {
        gem_uri: 'https://rubygems.org/downloads/rake-13.1.0.gem',
        mirror: 'https://gems.acme.internal/gems/nokogiri-1.16.0-x86_64-linux.gem',
        homepage_uri: 'https://github.com/ruby/rake',
      },
      'http://localhost:3050',
      'default/'
    );
    expect(out.gem_uri).toBe('http://localhost:3050/rubygems/default/gems/rake-13.1.0.gem');
    expect(out.mirror).toBe('http://localhost:3050/rubygems/default/gems/nokogiri-1.16.0-x86_64-linux.gem');
    expect(out.homepage_uri).toBe('https://github.com/ruby/rake');
  });

  it('parses the paths the gem and Bundler clients request', () => {
    expect(parseRubygemsClientPath('versions')).toEqual({ type: 'index', path: 'versions' });
    expect(parseRubygemsClientPath('/info/rack')).toEqual({ type: 'index', path: 'info/rack' });
    expect(parseRubygemsClientPath('quick/Marshal.4.8/rack-2.2.3.gemspec.rz')).toEqual({
      type: 'index',
      path: 'quick/Marshal.4.8/rack-2.2.3.gemspec.rz',
    });
    expect(parseRubygemsClientPath('gems/rack-2.2.3.gem')).toEqual({
      type: 'gem',
      packageName: 'rack',
      version: '2.2.3',
      path: 'gems/rack-2.2.3.gem',
    });
    expect(parseRubygemsClientPath('api/v1/versions/rack.json')).toBeNull();
    expect(parseRubygemsClientPath('info/../etc')).toBeNull();
  });

  it('splits gem file names into name and version, dropping the platform', () => {
    expect(parseGemFileName('concurrent-ruby-1.3.3')).toEqual({ packageName: 'concurrent-ruby', version: '1.3.3' });
    expect(parseGemFileName('rack-3.0.0.rc1')).toEqual({ packageName: 'rack', version: '3.0.0.rc1' });
    expect(parseGemFileName('nokogiri-1.16.0-x86_64-linux')).toEqual({ packageName: 'nokogiri', version: '1.16.0' });
    expect(parseGemFileName('no-version')).toBeNull();
  });
});
