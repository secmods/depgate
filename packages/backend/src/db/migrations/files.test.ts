/**
 * Migration files and the CI history rules (requirements_schema_migrations.md M1, M5, M8, C2): numbering,
 * checksums, forbidden statements, and that every entity names its indexes and constraints.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  forbiddenStatements,
  formatId,
  HASH_NAME,
  MIGRATIONS_DIR,
  MigrationFilesError,
  readMigrationFiles,
  stripSqlLiterals,
} from './files.js';

function tempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgate-migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

describe('migration files', () => {
  it('reads the shipped chain: contiguous from 0001, named NNNN_snake_case', () => {
    const files = readMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    files.forEach((file, i) => {
      expect(file.id).toBe(i + 1);
      expect(file.name).toMatch(/^\d{4}_[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(file.name.startsWith(formatId(file.id))).toBe(true);
      expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(files[0].name).toBe('0001_initial');
  });

  it('the shipped chain has no forbidden statements and no TypeORM hash names (C2, P2)', () => {
    for (const file of readMigrationFiles()) {
      expect(forbiddenStatements(file.sql), file.name).toEqual([]);
      expect(HASH_NAME.test(file.sql), `${file.name} carries a hash name`).toBe(false);
    }
  });

  it('nothing but migrations lives in the directory (M6)', () => {
    for (const entry of fs.readdirSync(MIGRATIONS_DIR)) expect(entry).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it('checksums ignore Windows line endings', () => {
    expect(checksumOf('CREATE TABLE a (id int);\r\nCREATE TABLE b (id int);\r\n')).toBe(
      checksumOf('CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n')
    );
    expect(checksumOf('a')).not.toBe(checksumOf('b'));
  });

  it('refuses a missing or empty directory (G4)', () => {
    expect(() => readMigrationFiles(path.join(os.tmpdir(), 'depgate-does-not-exist'))).toThrow(MigrationFilesError);
    expect(() => readMigrationFiles(tempDir({}))).toThrow(/empty/);
  });

  it('refuses gaps, duplicates and stray files (M1)', () => {
    expect(() => readMigrationFiles(tempDir({ '0001_a.sql': '', '0003_c.sql': '' }))).toThrow(/0003 \(0003_c\) should be 0002/);
    expect(() => readMigrationFiles(tempDir({ '0002_b.sql': '' }))).toThrow(/should be 0001/);
    expect(() => readMigrationFiles(tempDir({ '0001_a.sql': '', '0001_b.sql': '' }))).toThrow(/used twice/);
    expect(() => readMigrationFiles(tempDir({ '0001_a.sql': '', 'notes.txt': '' }))).toThrow(/not a migration/);
    expect(() => readMigrationFiles(tempDir({ '0001_Bad-Name.sql': '' }))).toThrow(/not a migration/);
    expect(readMigrationFiles(tempDir({ '0001_a.sql': 'x', '0002_b_c.sql': 'y' })).map((f) => f.name)).toEqual(['0001_a', '0002_b_c']);
  });

  it('spots the statements M5 forbids', () => {
    expect(forbiddenStatements('BEGIN; CREATE TABLE a (id int); COMMIT;')).toEqual(['BEGIN', 'COMMIT']);
    expect(forbiddenStatements('create index concurrently idx_a on a (id)')).toEqual(['CREATE/DROP/REINDEX ... CONCURRENTLY']);
    expect(forbiddenStatements('VACUUM a')).toEqual(['VACUUM']);
    expect(forbiddenStatements('CREATE DATABASE other')).toEqual(['CREATE DATABASE']);
    expect(forbiddenStatements("ALTER SYSTEM SET work_mem = '1GB'")).toEqual(['ALTER SYSTEM']);
    expect(forbiddenStatements("ALTER TYPE mood ADD VALUE 'ok'")).toEqual(['ALTER TYPE ... ADD VALUE']);
    expect(forbiddenStatements('ROLLBACK')).toEqual(['ROLLBACK']);
    expect(forbiddenStatements('START TRANSACTION')).toEqual(['START TRANSACTION']);
  });

  it('ignores words inside comments, strings and DO blocks', () => {
    const sql = `
      -- BEGIN is fine in a comment, and so is COMMIT
      /* VACUUM in a block comment */
      INSERT INTO notes (text) VALUES ('BEGIN; COMMIT; it''s a value');
      DO $$ BEGIN IF to_regclass('users') IS NOT NULL THEN ALTER TABLE users ADD COLUMN x int; END IF; END $$;
      DO $body$ BEGIN PERFORM 1; END $body$;
      CREATE INDEX idx_a_b ON a (b);
    `;
    expect(forbiddenStatements(sql)).toEqual([]);
    expect(stripSqlLiterals(sql)).not.toMatch(/BEGIN|VACUUM|COMMIT/);
  });
});

describe('entities name every index, unique, primary key and foreign key (M8, C2)', () => {
  const entitiesDir = path.resolve(__dirname, '../entities');
  const sources = fs
    .readdirSync(entitiesDir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(entitiesDir, f), 'utf8') }));

  it('covers the entity folder', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('@Index and @Unique start with an idx_ or uq_ name', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const match of text.matchAll(/@(Index|Unique)\(([^)]*)\)/g)) {
        const [decorator, kind, args] = match;
        const name = /^\s*'([a-z0-9_]+)'/.exec(args)?.[1];
        const unique = kind === 'Unique' || /unique:\s*true/.test(args);
        const ok = name && (unique ? name.startsWith('uq_') : name.startsWith('idx_'));
        if (!ok) offenders.push(`${file}: ${decorator}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('primary keys carry primaryKeyConstraintName pk_<table>', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      const table = /@Entity\('([a-z_]+)'\)/.exec(text)?.[1];
      for (const match of text.matchAll(/@Primary(?:Generated)?Column\(([^)]*)\)/g)) {
        if (!match[1].includes(`primaryKeyConstraintName: 'pk_${table}'`)) offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every relation has a @JoinColumn with foreignKeyConstraintName fk_<table>_<col>', () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      const table = /@Entity\('([a-z_]+)'\)/.exec(text)?.[1];
      const relations = text.match(/@(ManyToOne|OneToOne|OneToMany|ManyToMany)\(/g) ?? [];
      const joins = [...text.matchAll(/@JoinColumn\(([^)]*)\)/g)];
      if (relations.length !== joins.length) offenders.push(`${file}: ${relations.length} relations, ${joins.length} @JoinColumn`);
      for (const join of joins) {
        const column = /name:\s*'([a-z_]+)'/.exec(join[1])?.[1];
        if (!join[1].includes(`foreignKeyConstraintName: 'fk_${table}_${column}'`)) offenders.push(`${file}: ${join[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('constraint names are unique across entities and fit in 63 characters', () => {
    const names = sources.flatMap(({ text }) => [...text.matchAll(/'((?:pk|uq|idx|fk)_[a-z0-9_]+)'/g)].map((m) => m[1]));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(63);
  });
});
