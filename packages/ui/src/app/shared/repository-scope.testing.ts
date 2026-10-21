import type { PackageRepositoryRow } from '../services/repository.service';

/** A repository row as the API lists it. */
export function repositoryRow(id: string, ecosystem: string, key: string, type: 'remote' | 'virtual', memberKeys: string[] = []): PackageRepositoryRow {
  return {
    id,
    ecosystem,
    key,
    type,
    upstreamUrl: type === 'remote' ? 'https://example.test' : null,
    priority: 0,
    isEnabled: true,
    isReserved: key === 'default' || key === 'all',
    timeoutMs: 30000,
    retryCount: 3,
    description: null,
    clientPath: `/${ecosystem}/${key}/`,
    memberKeys,
    authConfigured: false,
    authType: null,
    createdAt: '2026-10-12T00:00:00.000Z',
  };
}

/** npm default/prod remotes, the `all` and `frontend` virtuals, and a PyPI default. */
export const REPOSITORY_ROWS = [
  repositoryRow('d', 'npm', 'default', 'remote'),
  repositoryRow('p', 'npm', 'prod', 'remote'),
  repositoryRow('a', 'npm', 'all', 'virtual', ['default', 'prod']),
  repositoryRow('f', 'npm', 'frontend', 'virtual', ['prod']),
  repositoryRow('y', 'pypi', 'default', 'remote'),
];

