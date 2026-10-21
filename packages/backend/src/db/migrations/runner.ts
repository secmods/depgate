import type { DataSource, QueryRunner } from 'typeorm';
import { APP_VERSION } from '../../version.js';
import { forbiddenStatements, formatId, readMigrationFiles, type MigrationFile } from './files.js';

/**
 * DepGate's migration runner (requirements_schema_migrations.md §3, §4): one forward-only chain of
 * plain SQL files, applied at startup in one transaction under an advisory lock, recorded in
 * `schema_migrations`. If anything fails the transaction rolls back and the database is exactly as it was.
 */

/** Any constant no other startup step uses. */
export const MIGRATION_LOCK_KEY = 74_201_600;
const WAIT_LOG_INTERVAL_MS = 10_000;
const LOCK_TIMEOUT = '60s';

export interface MigrationLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface RunMigrationsOptions {
  /** Where the files are. Default: packages/backend/migrations. */
  dir?: string;
  log?: MigrationLogger;
  /** Recorded in `schema_migrations.app_version`. Default: this build's version. */
  appVersion?: string;
  /** NODE_ENV=development adds the db:adopt hint to the checksum guard (G1). */
  development?: boolean;
  /** Test hook: how often the "waiting for another instance" line is logged. */
  waitLogIntervalMs?: number;
}

export interface RunMigrationsResult {
  /** Migrations this run applied, in order. Empty when the database was up to date. */
  applied: MigrationFile[];
  /** The highest applied number after the run. */
  head: number;
}

export type MigrationErrorKind = 'preflight' | 'guard' | 'locked' | 'failed';

