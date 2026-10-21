import type { PackageRoute } from '../services/namespace-protection.js';
import type { RemoteTarget } from '../services/repository-resolve.js';

const FALLBACK_TARGET: RemoteTarget = {
  id: 'test-remote',
  key: 'default',
  url: 'https://upstream.test',
  timeoutMs: 1000,
  retryCount: 0,
  authType: null,
  authEncrypted: null,
  source: 'public',
};

/**
 * For unit tests that mock the upstream: a route with no namespace policy, whose targets come from
 * the (usually mocked) repository-resolve module, or one public test remote when that cannot be read.
 * Use as `vi.mock('./namespace-protection.js', async (orig) => withPlainRoutes(await orig()))`.
 */
export function withPlainRoutes<T extends object>(actual: T): T {
  return {
    ...actual,
    resolvePackageTargets: async (db: unknown, ecosystem: string, repoKey: string, name: string | null): Promise<PackageRoute> => {
      let targets: RemoteTarget[] = [FALLBACK_TARGET];
      try {
        const { resolveRemoteTargets } = await import('../services/repository-resolve.js');
        targets = await resolveRemoteTargets(db as never, ecosystem, repoKey || 'default');
      } catch {
        /* no database in this test */
      }
      const key = repoKey || 'default';
      return {
        ecosystem,
        repoKey: key,
        packageName: name ?? null,
        targets,
        cacheScope: key,
        reserved: null,
        monitored: [],
        skipped: [],
        block: null,
      };
    },
  };
}
