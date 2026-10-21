import fp from 'fastify-plugin';
import { DataSource } from 'typeorm';
import { FastifyPluginAsync } from 'fastify';
import { startDatabase } from '../db/startup.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DataSource;
  }
}

/**
 * Connects and brings the database to this build: the legacy rename, the migration runner
 * (requirements_schema_migrations.md §4) and the startup tasks (§6), all under the startup lock so
 * several instances starting together do it one at a time (requirements_deploy.md §8). See db/startup.ts.
 */
const databasePlugin: FastifyPluginAsync = async (fastify) => {
  const dataSource = await startDatabase({ log: fastify.log, development: process.env.NODE_ENV === 'development' });
  fastify.decorate('db', dataSource);

  fastify.addHook('onClose', async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
      fastify.log.info('PostgreSQL disconnected');
    }
  });
};

export default fp(databasePlugin);
