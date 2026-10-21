import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Migration files (requirements_schema_migrations.md §2): `NNNN_snake_case_name.sql` in
 * packages/backend/migrations/, numbered contiguously from 0001. Pure helpers shared by the runner,
 * the developer scripts and the CI checks; nothing here touches a database.
 */

/** packages/backend/migrations, next to src/ and dist/, copied into the image by the Dockerfile (M6). */
export const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

export const FILE_NAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export interface MigrationFile {
  /** The NNNN number. */
  id: number;
  /** File name without `.sql`, for example `0001_initial`. */
  name: string;
  path: string;
  sql: string;
  /** sha256 of the file with line endings normalised to \n. */
  checksum: string;
}

export class MigrationFilesError extends Error {}

export function formatId(id: number): string {
  return String(id).padStart(4, '0');
}

export function checksumOf(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Reads and validates the directory. Throws (G4) when it is missing or holds no migration, and on a
 * name that does not fit, a duplicate number or a gap: an image built without `migrations/` must not
 * start against an empty database and create nothing.
 */
export function readMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new MigrationFilesError(`Migrations directory ${dir} is missing. This DepGate build is broken; do not use it.`);
  }
  const files: MigrationFile[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const match = FILE_NAME.exec(entry);
    if (!match) {
      throw new MigrationFilesError(
        `${entry} in ${dir} is not a migration: files are named NNNN_snake_case_name.sql and nothing else may live there`
      );
    }
    const sql = fs.readFileSync(path.join(dir, entry), 'utf8');
    files.push({ id: Number(match[1]), name: entry.slice(0, -4), path: path.join(dir, entry), sql, checksum: checksumOf(sql) });
  }
  if (files.length === 0) {
    throw new MigrationFilesError(`Migrations directory ${dir} is empty. This DepGate build is broken; do not use it.`);
  }
  files.sort((a, b) => a.id - b.id);
  files.forEach((file, i) => {
    const expected = i + 1;
    if (file.id !== expected) {
      const why = i > 0 && files[i - 1].id === file.id ? 'is used twice' : `should be ${formatId(expected)}`;
      throw new MigrationFilesError(`Migration number ${formatId(file.id)} (${file.name}) ${why}: numbers are unique and contiguous from 0001`);
    }
  });
  return files;
}

/** Statements Postgres refuses inside a transaction block, or that the chain forbids (M5). */
const FORBIDDEN: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /\bBEGIN\b/i, what: 'BEGIN' },
  { pattern: /\bSTART\s+TRANSACTION\b/i, what: 'START TRANSACTION' },
  { pattern: /\bCOMMIT\b/i, what: 'COMMIT' },
  { pattern: /\bROLLBACK\b/i, what: 'ROLLBACK' },
  { pattern: /\bCONCURRENTLY\b/i, what: 'CREATE/DROP/REINDEX ... CONCURRENTLY' },
  { pattern: /\bVACUUM\b/i, what: 'VACUUM' },
  { pattern: /\bCREATE\s+DATABASE\b/i, what: 'CREATE DATABASE' },
  { pattern: /\bALTER\s+SYSTEM\b/i, what: 'ALTER SYSTEM' },
  { pattern: /\bALTER\s+TYPE\b[\s\S]*?\bADD\s+VALUE\b/i, what: 'ALTER TYPE ... ADD VALUE' },
];

/**
 * Removes comments, string literals and dollar-quoted bodies, so a word inside a comment, a value or a
 * DO block (whose own BEGIN is PL/pgSQL, not a transaction) is not mistaken for a statement.
 */
export function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** The M5 statements a migration contains, by name; empty when it is clean. */
export function forbiddenStatements(sql: string): string[] {
  const code = stripSqlLiterals(sql);
  return FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);
}

/** A name TypeORM generated instead of one the entity declares (M8, P2, D2). */
export const HASH_NAME = /\b(?:IDX|UQ|PK|FK|REL|CHK)_[0-9a-f]{20,}\b/;
