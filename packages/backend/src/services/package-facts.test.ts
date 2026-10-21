import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import { withPlainRoutes } from '../test-support/plain-route.js';

const fetchFromUpstream = vi.fn();
const fetchStreamFromUpstream = vi.fn();
const queryOSVBatch = vi.fn();

vi.mock('./upstream-provider.js', () => ({
  fetchFromUpstream: (...args: unknown[]) => fetchFromUpstream(...args),
  fetchStreamFromUpstream: (...args: unknown[]) => fetchStreamFromUpstream(...args),
}));

vi.mock('./osv-provider.js', () => ({
  queryOSVBatch: (...args: unknown[]) => queryOSVBatch(...args),
}));

vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

import { factsKey, loadVersionFacts } from './package-facts.js';

const db = {} as DataSource;
const metaOnly = { license: true, publishedAt: true, cve: false };

function streamResponse(status: number, text: string, headers: Record<string, string> = {}) {
  return {
    status,
    fromUrl: 'https://upstream.test/x',
    headers: new Headers(headers),
    body: Readable.from([Buffer.from(text)]),
  };
}

const pypiDoc = {
  info: { license: 'MIT' },
  releases: {
    '1.0.0': [{ upload_time_iso_8601: '2020-01-01T00:00:00.000Z' }],
    '2.0.0': [{ upload_time_iso_8601: '2024-06-01T00:00:00.000Z' }],
  },
};

