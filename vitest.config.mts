import { defineConfig } from 'vitest/config';
import { isIntegrationRun, testDatabaseName } from './packages/backend/vitest.env.mjs';

const integration = isIntegrationRun();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['packages/backend/vitest.setup.ts'],
    // Integration runs get an empty database migrated to head (requirements_schema_migrations.md D3).
    globalSetup: ['packages/backend/vitest.global-setup.ts'],
    include: ['packages/backend/src/**/*.test.ts'],
    exclude: ['**/*.spec.ts', 'e2e/**'],
    env: {
      NODE_ENV: 'test',
      ...(integration ? { DB_NAME: testDatabaseName() } : {}),
    },
    hookTimeout: integration ? 60000 : 10000,
    testTimeout: integration ? 60000 : 5000,
  },
});
