import { describe, expect, it, vi } from 'vitest';
import type { FactNeed, VersionFacts } from './package-facts.js';

/** Returns only the fact types asked for, the way a Redis-less round does. */
const loadVersionFacts = vi.fn(async (_db: unknown, _redis: unknown, _eco: string, _pkg: string, versions: string[], need: FactNeed) => {
  const out = new Map<string, VersionFacts>();
  for (const version of versions) {
    out.set(version, {
      license: need.license ? 'MIT' : undefined,
      vulns: need.cve ? [{ id: 'CVE-2026-0001' }] : [],
      licenseKnown: need.license,
      publishedKnown: need.publishedAt,
      cveKnown: need.cve,
    });
  }
  return out;
});

vi.mock('./package-facts.js', () => ({
  loadVersionFacts: (...args: Parameters<typeof loadVersionFacts>) => loadVersionFacts(...args),
}));

import { evaluatePackageVersion } from './policy-engine.js';

describe('policy rounds', () => {
  it('keeps facts from earlier rounds so a later CVE rule still decides', async () => {
    const qb = { where: () => qb, andWhere: () => qb, getMany: async () => [] };
    const db = {
      getRepository: (entity: { name?: string }) => {
        if (entity?.name === 'Exception') return { createQueryBuilder: () => qb };
        if (entity?.name === 'MaliciousPackage') return { findOne: async () => null };
        return {
          find: async () => [
            { id: 'p-license', name: 'GPL only', decision: 'BLOCK', priority: 0, isEnabled: true, conditions: { licenseDenyList: ['GPL-*'] } },
            { id: 'p-cve', name: 'Known CVE', decision: 'BLOCK', priority: 1, isEnabled: true, conditions: { cveBlockList: ['CVE-2026-0001'] } },
          ],
        };
      },
    };

    const result = await evaluatePackageVersion(db as never, 'pypi', 'acme', '1.0.0', undefined, null);
    expect(result?.policyId).toBe('p-cve');
    expect(loadVersionFacts).toHaveBeenCalledTimes(2);
  });
});
