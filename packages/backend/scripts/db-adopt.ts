/**
 * npm run db:adopt [-- --readopt]
 *
 * Development only (requirements_schema_migrations.md P5, P5a). Records the migrations as applied on a
 * database whose schema already matches them, without touching schema or data:
 *
 *   db:adopt             a database made before the runner existed (no schema_migrations table).
 *   db:adopt --readopt   a development database whose schema_migrations rows no longer match the files,
 *                        for example after renumbering (D5). Requires NODE_ENV=development.
 *
 * Both run the drift check first. When the database differs from the entities, the differences are
 * printed and nothing is recorded: reset the database instead.
 */
import 'reflect-metadata';
import { createDataSource } from '../src/db/data-source.js';
import { formatId, readMigrationFiles } from '../src/db/migrations/files.js';
import { describeRawTable, RAW_TABLES, schemaDriftSql } from '../src/db/migrations/drift.js';
import { checkPostgresVersion } from '../src/db/migrations/runner.js';
import { APP_VERSION } from '../src/version.js';

const readopt = process.argv.includes('--readopt');

async function main(): Promise<number> {
  if (readopt && process.env.NODE_ENV !== 'development') {
    console.error('db:adopt --readopt only runs with NODE_ENV=development: it rewrites the migration history.');
    return 2;
  }
  const files = readMigrationFiles();
  const db = createDataSource();
  await db.initialize();
  try {
    await checkPostgresVersion(db);
    const [{ present }]: { present: boolean }[] = await db.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS present`);
    if (present && !readopt) {
      console.error(
        'This database already has a schema_migrations table, so it is already on migrations. ' +
          'If its rows no longer match the files, run `npm run db:adopt -- --readopt` with NODE_ENV=development.'
      );
      return 1;
    }
    if (!present && readopt) {
      console.error('This database has no schema_migrations table; run `npm run db:adopt` without --readopt.');
      return 1;
    }

    const drift = await schemaDriftSql(db);
    const missingRaw: string[] = [];
    for (const table of RAW_TABLES) if (!(await describeRawTable(db, table))) missingRaw.push(table);
    if (drift.length > 0 || missingRaw.length > 0) {
      console.error(`Database ${db.options.database} does not match the migrations:`);
      for (const statement of drift) console.error(`  ${statement};`);
      for (const table of missingRaw) console.error(`  table ${table} is missing`);
      console.error('Nothing was recorded. Reset the database (drop and recreate it) and start DepGate again.');
      return 1;
    }

    const head = files[files.length - 1].id;
    await db.transaction(async (manager) => {
      await manager.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id int PRIMARY KEY,
          name varchar(200) NOT NULL,
          checksum char(64) NOT NULL,
          app_version varchar(32) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          duration_ms int NOT NULL
        )`);
      if (readopt) await manager.query(`DELETE FROM schema_migrations`);
      for (const file of files) {
        await manager.query(
          `INSERT INTO schema_migrations (id, name, checksum, app_version, duration_ms) VALUES ($1, $2, $3, $4, 0)`,
          [file.id, file.name, file.checksum, APP_VERSION]
        );
      }
    });
    console.log(
      `${readopt ? 'Re-adopted' : 'Adopted'} ${db.options.database}: schema matches, recorded ${files.length} migration${files.length === 1 ? '' : 's'} as applied (schema at ${formatId(head)}).`
    );
    return 0;
  } finally {
    await db.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
