import { DataSource } from 'typeorm';
import { config } from '../config.js';
import { dbSslOptions } from './ssl.js';
import { ReferenceCacheSubscriber } from '../services/reference-cache.js';
import * as entities from './entities/index.js';

/**
 * The schema comes from packages/backend/migrations/ (requirements_schema_migrations.md), never from
 * TypeORM: `synchronize` is off everywhere and the runner in db/migrations/runner.ts applies what is
 * missing at startup. TypeORM is only asked to draft SQL for review (npm run migration:draft).
 */
export function createDataSource(): DataSource {
  const isVitest = process.env.VITEST === 'true';
  return new DataSource({
    type: 'postgres',
    host: config.db.host,
    port: config.db.port,
    username: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: dbSslOptions(),
    extra: { max: config.db.poolSize },
    entities: Object.values(entities),
    subscribers: [ReferenceCacheSubscriber],
    synchronize: false,
    // UUID defaults are gen_random_uuid(), built into PostgreSQL 13+; no extension is installed or needed.
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    logging: isVitest ? false : (process.env.NODE_ENV === 'development' ? ['schema', 'error'] : ['error']),
  });
}
