import { configDefaults, defineConfig } from 'vitest/config';
import { isIntegrationRun, testDatabaseName } from './vitest.env.mjs';

const integration = isIntegrationRun();

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration runs get an empty database migrated to head (requirements_schema_migrations.md D3).
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['src/**/*.test.ts'],
    // Integration suites need PostgreSQL and Redis; without RUN_INTEGRATION they are left out instead of listed as skipped.
    exclude: integration ? configDefaults.exclude : [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    env: {
      NODE_ENV: 'test',
      // The suites connect to the database the global setup prepared, never to the developer's own.
      ...(integration ? { DB_NAME: testDatabaseName() } : {}),
    },
    // Integration suites mutate shared DB/Redis state (policies, gateway flags),
    // so running files in parallel introduces cross-suite races.
    fileParallelism: !integration,
    // Integration hooks can perform substantial DB state setup/restore.
    hookTimeout: integration ? 60000 : 10000,
    testTimeout: integration ? 60000 : 5000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
