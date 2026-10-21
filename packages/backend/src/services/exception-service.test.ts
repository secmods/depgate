import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataSource } from 'typeorm';
import { hasActiveException } from './exception-service.js';

describe('exception-service', () => {
  let mockDb: DataSource;
  let mockGetMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetMany = vi.fn();
    const chain = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getMany: mockGetMany,
    };
    mockDb = {
      getRepository: vi.fn().mockReturnValue({
        createQueryBuilder: vi.fn().mockReturnValue(chain),
      }),
    } as unknown as DataSource;
  });

  it('returns true when active exception exists (exact version)', async () => {
    mockGetMany.mockResolvedValue([{ id: 'ex-1', version: '4.17.21' }]);

    const result = await hasActiveException(mockDb, 'npm', 'lodash', '4.17.21');
    expect(result).toBe(true);
  });

  it('returns true when active exception exists (wildcard *)', async () => {
    mockGetMany.mockResolvedValue([{ id: 'ex-1', version: '*' }]);

    const result = await hasActiveException(mockDb, 'npm', 'lodash', '4.17.21');
    expect(result).toBe(true);
  });

  it('returns true when active exception exists (version range)', async () => {
    mockGetMany.mockResolvedValue([{ id: 'ex-1', version: '4.17.0 - 4.17.99' }]);

    const result = await hasActiveException(mockDb, 'npm', 'lodash', '4.17.21');
    expect(result).toBe(true);
  });

  it('returns true when a PyPI post-release is inside the range', async () => {
    mockGetMany.mockResolvedValue([{ id: 'ex-1', version: '1.0.0 - 2.0.0' }]);

    const result = await hasActiveException(mockDb, 'pypi', 'requests', '1.0.post1');
    expect(result).toBe(true);
  });

  it('returns false when no exception found', async () => {
    mockGetMany.mockResolvedValue([]);

    const result = await hasActiveException(mockDb, 'npm', 'lodash', '4.17.21');
    expect(result).toBe(false);
  });
});

describe('exception-service repository scope', () => {
  const PROD = '11111111-1111-4111-8111-111111111111';

  it('an exception limited to a repository counts only for requests on it', async () => {
    vi.resetModules();
    vi.doMock('./repository-resolve.js', () => ({
      repositoryIdFor: async (_db: unknown, _eco: string, key: string) => (key === 'prod' ? PROD : 'other-id'),
    }));
    const { findActiveException } = await import('./exception-service.js');
    const chain = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getMany: vi.fn().mockResolvedValue([{ id: 'ex-1', version: '*', repositoryIds: [PROD], expiresAt: new Date() }]),
    };
    const db = { getRepository: () => ({ createQueryBuilder: () => chain }) } as unknown as DataSource;
    expect(await findActiveException(db, 'npm', 'lodash', '1.0.0', 'prod')).not.toBeNull();
    expect(await findActiveException(db, 'npm', 'lodash', '1.0.0', 'sandbox')).toBeNull();
    expect(await findActiveException(db, 'npm', 'lodash', '1.0.0')).toBeNull();
    vi.doUnmock('./repository-resolve.js');
  });
});
