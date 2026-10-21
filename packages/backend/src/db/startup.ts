import type { DataSource } from 'typeorm';
import { createDataSource } from './data-source.js';
import { MigrationError, runMigrations } from './migrations/runner.js';
import { seedDefaultRegistries } from './seed-default-registries.js';
import { seedPackageRepositories } from '../services/repository-resolve.js';
import { ensureDefaultAdmin, migrateLegacyRoles, migrateUsernameToEmail } from '../services/auth.js';
import { ensureGatewaySettings } from '../services/gateway-config.js';
import { config } from '../config.js';
import { User } from './entities/User.js';
import { clearSsoPasswords } from '../services/sso-schema.js';
import { ensureUpstreamAuthEncrypted } from '../services/upstream-auth-schema.js';
import { ensurePackageNames } from '../services/package-name-schema.js';
import { readMigrationState } from '../services/events/migration.js';
import { removeAllRepositoryScopes } from '../services/repository-scope.js';
import { auditDetach } from '../services/scope-audit.js';
import { acquireStartupLock, type StartupLock, type StartupLockOptions } from './startup-lock.js';

/** pino-shaped: fastify.log, or a stub in tests. */
export interface StartupLogger {
  info(objOrMsg: unknown, msg?: string): void;
  warn(objOrMsg: unknown, msg?: string): void;
  error(objOrMsg: unknown, msg?: string): void;
}

export interface StartupOptions {
  log: StartupLogger;
  /** NODE_ENV=development: the migration runner adds its db:adopt hint. */
  development?: boolean;
  lock?: StartupLockOptions;
  /** Test hooks. Production passes none. */
  hooks?: {
    /** Runs after the migrations, before the startup tasks, while the lock is held. */
    afterMigrations?(ctx: { lock: StartupLock; db: DataSource }): Promise<void>;
  };
}

/**
 * Everything one instance does to the database before it serves (requirements_deploy.md §8), under the
 * startup lock so instances that start together run it one at a time (S2, S4):
 *
 * 1. the legacy username → email rename, on its own short-lived connection, before the DataSource connects;
 * 2. the schema chain, with the migration runner (requirements_schema_migrations.md §4);
 * 3. the startup tasks and seeds that stay outside the chain (§6), and the first admin on an empty database.
 *
 * Nothing here creates or alters a table: that is the migrations' job. Returns the connected DataSource;
 * on failure nothing stays open. The lock is released whether startup succeeded or failed.
 */
export async function startDatabase(opts: StartupOptions): Promise<DataSource> {
  const { log } = opts;
  let lock: StartupLock;
  try {
    lock = await acquireStartupLock(log, opts.lock);
  } catch (err) {
    log.error(err, 'Failed to connect to PostgreSQL');
    throw err;
  }
  try {
    return await runStartupSequence(opts, lock);
  } finally {
    await lock.release();
  }
}

async function runStartupSequence(opts: StartupOptions, lock: StartupLock): Promise<DataSource> {
  const { log } = opts;
  const dataSource = createDataSource();

  try {
    await migrateUsernameToEmail();
    await dataSource.initialize();
    log.info('PostgreSQL connected');
  } catch (err) {
    log.error(err, 'Failed to connect to PostgreSQL');
    throw err;
  }

  try {
    // First thing after connecting: the runner logs its own lines (S7) and its own failure (S8).
    await runMigrations(dataSource, { log, development: opts.development ?? false });
  } catch (err) {
    if (dataSource.isInitialized) await dataSource.destroy();
    if (err instanceof MigrationError) throw err;
    log.error(err, 'Database upgrade failed');
    throw err;
  }

  try {
    await opts.hooks?.afterMigrations?.({ lock, db: dataSource });
    await runStartupTasks(dataSource, log);
  } catch (err) {
    if (dataSource.isInitialized) await dataSource.destroy();
    log.error(err, 'Database startup tasks failed');
    throw err;
  }

  return dataSource;
}

async function runStartupTasks(dataSource: DataSource, log: StartupLogger): Promise<void> {
  const ssoPasswordsCleared = await clearSsoPasswords(dataSource);
  if (ssoPasswordsCleared > 0) {
    log.warn({ accounts: ssoPasswordsCleared }, 'Removed passwords from accounts that sign in with single sign-on');
  }
  const upstreamAuth = await ensureUpstreamAuthEncrypted(dataSource);
  if (upstreamAuth.encrypted + upstreamAuth.cleared > 0) {
    log.info(upstreamAuth, 'Remote credentials stored as base64 are now encrypted');
  }
  const renamed = await ensurePackageNames(dataSource);
  if (renamed.malicious + renamed.exceptions + renamed.waivers > 0) {
    log.info(renamed, 'Stored package names brought to their canonical spelling');
  }
  await readMigrationState(dataSource);
  await migrateLegacyRoles(dataSource);
  await ensureGatewaySettings(dataSource);
  await seedDefaultRegistries(dataSource);
  await seedPackageRepositories(dataSource);
  // R5: `all` is never a scope. Policies limited only to it are deleted, the rest lose it.
  for (const { label, detached } of await removeAllRepositoryScopes(dataSource)) {
    const note = `Scope can no longer be limited to ${label}`;
    auditDetach(dataSource, { reqIp: null, userAgent: null, requester: 'DepGate' }, label, detached, {
      deleted: `Deleted: it applied only to ${label}, which can no longer be a policy scope`,
      narrowed: `${note}; removed from the policy's repositories`,
      exception: `Deleted: it applied only to ${label}, which can no longer be a scope`,
      waiver: note,
    });
    log.info({ repository: label }, 'Removed the all repository from policy, exception and waiver scopes');
  }
  const userCount = await dataSource.getRepository(User).count();
  if (userCount === 0) {
    await ensureDefaultAdmin(dataSource, config.auth.defaultAdminEmail, config.auth.defaultAdminPassword);
    log.info('Default admin user created');
  }
}
