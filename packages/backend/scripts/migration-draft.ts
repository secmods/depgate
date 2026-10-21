/**
 * npm run migration:draft
 *
 * Brings the configured database (DB_*) to the current head, then prints the SQL TypeORM would run to
 * bring it in line with the entities (requirements_schema_migrations.md D2). Review it, add data steps,
 * and paste it into the file `npm run migration:new` created. Nothing printed here is applied.
 */
import 'reflect-metadata';
import { createDataSource } from '../src/db/data-source.js';
import { HASH_NAME } from '../src/db/migrations/files.js';
import { schemaDriftSql } from '../src/db/migrations/drift.js';
import { runMigrations } from '../src/db/migrations/runner.js';

async function main(): Promise<number> {
  const db = createDataSource();
  await db.initialize();
  try {
    await runMigrations(db, { log: console, development: true });
    const statements = await schemaDriftSql(db);
    if (statements.length === 0) {
      console.log('-- The entities and the database agree: nothing to migrate.');
      return 0;
    }
    console.log(`-- Draft from TypeORM against ${db.options.database}. Review before use; TypeORM never applies it.`);
    for (const statement of statements) console.log(`${statement};`);
    const hashed = statements.filter((s) => HASH_NAME.test(s));
    if (hashed.length > 0) {
      console.error(
        `\n${hashed.length} statement(s) carry a TypeORM hash name (IDX_/UQ_/PK_/FK_...). An entity is missing an explicit name (M8): name it in the entity and draft again.`
      );
      return 1;
    }
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
