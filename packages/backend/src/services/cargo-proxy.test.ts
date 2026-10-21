import { describe, expect, it } from 'vitest';
import {
  cargoSparseConfig,
  cargoSparseIndexBase,
  parseCargoIndexPath,
  cargoVersionMetaMap,
  extractCargoVersions,
  filterCargoVersions,
  parseCargoPath,
  rewriteCargoUrls,
} from './cargo-proxy.js';

describe('cargo-proxy service', () => {
  it('parses crates metadata and artifact paths', () => {
    expect(parseCargoPath('api/v1/crates/serde')).toEqual({
      type: 'metadata',
      packageName: 'serde',
      path: 'api/v1/crates/serde',
    });
    expect(parseCargoPath('api/v1/crates/serde/1.0.197/download')).toEqual({
      type: 'artifact',
      packageName: 'serde',
      version: '1.0.197',
      path: 'api/v1/crates/serde/1.0.197/download',
    });
  });

  it('extracts and filters crate versions', () => {
    const doc = {
      versions: [
        { num: '1.0.0' },
        { num: '1.2.3' },
        { num: '2.0.0' },
      ],
    };
    expect(extractCargoVersions(doc)).toEqual(['1.0.0', '1.2.3', '2.0.0']);
    const filtered = filterCargoVersions(doc, new Set(['1.2.3'])) as { versions: Array<{ num: string }> };
    expect(filtered.versions.map((v) => v.num)).toEqual(['1.0.0', '2.0.0']);
  });

  it('extracts per-version metadata', () => {
    const doc = {
      versions: [
        {
          num: '1.0.0',
          license: 'MIT OR Apache-2.0',
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    };
    expect(cargoVersionMetaMap(doc).get('1.0.0')).toEqual({
      license: 'MIT OR Apache-2.0',
      time: '2024-01-01T00:00:00.000Z',
    });
  });

  it('rewrites crates.io download urls to gateway urls recursively', () => {
    const input = {
      crate: {
        dl_path: '/api/v1/crates/serde/1.0.197/download',
      },
      links: {
        version_downloads: 'https://crates.io/api/v1/crates/serde/1.0.197/download',
      },
    };
    const out = rewriteCargoUrls(input, 'http://localhost:3050');
    expect(out.crate.dl_path).toBe('http://localhost:3050/cargo/api/v1/crates/serde/1.0.197/download');
    expect(out.links.version_downloads).toBe(
      'http://localhost:3050/cargo/api/v1/crates/serde/1.0.197/download'
    );
  });

  it('parses sparse index paths', () => {
    expect(parseCargoIndexPath('config.json')).toEqual({ type: 'config' });
    expect(parseCargoIndexPath('1/a')).toEqual({ type: 'index', packageName: 'a' });
    expect(parseCargoIndexPath('2/cc')).toEqual({ type: 'index', packageName: 'cc' });
    expect(parseCargoIndexPath('3/l/log')).toEqual({ type: 'index', packageName: 'log' });
    expect(parseCargoIndexPath('se/rd/serde')).toEqual({ type: 'index', packageName: 'serde' });
    expect(parseCargoIndexPath('api/v1/crates/serde')).toBeNull();
    expect(parseCargoIndexPath('api/v1/crates/serde/1.0.0/download')).toBeNull();
  });

  it('points crates.io at its sparse index and dl at the gateway download route', () => {
    expect(cargoSparseIndexBase('https://crates.io')).toBe('https://index.crates.io');
    expect(cargoSparseIndexBase('https://cargo.example.com/index/')).toBe('https://cargo.example.com/index');
    expect(cargoSparseConfig('http://localhost:3050', 'default/')).toEqual({
      dl: 'http://localhost:3050/cargo/default/api/v1/crates',
      api: 'http://localhost:3050/cargo/default',
      'auth-required': true,
    });
  });
});
