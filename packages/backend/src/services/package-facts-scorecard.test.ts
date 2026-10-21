import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { withPlainRoutes } from '../test-support/plain-route.js';

const lookupScorecards = vi.hoisted(() => vi.fn());

vi.mock('./scorecard.js', () => ({ lookupScorecards: (...args: unknown[]) => lookupScorecards(...args) }));
vi.mock('./repository-resolve.js', () => ({ resolveRemoteTargets: vi.fn(async () => []) }));
vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig<object>()));

import { loadVersionFacts } from './package-facts.js';

const db = {} as DataSource;
const need = { license: false, publishedAt: false, cve: false, scorecard: true };

describe('Scorecard facts', () => {
  beforeEach(() => {
    lookupScorecards.mockReset();
  });

  it('passes the seeded npm repository and loads nothing else', async () => {
    lookupScorecards.mockResolvedValue(new Map([['1.0.0', { status: 'unknown', reason: 'no-repository' }]]));
    const seeded = new Map([['1.0.0', { licenseKnown: true, publishedKnown: false, repository: 'github:x/y' }]]);
    const facts = await loadVersionFacts(db, null, 'npm', 'pkg', ['1.0.0'], need, 'default', seeded);
    expect(facts.get('1.0.0')?.scorecard).toEqual({ status: 'unknown', reason: 'no-repository' });
    expect(lookupScorecards.mock.calls[0][5]).toEqual(new Map([['1.0.0', 'github:x/y']]));
  });

  it('a lookup that throws is unavailable, never a block on missing data', async () => {
    lookupScorecards.mockImplementation(async () => {
      throw new Error('Scorecard API down');
    });
    const facts = await loadVersionFacts(db, null, 'pypi', 'pkg', ['1.0'], need, 'default');
    expect(facts.get('1.0')?.scorecard).toEqual({ status: 'unavailable' });
  });

  it('is not loaded unless asked for', async () => {
    await loadVersionFacts(db, null, 'pypi', 'pkg', ['1.0'], { license: false, publishedAt: false, cve: false }, 'default');
    expect(lookupScorecards).not.toHaveBeenCalled();
  });
});
