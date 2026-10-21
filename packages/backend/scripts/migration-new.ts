/**
 * npm run migration:new <snake_case_name>
 *
 * Creates the next numbered, empty migration in packages/backend/migrations/ (requirements_schema_migrations.md D1).
 * Fill it by hand, or from `npm run migration:draft`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatId, MIGRATIONS_DIR, readMigrationFiles } from '../src/db/migrations/files.js';

const name = process.argv[2];
if (!name || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(name)) {
  console.error('Usage: npm run migration:new <snake_case_name>   (lower-case letters, digits and underscores)');
  process.exit(2);
}
const files = readMigrationFiles(MIGRATIONS_DIR);
const next = formatId(files[files.length - 1].id + 1);
const file = path.join(MIGRATIONS_DIR, `${next}_${name}.sql`);
fs.writeFileSync(
  file,
  `-- ${next}_${name}\n` +
    `-- Schema changes and the rows the application needs to work. Plain SQL, one transaction with the rest of the\n` +
    `-- chain: no BEGIN/COMMIT, no CONCURRENTLY, no ALTER TYPE ... ADD VALUE. Never edited once it is on main.\n\n`
);
console.log(`Created ${path.relative(process.cwd(), file)}`);
