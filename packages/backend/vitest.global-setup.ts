/**
 * Integration runs (RUN_INTEGRATION=1) start from an empty database brought to head by the migration
 * runner, like a fresh install (requirements_schema_migrations.md D3). The database is `${DB_NAME}_test`
 * (or TEST_DB_NAME): created when the role may create databases, otherwise it must exist, owned by DB_USER.
 * Its public schema is dropped and recreated on every run, so the developer's own database is never touched.
 * vitest.config.mts points the suites at the same name.
 */
import 'reflect-metadata';
import { Client } from 'pg';
import { isIntegrationRun, testDatabaseName } from './vitest.env.mjs';

export default async function globalSetup(): Promise<void> {
  if (!isIntegrationRun()) return;
  const base = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'depgate',
    password: process.env.DB_PASSWORD || 'depgate',
  };
  const testDb = testDatabaseName();

  let client = new Client({ ...base, database: testDb });
  try {
    await client.connect();
  } catch (err) {
    if ((err as { code?: string }).code !== '3D000') throw err;
    const admin = new Client({ ...base, database: process.env.DB_NAME || 'depgate' });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${testDb}"`);
    } catch (createErr) {
      throw new Error(
        `Integration tests need database ${testDb}. It does not exist and ${base.user} may not create it: ` +
          `create it once with a superuser (createdb -O ${base.user} ${testDb}). ${(createErr as Error).message}`
      );
    } finally {
      await admin.end();
    }
    client = new Client({ ...base, database: testDb });
    await client.connect();
  }
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  process.env.DB_NAME = testDb;
  const { createDataSource } = await import('./src/db/data-source.js');
  const { runMigrations } = await import('./src/db/migrations/runner.js');
  const db = createDataSource();
  await db.initialize();
  try {
    const result = await runMigrations(db, { log: console, development: true });
    // The suites expect a clean policy table and create their own; the starter policies a new
    // installation gets (0002_default_policies) would otherwise block the versions they download.
    await db.query('DELETE FROM policies');
    console.log(`Integration tests use database ${testDb}: empty, migrated to ${String(result.head).padStart(4, '0')}, starter policies removed`);
  } finally {
    await db.destroy();
  }
}
