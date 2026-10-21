import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { adoptRedisGatewayControls } from '../services/gateway-config.js';
import { bindRepoKeyPublisher } from '../services/repo-keys.js';
import { startRepoKeyReplication } from '../services/repo-key-sync.js';
import { bindReferencePublisher, startReferenceReplication } from '../services/reference-cache.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = new Redis(config.redis.url, {
    // ioredis 6 defaults to RESP3, which changes what Lua scripts return (booleans). Every connection stays on RESP2.
    protocol: 2,
    maxRetriesPerRequest: 3,
    // Reconnect forever, at most every 5 s: counts, usage and the reference pub/sub depend on it (R-D16).
    retryStrategy: (times) => Math.min(times * 100, 5000),
  });

  redis.on('error', (err) => fastify.log.warn(err, 'Redis error'));
  redis.on('connect', () => fastify.log.info('Redis connected'));

  try {
    await redis.ping();
  } catch (err) {
    fastify.log.error(err, 'Failed to connect to Redis');
    redis.disconnect();
    throw err;
  }

  fastify.decorate('redis', redis);
  if (fastify.db) await adoptRedisGatewayControls(fastify.db, redis);

  bindRepoKeyPublisher(redis);
  bindReferencePublisher(redis);
  const stopRepoKeySync = fastify.db
    ? startRepoKeyReplication(fastify.db, redis, fastify.log)
    : () => undefined;
  const stopReferenceSync = startReferenceReplication(redis, fastify.log);

  fastify.addHook('onClose', async () => {
    stopRepoKeySync();
    stopReferenceSync();
    bindRepoKeyPublisher(null);
    bindReferencePublisher(null);
    if (redis.status !== 'end') {
      redis.disconnect();
      fastify.log.info('Redis disconnected');
    }
  });
};

export default fp(redisPlugin);
