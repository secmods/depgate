/**
 * The startup lock (requirements_deploy.md §8, S7 to S9): instances that start together run their
 * startup one at a time, and a holder that dies hands the lock to the next waiter.
 * Needs PostgreSQL and Redis: RUN_INTEGRATION=1 vitest run src/db/startup.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { config } from '../config.js';
import { startDatabase, type StartupLogger } from './startup.js';
import { GatewaySettings, PackageRepository, PackageRepositoryMember, Policy, UpstreamRegistry, User } from './entities/index.js';

const WAITING = 'Waiting for another DepGate instance to finish starting';

function recordingLogger(lines: string[]): StartupLogger {
  const push = (objOrMsg: unknown, msg?: string) => {
    lines.push(typeof objOrMsg === 'string' ? objOrMsg : (msg ?? ''));
  };
  return { info: push, warn: push, error: push };
}

async function counts(db: DataSource): Promise<Record<string, number>> {
  const [migrations] = (await db.query('SELECT count(*)::int AS n FROM schema_migrations')) as Array<{ n: number }>;
  return {
    users: await db.getRepository(User).count(),
    settings: await db.getRepository(GatewaySettings).count(),
    registries: await db.getRepository(UpstreamRegistry).count(),
    repositories: await db.getRepository(PackageRepository).count(),
    members: await db.getRepository(PackageRepositoryMember).count(),
    policies: await db.getRepository(Policy).count(),
    migrations: migrations.n,
  };
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Startup lock', () => {
  let admin: Client;
  const open: DataSource[] = [];

  beforeAll(async () => {
    admin = new Client({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    });
    await admin.connect();
    // S7 wants an empty database: the global setup migrated this one, so start it over.
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => (db.isInitialized ? db.destroy() : Promise.resolve())));
  });

  afterAll(async () => {
    // Back to what the other suites expect from the global setup: migrated, no starter policies.
    await admin.query('DELETE FROM policies').catch(() => undefined);
    await admin.end();
  });

  it('S7: four instances starting on an empty database all succeed and write everything once', async () => {
    const lines: string[] = [];
    const log = recordingLogger(lines);
    const started = await Promise.all([1, 2, 3, 4].map(() => startDatabase({ log })));
    open.push(...started);
    expect(started).toHaveLength(4);
    for (const db of started) expect(db.isInitialized).toBe(true);

    const db = started[0];
    const after = await counts(db);
    expect(after.users).toBe(1);
    expect(after.settings).toBe(1);
    expect(after.migrations).toBeGreaterThan(0);

    // The default registries once each, and one `default` repository per ecosystem.
    const registries = await db.getRepository(UpstreamRegistry).find();
    const registryKeys = registries.map((r) => `${r.ecosystem} ${r.url}`);
    expect(new Set(registryKeys).size).toBe(registryKeys.length);
    expect(registries.length).toBe(8);
    const defaults = await db.getRepository(PackageRepository).find({ where: { key: 'default' } });
    const defaultEcosystems = defaults.map((r) => r.ecosystem);
    expect(new Set(defaultEcosystems).size).toBe(defaultEcosystems.length);

    // Only one instance did the work; the others waited for it and found it done.
    expect(lines.filter((l) => l === 'Default admin user created')).toHaveLength(1);
    expect(lines.filter((l) => l === WAITING).length).toBeGreaterThanOrEqual(1);
  });

  it('S8: four instances starting on a current database write nothing', async () => {
    const probe = await startDatabase({ log: recordingLogger([]) });
    open.push(probe);
    const before = await counts(probe);

    const lines: string[] = [];
    const started = await Promise.all([1, 2, 3, 4].map(() => startDatabase({ log: recordingLogger(lines) })));
    open.push(...started);

    expect(await counts(probe)).toEqual(before);
    expect(lines).not.toContain('Default admin user created');
  });

  it('S9: when the holder dies inside its startup tasks, the next waiter gets the lock and completes', async () => {
    const holderLines: string[] = [];
    const waiterLines: string[] = [];
    let waiter: Promise<DataSource> | undefined;

    const holder = startDatabase({
      log: recordingLogger(holderLines),
      hooks: {
        async afterMigrations({ lock }) {
          // A second instance starts while this one holds the lock, and blocks on it.
          waiter = startDatabase({ log: recordingLogger(waiterLines) });
          await new Promise((r) => setTimeout(r, 750));
          expect(waiterLines).toContain(WAITING);
          // The process dies: Postgres closes its lock connection and releases the lock with it.
          await admin.query('SELECT pg_terminate_backend($1)', [lock.pid]);
          throw new Error('simulated crash');
        },
      },
    });

    await expect(holder).rejects.toThrow('simulated crash');
    expect(holderLines).toContain('Database startup tasks failed');
    expect(holderLines).not.toContain('Database upgrade failed');

    const db = await waiter!;
    open.push(db);
    expect(db.isInitialized).toBe(true);
    expect((await counts(db)).users).toBe(1);
  });
});
