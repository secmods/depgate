import { Client } from 'pg';
import { config } from '../config.js';
import { dbSslOptions } from './ssl.js';

/**
 * Session-level advisory lock one instance holds for its whole startup: the legacy rename, the
 * migrations and the startup tasks (requirements_deploy.md §8). Next to MIGRATION_LOCK_KEY (74_201_600);
 * the other keys in use are 74_201_535, 538, 539, 541 and 542.
 */
export const STARTUP_LOCK_KEY = 74_201_601;

export interface StartupLockLogger {
  info(objOrMsg: unknown, msg?: string): void;
}

export interface StartupLock {
  /** True when another instance held the lock and this one waited for it. */
  readonly waited: boolean;
  /** The Postgres backend that holds the lock (pg_backend_pid). Tests terminate it to simulate a crash. */
  readonly pid: number;
  /** Releases the lock and closes the connection. Never throws: a connection the server already closed released the lock with it. */
  release(): Promise<void>;
}

export interface StartupLockOptions {
  /** Test hook: another key, so a test never blocks a real instance on the same database. */
  key?: number;
}

/**
 * Takes the lock on one dedicated connection outside every pool (S2). A session lock belongs to the physical
 * connection that took it, so it is never run through TypeORM: a pooled query could unlock on another connection.
 * The caller holds the result across the main DataSource's initialize() and releases it when startup ends.
 */
export async function acquireStartupLock(log: StartupLockLogger, opts: StartupLockOptions = {}): Promise<StartupLock> {
  const key = opts.key ?? STARTUP_LOCK_KEY;
  if (!Number.isInteger(key)) throw new Error(`Startup lock key must be an integer, got ${String(key)}`);
  const client = new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: dbSslOptions() || undefined,
    application_name: 'depgate-startup-lock',
  });
  // The server closing this connection (pg_terminate_backend, a restart) is reported as an 'error' event.
  // Without a listener Node would treat it as uncaught; here it only means the lock is already gone.
  let gone = false;
  client.on('error', () => {
    gone = true;
  });
  await client.connect();
  try {
    const tried = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${key}) AS locked`);
    let waited = false;
    if (!tried.rows[0]?.locked) {
      waited = true;
      log.info('Waiting for another DepGate instance to finish starting');
      // One blocking query with no timeout of its own (S3): the startup probe or the run script bound it from outside.
      await client.query(`SELECT pg_advisory_lock(${key})`);
    }
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let released = false;
    return {
      waited,
      pid,
      async release() {
        if (released) return;
        released = true;
        if (!gone) {
          try {
            await client.query(`SELECT pg_advisory_unlock(${key})`);
          } catch {
            // The connection went away: the server released the lock when it closed.
          }
        }
        try {
          await client.end();
        } catch {
          // Already closed.
        }
      },
    };
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
}
