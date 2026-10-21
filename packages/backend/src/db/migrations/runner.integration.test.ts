/**
 * The migration runner against PostgreSQL (requirements_schema_migrations.md C1, C4, C5, C6).
 * Needs PostgreSQL: RUN_INTEGRATION=1 npm run test:integration.
 *
 * Each case runs in its own schema of the integration database (search_path on the connection), so a
 * chain can start from nothing and fail halfway without touching the other suites' tables.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { config } from '../../config.js';
import * as entities from '../entities/index.js';
import { describeRawTable, RAW_TABLES, schemaDriftSql, type RawTableShape } from './drift.js';
import { readMigrationFiles } from './files.js';
import { MIGRATION_LOCK_KEY, MigrationError, runMigrations, type MigrationLogger } from './runner.js';

const SCHEMAS = ['mig_drift', 'mig_fail', 'mig_race', 'mig_g1', 'mig_g2', 'mig_g3', 'mig_g4', 'mig_lock', 'mig_m5'];

function dataSource(schema: string, withEntities = false): DataSource {
  return new DataSource({
    type: 'postgres',
    host: config.db.host,
    port: config.db.port,
    username: config.db.user,
    password: config.db.password,
    database: config.db.database,
    entities: withEntities ? Object.values(entities) : [],
    synchronize: false,
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: false,
    extra: { max: 3, options: `-c search_path=${schema}` },
  });
}

function chain(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgate-chain-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

function collector(): MigrationLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
}

async function tables(db: DataSource, schema: string): Promise<string[]> {
  const rows: { table_name: string }[] = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    [schema]
  );
  return rows.map((r) => r.table_name);
}

async function appliedIds(db: DataSource): Promise<number[]> {
  const rows: { id: number }[] = await db.query(`SELECT id FROM schema_migrations ORDER BY id`);
  return rows.map((r) => Number(r.id));
}

describe.skipIf(!process.env.RUN_INTEGRATION)('migration runner', () => {
  let admin: DataSource;
  const open: DataSource[] = [];

  async function connect(schema: string, withEntities = false): Promise<DataSource> {
    const db = dataSource(schema, withEntities);
    await db.initialize();
    open.push(db);
    return db;
  }

  beforeAll(async () => {
    admin = dataSource('public');
    await admin.initialize();
    for (const schema of SCHEMAS) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    for (const db of open) if (db.isInitialized) await db.destroy();
    for (const schema of SCHEMAS) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.destroy();
  });

  describe('C1 drift: an empty database migrated to head matches the entities', () => {
    it('TypeORM has nothing to change and the raw tables match the expected list', async () => {
      const db = await connect('mig_drift', true);
      const log = collector();
      const first = await runMigrations(db, { log, appVersion: 'test' });
      const files = readMigrationFiles();
      expect(first.applied.map((f) => f.name)).toEqual(files.map((f) => f.name));
      expect(log.lines[0]).toMatch(/^Database is empty; applying \d+ migrations? \(0001_initial/);
      expect(log.lines.at(-1)).toBe(`Database schema at ${String(files.length).padStart(4, '0')}`);

      expect(await schemaDriftSql(db)).toEqual([]);

      const rows: { id: number; name: string; checksum: string; app_version: string }[] = await db.query(
        `SELECT id, name, checksum, app_version FROM schema_migrations ORDER BY id`
      );
      expect(rows.map((r) => [Number(r.id), r.name, r.checksum, r.app_version])).toEqual(
        files.map((f) => [f.id, f.name, f.checksum, 'test'])
      );

      const raw: Record<string, RawTableShape | null> = {};
      for (const table of RAW_TABLES) raw[table] = await describeRawTable(db, table);
      expect(raw).toEqual(EXPECTED_RAW_TABLES);

      const [{ count }]: { count: string }[] = await db.query(`SELECT count(*) FROM event_migration WHERE id = 1`);
      expect(Number(count)).toBe(1);
    });

    it('a second start finds nothing pending and says so (S7)', async () => {
      const db = await connect('mig_drift');
      const log = collector();
      const result = await runMigrations(db, { log });
      expect(result.applied).toEqual([]);
      expect(log.lines).toEqual([`Database schema at ${String(result.head).padStart(4, '0')}, up to date`]);
    });
  });

  describe('C4 failure leaves nothing', () => {
    it('a chain whose last migration fails leaves the earlier state and no new rows', async () => {
      const db = await connect('mig_fail');
      const good = chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);' });
      await runMigrations(db, { dir: good });
      expect(await appliedIds(db)).toEqual([1]);

      const broken = chain({
        '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);',
        '0002_b.sql': 'CREATE TABLE b (id int PRIMARY KEY);\nINSERT INTO b VALUES (1);',
        '0003_c.sql': 'CREATE TABLE c (id int PRIMARY KEY);\nCREATE TABLEX d (id int);',
      });
      const log = collector();
      const err = await runMigrations(db, { dir: broken, log }).catch((e) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.kind).toBe('failed');
      expect(err.message).toMatch(/^Migration 0003_c failed at line 2 \(position 45\): syntax error at or near "TABLEX"\./);
      expect(err.message).toContain('The database was not changed. You can start the previous DepGate version again.');
      expect(log.lines.at(-1)).toBe(err.message);

      expect(await tables(db, 'mig_fail')).toEqual(['a', 'schema_migrations']);
      expect(await appliedIds(db)).toEqual([1]);
    });
  });

  describe('C5 concurrency', () => {
    it('two runners starting together: exactly one applies, both finish', async () => {
      const one = await connect('mig_race');
      const two = await connect('mig_race');
      const dir = chain({ '0001_slow.sql': 'SELECT pg_sleep(0.3);\nCREATE TABLE raced (id int PRIMARY KEY);' });
      const [a, b] = await Promise.all([runMigrations(one, { dir }), runMigrations(two, { dir })]);
      const applied = [a.applied.length, b.applied.length].sort();
      expect(applied).toEqual([0, 1]);
      expect(a.head).toBe(1);
      expect(b.head).toBe(1);
      expect(await appliedIds(one)).toEqual([1]);
    });

    it('logs every interval while another instance holds the lock (S3)', async () => {
      const db = await connect('mig_lock');
      const holder = admin.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      await holder.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
      const log = collector();
      const dir = chain({ '0001_a.sql': 'CREATE TABLE waited (id int PRIMARY KEY);' });
      const run = runMigrations(db, { dir, log, waitLogIntervalMs: 40 });
      await new Promise((r) => setTimeout(r, 150));
      expect(log.lines.filter((l) => l === 'Waiting for another DepGate instance to finish upgrading the database').length).toBeGreaterThanOrEqual(2);
      await holder.commitTransaction();
      await holder.release();
      const result = await run;
      expect(result.applied.map((f) => f.name)).toEqual(['0001_a']);
    });
  });

  describe('C6 guards', () => {
    it('G1: an applied migration whose file changed refuses to start', async () => {
      const db = await connect('mig_g1');
      await runMigrations(db, { dir: chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);' }) });
      const edited = chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY, extra int);' });
      const err = await runMigrations(db, { dir: edited }).catch((e) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.kind).toBe('guard');
      expect(err.message).toBe('Migration 0001_a has changed since it was applied. This DepGate build is broken; do not use it.');
      const dev = await runMigrations(db, { dir: edited, development: true }).catch((e) => e);
      expect(dev.message).toContain('run `npm run db:adopt -- --readopt`');
    });

    it('G2: a database upgraded by a newer DepGate refuses an older build', async () => {
      const db = await connect('mig_g2');
      const newer = chain({
        '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);',
        '0002_b.sql': 'CREATE TABLE b (id int PRIMARY KEY);',
      });
      await runMigrations(db, { dir: newer, appVersion: '2.1.0' });
      const older = chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);' });
      const err = await runMigrations(db, { dir: older, appVersion: '2.0.0' }).catch((e) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.kind).toBe('guard');
      expect(err.message).toBe(
        'The database was upgraded by DepGate 2.1.0 (schema 0002). This is 2.0.0 (schema 0001). Start 2.1.0 or later.'
      );
    });

    it('G3: an applied migration missing from the build refuses to start', async () => {
      const db = await connect('mig_g3');
      await runMigrations(db, {
        dir: chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);', '0002_b.sql': 'CREATE TABLE b (id int PRIMARY KEY);' }),
      });
      // 0002 is gone from the build. The numbering check sees the gap before the guard does; either way it refuses.
      const err = await runMigrations(db, {
        dir: chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);', '0003_c.sql': 'CREATE TABLE c (id int PRIMARY KEY);' }),
      }).catch((e) => e);
      expect(err).toBeInstanceOf(MigrationError);
      expect(err.message).toMatch(/0003 \(0003_c\) should be 0002/);
      expect(await tables(db, 'mig_g3')).toEqual(['a', 'b', 'schema_migrations']);
    });

    it('G4: an empty or missing migrations directory refuses to start', async () => {
      const db = await connect('mig_g4');
      const empty = await runMigrations(db, { dir: chain({}) }).catch((e) => e);
      expect(empty).toBeInstanceOf(MigrationError);
      expect(empty.kind).toBe('preflight');
      expect(empty.message).toMatch(/is empty\. This DepGate build is broken; do not use it\./);
      const missing = await runMigrations(db, { dir: path.join(os.tmpdir(), 'depgate-no-such-dir') }).catch((e) => e);
      expect(missing.message).toMatch(/is missing\. This DepGate build is broken/);
      expect(await tables(db, 'mig_g4')).toEqual([]);
    });

    it('M5: a migration with a forbidden statement is refused before anything runs', async () => {
      const db = await connect('mig_m5');
      const dir = chain({ '0001_a.sql': 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE INDEX CONCURRENTLY idx_a_id ON a (id);' });
      const err = await runMigrations(db, { dir }).catch((e) => e);
      expect(err.kind).toBe('preflight');
      expect(err.message).toContain('Migration 0001_a contains CREATE/DROP/REINDEX ... CONCURRENTLY');
      expect(await tables(db, 'mig_m5')).toEqual([]);
    });
  });
});

/**
 * The five tables TypeORM cannot declare, as 0001_initial creates them. A change to one of them updates
 * the migration and this list together (C1).
 */
