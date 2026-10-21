import { describe, it, expect, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import {
  getVulnIds,
  displayVulnId,
  hasVulnInBlockList,
  queryOSV,
  queryOSVBatch,
  toOsvEcosystem,
  type OSVVuln,
} from './osv-provider.js';
import { createMemoryRedis } from '../test-support/memory-redis.js';
import { config } from '../config.js';

vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    setex: vi.fn(),
  };
  return { default: vi.fn(() => mockRedis) };
});

describe('osv-provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('toOsvEcosystem', () => {
    it('maps DepGate ecosystem ids to OSV names', () => {
      expect(toOsvEcosystem('npm')).toBe('npm');
      expect(toOsvEcosystem('pypi')).toBe('PyPI');
      expect(toOsvEcosystem('go')).toBe('Go');
      expect(toOsvEcosystem('maven')).toBe('Maven');
      expect(toOsvEcosystem('nuget')).toBe('NuGet');
      expect(toOsvEcosystem('cargo')).toBe('crates.io');
      expect(toOsvEcosystem('composer')).toBe('Packagist');
      expect(toOsvEcosystem('rubygems')).toBe('RubyGems');
    });
  });

  describe('queryOSV', () => {
    it('sends the OSV ecosystem name and caches a successful body', async () => {
      const setex = vi.fn().mockResolvedValue('OK');
      const redis = { get: vi.fn().mockResolvedValue(null), setex } as unknown as Redis;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ vulns: [{ id: 'GHSA-1' }] }),
        })
      );

      const result = await queryOSV(redis, 'pypi', 'requests', '2.19.0');

      expect(result.vulns?.[0]?.id).toBe('GHSA-1');
      const fetchMock = vi.mocked(fetch);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        package: { name: 'requests', ecosystem: 'PyPI' },
        version: '2.19.0',
      });
      expect(setex).toHaveBeenCalledWith(
        'osv:vuln:v3:pypi:requests:2.19.0',
        expect.any(Number),
        JSON.stringify({ vulns: [{ id: 'GHSA-1' }] })
      );
    });

    it('does not cache an error response', async () => {
      const setex = vi.fn();
      const redis = { get: vi.fn().mockResolvedValue(null), setex } as unknown as Redis;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({ code: 3, message: 'invalid ecosystem' }),
        })
      );

      await expect(queryOSV(redis, 'cargo', 'tokio', '1.0.0')).rejects.toThrow(/400/);
      expect(setex).not.toHaveBeenCalled();
      const fetchMock = vi.mocked(fetch);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).package.ecosystem).toBe('crates.io');
    });
  });

  describe('queryOSVBatch', () => {
    it('sends one batch query and fetches each vulnerability id once', async () => {
      const redis = {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue('OK'),
        mget: vi.fn(),
      } as unknown as Redis;
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).includes('/querybatch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [{ vulns: [{ id: 'GHSA-1' }] }, { vulns: [{ id: 'GHSA-1' }, { id: 'CVE-2' }] }],
            }),
          };
        }
        const id = String(url).split('/').pop();
        return {
          ok: true,
          status: 200,
          json: async () => ({ id, severity: [{ type: 'CVSS_V3', score: '9.0' }] }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);

      const result = await queryOSVBatch(redis, 'npm', 'lodash', ['1.0.0', '1.0.1']);

      expect(result.get('1.0.0')?.[0]?.severity?.[0]?.score).toBe('9.0');
      expect(result.get('1.0.1')).toHaveLength(2);
      const batchCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/querybatch'));
      const vulnCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/v1/vulns/'));
      expect(batchCalls).toHaveLength(1);
      expect(vulnCalls).toHaveLength(2);
    });
  });

  describe('queryOSVBatch cache', () => {
    it('reads every cached version with one MGET, including legacy keys', async () => {
      const memory = createMemoryRedis();
      await memory.set('osv:vuln:v3:npm:lodash:1.0.0', JSON.stringify({ vulns: [{ id: 'GHSA-new' }] }));
      await memory.set('osv:vuln:npm:lodash:1.0.1', JSON.stringify({ vulns: [{ id: 'GHSA-old' }] }));
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await queryOSVBatch(memory as unknown as Redis, 'npm', 'lodash', ['1.0.0', '1.0.1']);

      expect(result.get('1.0.0')?.[0]?.id).toBe('GHSA-new');
      expect(result.get('1.0.1')?.[0]?.id).toBe('GHSA-old');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(memory.calls.filter((call) => call.startsWith('mget'))).toHaveLength(1);
      expect(memory.calls.filter((call) => call.startsWith('get '))).toHaveLength(0);
    });

    it('caches results for the OSV TTL, but not a list whose severity lookup failed', async () => {
      const memory = createMemoryRedis();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (String(url).includes('/querybatch')) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ results: [{ vulns: [{ id: 'GHSA-ok' }] }, { vulns: [{ id: 'GHSA-broken' }] }] }),
            };
          }
          if (String(url).endsWith('GHSA-broken')) return { ok: false, status: 500, json: async () => ({}) };
          return { ok: true, status: 200, json: async () => ({ id: 'GHSA-ok', severity: [{ type: 'CVSS_V3', score: '7.5' }] }) };
        })
      );

      await queryOSVBatch(memory as unknown as Redis, 'pypi', 'requests', ['1.0.0', '1.0.1']);

      const ttl = await memory.ttl('osv:vuln:v3:pypi:requests:1.0.0');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(config.osv.cacheTtl);
      expect(await memory.get('osv:vuln:v3:pypi:requests:1.0.1')).toBeNull();
    });
  });

  describe('aliases', () => {
    const ghsa: OSVVuln = { id: 'GHSA-jfh8-c2jp-5v3q', aliases: ['CVE-2021-44228'] };

    it('lists the aliases among the ids, so a block list can name the CVE id', () => {
      expect(getVulnIds([ghsa])).toEqual(['GHSA-jfh8-c2jp-5v3q', 'CVE-2021-44228']);
      expect(hasVulnInBlockList(getVulnIds([ghsa]), ['cve-2021-44228'])).toBe(true);
    });

    it('displays the CVE id when there is one, else the advisory id', () => {
      expect(displayVulnId(ghsa)).toBe('CVE-2021-44228');
      expect(displayVulnId({ id: 'GHSA-xxxx-yyyy-zzzz' })).toBe('GHSA-xxxx-yyyy-zzzz');
      expect(displayVulnId({ id: 'GHSA-a', aliases: ['GO-2021-1'] })).toBe('GHSA-a');
    });
  });

  describe('getVulnIds', () => {
    it('extracts vuln IDs from array', () => {
      const vulns: OSVVuln[] = [
        { id: 'GHSA-xxx', summary: 'x' },
        { id: 'CVE-2024-1234', summary: 'y' },
      ];
      expect(getVulnIds(vulns)).toEqual(['GHSA-xxx', 'CVE-2024-1234']);
    });

    it('returns empty array for empty input', () => {
      expect(getVulnIds([])).toEqual([]);
    });

    it('handles undefined vulns', () => {
      expect(getVulnIds(undefined as unknown as OSVVuln[])).toEqual([]);
    });
  });

  describe('hasVulnInBlockList', () => {
    it('returns true when vuln ID is in block list', () => {
      expect(hasVulnInBlockList(['CVE-2024-1234'], ['CVE-2024-1234'])).toBe(true);
    });

    it('returns true for case-insensitive match', () => {
      expect(hasVulnInBlockList(['cve-2024-1234'], ['CVE-2024-1234'])).toBe(true);
    });

    it('returns false when no vuln in block list', () => {
      expect(hasVulnInBlockList(['GHSA-xxx'], ['CVE-2024-1234'])).toBe(false);
    });

    it('returns false for empty block list', () => {
      expect(hasVulnInBlockList(['CVE-2024-1234'], [])).toBe(false);
    });
  });
});