/** Thrown for every refusal. `message` is the whole explanation, ready for the log and the console. */
export class MigrationError extends Error {
  constructor(
    public readonly kind: MigrationErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

interface AppliedRow {
  id: number;
  name: string;
  checksum: string;
  app_version: string;
}

const noopLog: MigrationLogger = { info() {}, warn() {}, error() {} };

/** Minimum PostgreSQL: UNIQUE NULLS NOT DISTINCT needs 15 (S9). */
export async function checkPostgresVersion(db: DataSource): Promise<void> {
  const [{ version }]: { version: string }[] = await db.query(`SELECT current_setting('server_version_num') AS version`);
  if (Number(version) < 150000) {
    throw new MigrationError(
      'preflight',
      `PostgreSQL ${Math.floor(Number(version) / 10000)} is not supported: DepGate needs PostgreSQL 15 or later`
    );
  }
}

/**
 * Brings the database to this build's schema. Call it right after `dataSource.initialize()`, before
 * anything reads a table. Throws MigrationError; the caller logs `message` and exits 1.
 */
export async function runMigrations(db: DataSource, opts: RunMigrationsOptions = {}): Promise<RunMigrationsResult> {
  const log = opts.log ?? noopLog;
  try {
    return await run(db, opts, log);
  } catch (err) {
    const error = err instanceof MigrationError ? err : new MigrationError('failed', `${describeSqlError(err)} ${UNCHANGED}`, err);
    log.error(error.message);
    throw error;
  }
}

async function run(db: DataSource, opts: RunMigrationsOptions, log: MigrationLogger): Promise<RunMigrationsResult> {
  const appVersion = opts.appVersion ?? APP_VERSION;

  // Preflight (outside the transaction): server version, directory (G4), file names, numbering, M5.
  await checkPostgresVersion(db);
  let files: MigrationFile[];
  try {
    files = readMigrationFiles(opts.dir);
  } catch (err) {
    throw new MigrationError('preflight', err instanceof Error ? err.message : String(err), err);
  }
  for (const file of files) {
    const forbidden = forbiddenStatements(file.sql);
    if (forbidden.length > 0) {
      throw new MigrationError(
        'preflight',
        `Migration ${file.name} contains ${forbidden.join(', ')}, which cannot run inside the migration transaction. This DepGate build is broken; do not use it.`
      );
    }
  }
  const byId = new Map(files.map((f) => [f.id, f]));
  const buildHead = files[files.length - 1].id;

  const qr = db.createQueryRunner();
  await qr.connect();
  try {
    await qr.startTransaction();
    // Removing the server's statement timeout first: it would otherwise cut a long wait for the lock or a long migration (S5).
    await qr.query(`SET LOCAL statement_timeout = 0`);
    await takeLock(qr, log, opts.waitLogIntervalMs ?? WAIT_LOG_INTERVAL_MS);
    // Only now (S2, S4): lock_timeout also applies to advisory lock waits, so it must not be set while waiting.
    await qr.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await qr.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id int PRIMARY KEY,
        name varchar(200) NOT NULL,
        checksum char(64) NOT NULL,
        app_version varchar(32) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        duration_ms int NOT NULL
      )`);
    const applied: AppliedRow[] = await qr.query(
      `SELECT id, name, checksum, app_version FROM schema_migrations ORDER BY id`
    );
    const appliedIds = new Set(applied.map((r) => Number(r.id)));
    const dbHead = applied.length ? Math.max(...appliedIds) : 0;

    // G2: the database was upgraded by a newer DepGate.
    const newer = applied.filter((r) => Number(r.id) > buildHead);
    if (newer.length > 0) {
      const last = newer[newer.length - 1];
      throw new MigrationError(
        'guard',
        `The database was upgraded by DepGate ${last.app_version} (schema ${formatId(Number(last.id))}). This is ${appVersion} (schema ${formatId(buildHead)}). Start ${last.app_version} or later.`
      );
    }
    for (const row of applied) {
      const file = byId.get(Number(row.id));
      // G3: an applied migration is missing from this build.
      if (!file) {
        throw new MigrationError(
          'guard',
          `Migration ${row.name} was applied to the database but is missing from this build. This DepGate build is broken; do not use it.`
        );
      }
      // G1: an applied migration's file changed.
      if (file.checksum !== row.checksum.trim()) {
        const hint = opts.development
          ? ' If this is your development database, run `npm run db:adopt -- --readopt` or reset it.'
          : '';
        throw new MigrationError(
          'guard',
          `Migration ${file.name} has changed since it was applied. This DepGate build is broken; do not use it.${hint}`
        );
      }
    }
    const pending = files.filter((f) => !appliedIds.has(f.id));
    // S6: a pending migration below the applied head means branches were merged out of order.
    const outOfOrder = pending.find((f) => f.id < dbHead);
    if (outOfOrder) {
      throw new MigrationError(
        'guard',
        `Migration ${outOfOrder.name} is pending but the database is already at ${formatId(dbHead)}: migrations were merged out of order. This DepGate build is broken; do not use it.`
      );
    }

    if (pending.length === 0) {
      await qr.commitTransaction();
      log.info(`Database schema at ${formatId(dbHead)}, up to date`);
      return { applied: [], head: dbHead };
    }

    const names = pending.map((f) => f.name).join(', ');
    const from = dbHead === 0 ? 'Database is empty' : `Database schema at ${formatId(dbHead)}`;
    log.info(`${from}; applying ${pending.length} migration${pending.length === 1 ? '' : 's'} (${names})`);
    for (const file of pending) {
      const started = Date.now();
      try {
        // One multi-statement query, no parameters (S1).
        await qr.query(file.sql);
      } catch (err) {
        throw failure(file, err, dbHead);
      }
      const durationMs = Date.now() - started;
      await qr.query(
        `INSERT INTO schema_migrations (id, name, checksum, app_version, duration_ms) VALUES ($1, $2, $3, $4, $5)`,
        [file.id, file.name, file.checksum, appVersion, durationMs]
      );
      log.info(`Applied ${file.name} in ${durationMs} ms`);
    }
    await qr.commitTransaction();
    log.info(`Database schema at ${formatId(buildHead)}`);
    return { applied: pending, head: buildHead };
  } catch (err) {
    if (qr.isTransactionActive) {
      try {
        await qr.rollbackTransaction();
      } catch {
        // The connection may already be gone; the server rolled back with it.
      }
    }
    throw err;
  } finally {
    await qr.release();
  }
}

const UNCHANGED = 'The database was not changed. You can start the previous DepGate version again.';

async function takeLock(qr: QueryRunner, log: MigrationLogger, intervalMs: number): Promise<void> {
  // The wait is one blocking query; the log line comes from a timer around it, not from polling (S3).
  const timer = setInterval(
    () => log.warn('Waiting for another DepGate instance to finish upgrading the database'),
    intervalMs
  );
  try {
    await qr.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
  } finally {
    clearInterval(timer);
  }
}

interface PgError {
  code?: string;
  message?: string;
  position?: string;
  detail?: string;
  hint?: string;
}

function driverError(err: unknown): PgError {
  const e = err as { driverError?: PgError } & PgError;
  return e?.driverError ?? e ?? {};
}

/** S8 and S4: which migration, the SQL error with its line, and what to do. */
function failure(file: MigrationFile, err: unknown, dbHead: number): MigrationError {
  const pg = driverError(err);
  const message = pg.message ?? (err instanceof Error ? err.message : String(err));
  if (pg.code === '55P03') {
    return new MigrationError(
      'locked',
      `Migration ${file.name} could not lock a table within ${LOCK_TIMEOUT}. A table is locked by another connection. Stop every DepGate instance running an older version, then start again. ${UNCHANGED}`,
      err
    );
  }
  let where = '';
  if (pg.position) {
    const offset = Number(pg.position);
    if (Number.isFinite(offset) && offset > 0) {
      const line = file.sql.slice(0, offset - 1).split('\n').length;
      where = ` at line ${line} (position ${offset})`;
    }
  }
  let hint = pg.detail ? ` ${pg.detail}` : '';
  if (dbHead === 0 && pg.code === '42P07') {
    hint +=
      ' This database already has tables but no migration history. For a development database made before migrations existed, run `npm run db:adopt` or reset it.';
  }
  return new MigrationError('failed', `Migration ${file.name} failed${where}: ${message}.${hint} ${UNCHANGED}`, err);
}

function describeSqlError(err: unknown): string {
  const pg = driverError(err);
  return `Database upgrade failed: ${pg.message ?? (err instanceof Error ? err.message : String(err))}.`;
}