const EXPECTED_RAW_TABLES: Record<string, RawTableShape> = {
  decision_counts_hourly: {
    columns: [
      'hour timestamp with time zone not null',
      'ecosystem character varying(32) not null',
      'repository character varying(128)',
      'decision character varying(32) not null',
      'count bigint not null default 0',
    ],
    constraints: ['uq_decision_counts_hourly UNIQUE NULLS NOT DISTINCT (hour, ecosystem, repository, decision)'],
    indexes: [
      'CREATE INDEX idx_decision_counts_hourly_hour ON decision_counts_hourly USING btree (hour)',
      'CREATE UNIQUE INDEX uq_decision_counts_hourly ON decision_counts_hourly USING btree (hour, ecosystem, repository, decision) NULLS NOT DISTINCT',
    ],
  },
  package_counts_hourly: {
    columns: [
      'hour timestamp with time zone not null',
      'ecosystem character varying(32) not null',
      'package_name character varying(512) not null',
      'decision character varying(32) not null',
      'count bigint not null default 0',
    ],
    constraints: ['uq_package_counts_hourly UNIQUE NULLS NOT DISTINCT (hour, ecosystem, package_name, decision)'],
    indexes: [
      'CREATE INDEX idx_package_counts_hourly_hour ON package_counts_hourly USING btree (hour, decision)',
      'CREATE UNIQUE INDEX uq_package_counts_hourly ON package_counts_hourly USING btree (hour, ecosystem, package_name, decision) NULLS NOT DISTINCT',
    ],
  },
  package_usage: {
    columns: [
      'ecosystem character varying(32) not null',
      'package_name character varying(512) not null',
      'version character varying(128) not null',
      'repository character varying(128)',
      'source_repository character varying(256)',
      'source_type character varying(16)',
      'decision character varying(32) not null',
      'first_seen_at timestamp with time zone not null',
      'last_seen_at timestamp with time zone not null',
    ],
    constraints: [
      'uq_package_usage UNIQUE NULLS NOT DISTINCT (ecosystem, package_name, version, repository, source_repository, source_type, decision)',
    ],
    indexes: [
      'CREATE INDEX idx_package_usage_ecosystem ON package_usage USING btree (ecosystem, decision, last_seen_at)',
      'CREATE INDEX idx_package_usage_last_seen ON package_usage USING btree (last_seen_at)',
      'CREATE UNIQUE INDEX uq_package_usage ON package_usage USING btree (ecosystem, package_name, version, repository, source_repository, source_type, decision) NULLS NOT DISTINCT',
    ],
  },
  summary_flushes: {
    columns: ['key character varying(128) not null', 'flushed_at timestamp with time zone not null default now()'],
    constraints: ['pk_summary_flushes PRIMARY KEY (key)'],
    indexes: ['CREATE UNIQUE INDEX pk_summary_flushes ON summary_flushes USING btree (key)'],
  },
  event_migration: {
    columns: [
      'id smallint not null default 1',
      'cursor_created_at timestamp with time zone',
      'cursor_id uuid',
      'started_at timestamp with time zone not null default now()',
      'finished_at timestamp with time zone',
      'copied_ledger bigint not null default 0',
      'copied_audit bigint not null default 0',
      'counted bigint not null default 0',
    ],
    constraints: ['event_migration_single CHECK ((id = 1))', 'pk_event_migration PRIMARY KEY (id)'],
    indexes: ['CREATE UNIQUE INDEX pk_event_migration ON event_migration USING btree (id)'],
  },
};
