import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { withPlainRoutes } from '../test-support/plain-route.js';

const queryOSVBatch = vi.hoisted(() => vi.fn());
const lookupEpss = vi.hoisted(() => vi.fn());

vi.mock('./osv-provider.js', async (orig) => ({ ...(await orig<object>()), queryOSVBatch: (...args: unknown[]) => queryOSVBatch(...args) }));
vi.mock('./epss.js', () => ({ lookupEpss: (...args: unknown[]) => lookupEpss(...args) }));
vi.mock('./repository-resolve.js', () => ({ resolveRemoteTargets: vi.fn(async () => []) }));
vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

import { loadVersionFacts } from './package-facts.js';

const db = {} as DataSource;

describe('EPSS facts', () => {
  beforeEach(() => {
    queryOSVBatch.mockReset();
    lookupEpss.mockReset();
  });

  it('looks up every CVE of every version in one query and gives each version its own scores', async () => {
    queryOSVBatch.mockResolvedValue(
      new Map([
        ['1.0.0', [{ id: 'GHSA-a', aliases: ['CVE-2024-0001'] }, { id: 'RUSTSEC-2024-0001' }]],
        ['2.0.0', [{ id: 'GHSA-b', aliases: ['CVE-2024-0002', 'CVE-2024-0001'] }]],
        ['3.0.0', []],
      ])
    );
    lookupEpss.mockResolvedValue({
      scores: new Map([
        ['CVE-2024-0001', { score: 0.4, percentile: 0.97 }],
        ['CVE-2024-0002', { score: 0.01, percentile: 0.5 }],
      ]),
      scoreDate: '2026-10-11',
    });
    const facts = await loadVersionFacts(db, null, 'cargo', 'acme', ['1.0.0', '2.0.0', '3.0.0'], { license: false, publishedAt: false, cve: true, epss: true }, 'default');
    expect(lookupEpss).toHaveBeenCalledTimes(1);
    expect(lookupEpss.mock.calls[0][1]).toEqual(['CVE-2024-0001', 'CVE-2024-0002']);
    expect([...facts.get('1.0.0')!.epss!.keys()]).toEqual(['CVE-2024-0001']);
    expect([...facts.get('2.0.0')!.epss!.keys()].sort()).toEqual(['CVE-2024-0001', 'CVE-2024-0002']);
    expect(facts.get('3.0.0')).toMatchObject({ epssKnown: true, epssDate: '2026-10-11' });
    expect(facts.get('3.0.0')!.epss!.size).toBe(0);
  });

  it('is not looked up unless asked for, and never for a version whose CVE data failed', async () => {
    queryOSVBatch.mockResolvedValue(new Map([['1.0.0', [{ id: 'GHSA-a', aliases: ['CVE-2024-0001'] }]]]));
    await loadVersionFacts(db, null, 'npm', 'acme', ['1.0.0'], { license: false, publishedAt: false, cve: true }, 'default');
    expect(lookupEpss).not.toHaveBeenCalled();
    queryOSVBatch.mockRejectedValue(new Error('OSV down'));
    lookupEpss.mockResolvedValue({ scores: new Map(), scoreDate: null });
    const failed = await loadVersionFacts(db, null, 'npm', 'acme', ['1.0.0'], { license: false, publishedAt: false, cve: true, epss: true }, 'default');
    expect(failed.get('1.0.0')).toMatchObject({ cveUnavailable: true, epssKnown: true });
  });
});
