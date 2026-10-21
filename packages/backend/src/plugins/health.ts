import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { jobsRedis } from '../services/jobs/queue.js';
import { redisEvictionPolicy } from './jobs.js';

export interface HealthPluginOptions {
  skipInfra?: boolean;
}

const healthPlugin: FastifyPluginAsync<HealthPluginOptions> = async (fastify, opts) => {
  const skipInfra = opts?.skipInfra ?? false;

  fastify.get('/healthz', { schema: { tags: ['Health'], security: [] } }, async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  fastify.get('/readyz', { schema: { tags: ['Health'], security: [] } }, async (_request, reply) => {
    if (skipInfra) {
      return reply.status(200).send({ status: 'ready' });
    }

    const db = fastify.db;
    const redis = fastify.redis;
    const errors: string[] = [];

    try {
      if (!db.isInitialized) errors.push('database not initialized');
      else await db.query('SELECT 1');
    } catch (e) {
      errors.push(`database: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    try {
      await redis.ping();
    } catch (e) {
      errors.push(`redis: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    if (errors.length > 0) {
      return reply.status(503).send({ status: 'not ready', errors });
    }

    // Downloads work without the queues, so these only make the answer "degraded".
    const degraded: string[] = [];
    const queueRedis = jobsRedis();
    if (!queueRedis) degraded.push('queues: not running');
    else {
      try {
        await queueRedis.ping();
      } catch (e) {
        degraded.push(`queues: ${e instanceof Error ? e.message : 'unreachable'}`);
      }
    }
    const policy = redisEvictionPolicy();
    if (policy && policy !== 'noeviction') degraded.push(`redis: maxmemory-policy is ${policy}, should be noeviction`);
    return reply.status(200).send({
      status: degraded.length ? 'degraded' : 'ready',
      queues: queueRedis ? 'ok' : 'unavailable',
      evictionPolicy: policy ?? 'unknown',
      ...(degraded.length ? { degraded } : {}),
    });
  });
};

export default fp(healthPlugin);
