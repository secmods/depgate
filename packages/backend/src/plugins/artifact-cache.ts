import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { ArtifactCache, type ArtifactCacheOptions, type CacheLimits } from '../services/artifact-cache/store.js';
import { startArtifactCacheSync } from '../services/artifact-cache/sync.js';
import { effectiveLimits } from '../services/artifact-cache/settings.js';
import { getArtifactCacheSettings, type ArtifactCacheSettings } from '../services/gateway-config.js';

declare module 'fastify' {
  interface FastifyInstance {
    artifactCache: ArtifactCache;
  }
}

export type ArtifactCachePluginOptions = {
  /** Replaces settings read from the environment: tests run several pods with their own directories. */
  overrides?: Partial<ArtifactCacheOptions>;
};

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY_MS = 86_400_000;

export function artifactCacheOptionsFromConfig(): ArtifactCacheOptions {
  const c = config.artifactCache;
  return {
    enabled: c.enabled,
    dir: c.dir,
    maxSizeBytes: c.maxSizeGb ? Math.floor(c.maxSizeGb * GB) : 0,
    maxFiles: c.maxFiles,
    maxAgeMs: c.maxAgeDays * DAY_MS,
    maxIdleMs: c.maxIdleDays * DAY_MS,
    maxFileBytes: c.maxFileMb * MB,
  };
}

/** The start-up error for a cache switched on without a usable ARTIFACT_CACHE_MAX_SIZE_GB; `raw` is the variable as set. */
export function missingSizeMessage(raw: string): string {
  const problem = raw ? `is "${raw}", which is not a number of gigabytes above 0` : 'is not set';
  return (
    `ARTIFACT_CACHE_ENABLED is true but ARTIFACT_CACHE_MAX_SIZE_GB ${problem}. Set it to the most disk, in GB, ` +
    'the artifact cache may use on each pod (below the size of the volume at ARTIFACT_CACHE_DIR), or set ARTIFACT_CACHE_ENABLED=false.'
  );
}

/** The limits the ARTIFACT_CACHE_* variables give; Settings can override each one. */
export function environmentLimits(cache: ArtifactCache): CacheLimits {
  const { maxSizeBytes, maxFiles, maxAgeMs, maxIdleMs, maxFileBytes } = cache.opts;
  return { maxSizeBytes, maxFiles, maxAgeMs, maxIdleMs, maxFileBytes };
}

const NOTHING_SAVED: ArtifactCacheSettings = { enabled: null, limits: {} };

const artifactCachePlugin: FastifyPluginAsync<ArtifactCachePluginOptions> = async (fastify, opts) => {
  const options: ArtifactCacheOptions = { ...artifactCacheOptionsFromConfig(), log: fastify.log, ...opts.overrides };
  const db = fastify.hasDecorator('db') ? fastify.db : null;
  const readSaved = () => (db ? getArtifactCacheSettings(db, { verify: true }) : Promise.resolve(NOTHING_SAVED));
  const saved = await readSaved().catch(() => NOTHING_SAVED);
  // Switched on by the environment with no size anywhere: refuse to start rather than run without a limit.
  if (options.enabled && saved.enabled === null && !(options.maxSizeBytes > 0) && saved.limits.maxSizeGb == null) {
    throw new Error(missingSizeMessage(opts.overrides?.maxSizeBytes === undefined ? config.artifactCache.maxSizeGbRaw : ''));
  }
  const cache = new ArtifactCache(options);
  // K1: health checks never depend on the cache; an unusable directory only turns it off.
  await cache.start();
  // Settings, when saved, win over the ARTIFACT_CACHE_* variables.
  const apply = async (settings: ArtifactCacheSettings) => {
    await cache.setLimits(effectiveLimits(environmentLimits(cache), settings.limits));
    const wanted = settings.enabled ?? options.enabled;
    if (wanted !== cache.enabled) await cache.setEnabled(wanted);
  };
  const reconcile = async () => {
    if (db) await apply(await readSaved());
  };
  await apply(saved).catch((err: unknown) => fastify.log.warn({ err: String(err) }, 'Artifact cache could not apply its settings'));
  if (cache.isActive()) fastify.log.info({ dir: cache.root, maxSizeBytes: options.maxSizeBytes, maxFiles: options.maxFiles }, 'Artifact cache on');
  fastify.decorate('artifactCache', cache);

  const stopSync = fastify.hasDecorator('redis') ? startArtifactCacheSync(cache, fastify.redis, fastify.log, { reconcile }) : null;
  // K2: when shutdown starts, not after the requests in flight have finished.
  fastify.addHook('preClose', async () => {
    await cache.close();
  });
  fastify.addHook('onClose', async () => {
    await stopSync?.();
  });
};

export default fp(artifactCachePlugin, { name: 'artifact-cache' });