describe('package facts', () => {
  beforeEach(() => {
    fetchFromUpstream.mockReset();
    fetchStreamFromUpstream.mockReset();
    queryOSVBatch.mockReset();
  });

  it('keeps facts per repository so a private package does not inherit public dates', async () => {
    const memory = createMemoryRedis();
    const redis = memory as unknown as Redis;
    fetchFromUpstream.mockResolvedValue({ status: 200, body: pypiDoc, fromUrl: 'https://pypi.test' });

    const facts = await loadVersionFacts(db, redis, 'pypi', 'acme', ['1.0.0'], metaOnly, 'internal');
    expect(facts.get('1.0.0')?.publishedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(facts.get('1.0.0')?.packageLastReleaseAt).toBe('2024-06-01T00:00:00.000Z');
    expect(await memory.get(factsKey('pypi', 'internal', 'acme', '1.0.0'))).toBeTruthy();
    expect(await memory.get(factsKey('pypi', 'default', 'acme', '1.0.0'))).toBeNull();
  });

  it('does not cache a version the upstream document did not list', async () => {
    const memory = createMemoryRedis();
    fetchFromUpstream.mockResolvedValue({ status: 200, body: pypiDoc, fromUrl: 'https://pypi.test' });

    const facts = await loadVersionFacts(db, memory as unknown as Redis, 'pypi', 'acme', ['3.0.0'], metaOnly, 'default');
    expect(facts.get('3.0.0')?.publishedKnown).toBe(true);
    expect(facts.get('3.0.0')?.publishedAt).toBeUndefined();
    expect(await memory.get(factsKey('pypi', 'default', 'acme', '3.0.0'))).toBeNull();
  });

  it('does not cache facts when the upstream document failed', async () => {
    const memory = createMemoryRedis();
    fetchFromUpstream.mockResolvedValue({ status: 502, body: {}, fromUrl: 'https://pypi.test' });

    await loadVersionFacts(db, memory as unknown as Redis, 'pypi', 'acme', ['1.0.0'], metaOnly, 'default');
    expect(await memory.get(factsKey('pypi', 'default', 'acme', '1.0.0'))).toBeNull();
  });

  it('never writes seeded npm facts, and treats a missing publish time as unknown', async () => {
    const memory = createMemoryRedis();
    const seeded = new Map([['1.0.0', { license: 'MIT', licenseKnown: true, publishedKnown: false }]]);

    const facts = await loadVersionFacts(db, memory as unknown as Redis, 'npm', 'left-pad', ['1.0.0'], metaOnly, 'default', seeded);
    expect(facts.get('1.0.0')?.license).toBe('MIT');
    expect(facts.get('1.0.0')?.publishedAt).toBeUndefined();
    expect(await memory.get(factsKey('npm', 'default', 'left-pad', '1.0.0'))).toBeNull();
  });

  it('keeps vulnerabilities out of the long-lived facts entry', async () => {
    const memory = createMemoryRedis();
    fetchFromUpstream.mockResolvedValue({ status: 200, body: pypiDoc, fromUrl: 'https://pypi.test' });
    queryOSVBatch.mockResolvedValue(new Map([['1.0.0', [{ id: 'GHSA-1' }]]]));

    const facts = await loadVersionFacts(
      db,
      memory as unknown as Redis,
      'pypi',
      'acme',
      ['1.0.0'],
      { license: true, publishedAt: true, cve: true },
      'default'
    );
    expect(facts.get('1.0.0')?.vulns.map((v) => v.id)).toEqual(['GHSA-1']);
    const stored = JSON.parse((await memory.get(factsKey('pypi', 'default', 'acme', '1.0.0'))) ?? '{}');
    expect(stored.vulns).toBeUndefined();
    expect(stored.hasVulns).toBeUndefined();
  });

  it('uses each Maven POM Last-Modified as that version publish time', async () => {
    const memory = createMemoryRedis();
    fetchStreamFromUpstream.mockImplementation(async (_db: unknown, _eco: string, path: string) => {
      if (path.endsWith('maven-metadata.xml')) {
        return streamResponse(200, '<metadata><versioning><lastUpdated>20240601000000</lastUpdated></versioning></metadata>');
      }
      if (path.endsWith('junit-4.12.pom')) {
        return streamResponse(200, '<project><licenses><license><name>EPL-1.0</name></license></licenses></project>', {
          'last-modified': 'Thu, 04 Dec 2014 16:17:43 GMT',
        });
      }
      if (path.endsWith('junit-4.13.2.pom')) {
        return streamResponse(200, '<project/>', { 'last-modified': 'Sat, 13 Feb 2021 16:31:54 GMT' });
      }
      return streamResponse(404, '');
    });

    const facts = await loadVersionFacts(db, memory as unknown as Redis, 'maven', 'junit:junit', ['4.12', '4.13.2'], metaOnly, 'default');
    expect(facts.get('4.12')?.publishedAt).toBe('2014-12-04T16:17:43.000Z');
    expect(facts.get('4.12')?.license).toBe('EPL-1.0');
    expect(facts.get('4.13.2')?.publishedAt).toBe('2021-02-13T16:31:54.000Z');
    expect(facts.get('4.12')?.packageLastReleaseAt).toBe('2024-06-01T00:00:00.000Z');
  });
});

describe('license reading', () => {
  it('PyPI: license_expression, then a short license field, then classifiers', async () => {
    const { pypiLicense } = await import('./package-facts.js');
    expect(pypiLicense({ license_expression: 'BSD-3-Clause AND 0BSD', license: '' })).toBe('BSD-3-Clause AND 0BSD');
    expect(pypiLicense({ license: 'Apache-2.0', classifiers: ['License :: OSI Approved :: MIT License'] })).toBe('Apache-2.0');
    expect(
      pypiLicense({
        license: 'Copyright (c) 2005-2024, NumPy Developers.\nAll rights reserved.',
        classifiers: ['License :: OSI Approved :: BSD License'],
      })
    ).toBe('BSD License');
    expect(pypiLicense({ license: '', classifiers: ['License :: OSI Approved :: MIT License'] })).toBe('MIT');
    expect(pypiLicense({})).toBeUndefined();
  });

  it('Maven: every declared license, as alternatives', async () => {
    const { pomLicense } = await import('./package-facts.js');
    const pom = (names: string[]) =>
      `<project><licenses>${names.map((name) => `<license><name>${name}</name></license>`).join('')}</licenses></project>`;
    expect(pomLicense(pom(['EPL-1.0']))).toBe('EPL-1.0');
    expect(pomLicense(pom(['EPL-2.0', 'GNU General Public License, version 2 with the GNU Classpath Exception']))).toBe(
      'EPL-2.0 OR (GNU General Public License, version 2 with the GNU Classpath Exception)'
    );
    expect(pomLicense('<project/>')).toBeUndefined();
  });
});
