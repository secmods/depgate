import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ROLE_SECURITY } from '../auth/roles.js';
import { CACHE_ECOSYSTEMS } from '../services/artifact-cache/layout.js';
import type { PurgeTarget } from '../services/artifact-cache/store.js';
import {
  listPodStatuses,
  parsePurgeTarget,
  podStatus,
  publishControl,
  publishPurge,
  type PodStatus,
} from '../services/artifact-cache/sync.js';
import { getArtifactCacheSettings, setArtifactCacheSettings } from '../services/gateway-config.js';
import {
  LIMITS_PATCH_SCHEMA,
  applyPatch,
  describeChanges,
  effectiveLimits,
  toValues,
  type LimitField,
} from '../services/artifact-cache/settings.js';
import { environmentLimits } from '../plugins/artifact-cache.js';
import { recordEvent } from '../services/events/record.js';
import { currentActor } from '../services/request-context.js';

const limitValuesSchema = {
  type: 'object',
  properties: {
    maxSizeGb: { type: 'number', nullable: true },
    maxFiles: { type: 'integer' },
    maxAgeDays: { type: 'number' },
    maxIdleDays: { type: 'number' },
    maxFileMb: { type: 'number' },
  },
};

const podSchema = {
  type: 'object',
  properties: {
    pod: { type: 'string' },
    state: { type: 'string', enum: ['ok', 'off', 'error'] },
    enabled: { type: 'boolean' },
    available: { type: 'boolean' },
    lastError: { type: 'string', nullable: true },
    sizeBytes: { type: 'number' },
    maxSizeBytes: { type: 'number' },
    limitedByDisk: { type: 'boolean' },
    files: { type: 'integer' },
    maxFiles: { type: 'integer' },
    hits24h: { type: 'integer' },
    misses24h: { type: 'integer' },
    updatedAt: { type: 'string' },
  },
};

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } };

function targetLabel(target: PurgeTarget): string {
  if ('all' in target) return 'everything';
  return `${target.ecosystem} ${target.packageName}${target.version ? `@${target.version}` : ' (all versions)'}`;
}

const artifactCacheRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });

  fastify.get(
    '/api/artifact-cache/status',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Artifact cache'],
        description: 'The switch, the limits in force (Settings over environment), and the status each live pod reported in the last minute.',
        response: {
          200: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', description: 'Switched on, on the pod that answered: the saved setting, or else ARTIFACT_CACHE_ENABLED' },
              available: { type: 'boolean', description: 'A size per pod is set, so the cache can be switched on' },
              environmentEnabled: { type: 'boolean', description: 'ARTIFACT_CACHE_ENABLED on the pod that answered' },
              setting: { type: 'boolean', nullable: true, description: 'Saved in Settings; null follows ARTIFACT_CACHE_ENABLED' },
              dir: { type: 'string', description: 'ARTIFACT_CACHE_DIR; not changeable in Settings' },
              limits: { ...limitValuesSchema, description: 'In force: saved values over the environment' },
              environmentLimits: { ...limitValuesSchema, description: 'From the ARTIFACT_CACHE_* variables' },
              savedLimits: { ...limitValuesSchema, description: 'Saved in Settings; a missing field follows the environment' },
              pods: { type: 'array', items: podSchema },
              redisAvailable: { type: 'boolean', description: 'False: only the pod that answered is listed' },
            },
          },
        },
      },
    },
    async (_request, reply) => reply.send(await status())
  );

  async function status() {
    const cache = fastify.artifactCache;
    const local = podStatus(cache);
    let pods: PodStatus[] = [local];
    let redisAvailable = true;
    try {
      const listed = await listPodStatuses(fastify.redis);
      pods = [...listed.filter((pod) => pod.pod !== local.pod), local].sort((a, b) => a.pod.localeCompare(b.pod));
    } catch {
      redisAvailable = false;
    }
    const saved = await getArtifactCacheSettings(fastify.db, { verify: true });
    return {
      enabled: cache.enabled,
      available: cache.available,
      environmentEnabled: cache.opts.enabled,
      setting: saved.enabled,
      dir: cache.root,
      limits: toValues(cache.currentLimits),
      environmentLimits: toValues(environmentLimits(cache)),
      savedLimits: saved.limits,
      pods,
      redisAvailable,
    };
  }

  fastify.put<{ Body: { enabled?: boolean | null; limits?: Partial<Record<LimitField, number | null>> } }>(
    '/api/artifact-cache/settings',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Artifact cache'],
        description:
          'Changes the artifact cache on every pod within seconds: `enabled` switches it on or off, `limits` sets ' +
          'maxSizeGb, maxFiles, maxAgeDays, maxIdleDays and maxFileMb. null goes back to the ARTIFACT_CACHE_* variable. ' +
          'Each pod keeps the cache within the free space of its disk. The directory is set by ARTIFACT_CACHE_DIR only.',
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { enabled: { type: 'boolean', nullable: true }, limits: LIMITS_PATCH_SCHEMA },
        },
        response: { 409: errorSchema },
      },
    },
    async (request, reply) => {
      const cache = fastify.artifactCache;
      const body = request.body;
      const saved = await getArtifactCacheSettings(fastify.db, { verify: true });
      const next = {
        enabled: body.enabled !== undefined ? body.enabled : saved.enabled,
        limits: body.limits ? applyPatch(saved.limits, body.limits) : saved.limits,
      };
      const limits = effectiveLimits(environmentLimits(cache), next.limits);
      const wanted = next.enabled ?? cache.opts.enabled;
      if (wanted && !(limits.maxSizeBytes > 0)) {
        return reply.status(409).send({ error: 'Set a size per pod before switching the artifact cache on.' });
      }
      const actor = currentActor();
      const changes = describeChanges(toValues(cache.currentLimits), toValues(limits));
      if (body.enabled !== undefined) {
        changes.unshift(body.enabled === null ? `follows ARTIFACT_CACHE_ENABLED (${wanted ? 'on' : 'off'})` : `switched ${body.enabled ? 'on' : 'off'}`);
      }
      await setArtifactCacheSettings(fastify.db, next);
      await cache.setLimits(limits);
      await cache.setEnabled(wanted);
      recordEvent(fastify.db, {
        type: 'ARTIFACT_CACHE_SETTINGS_UPDATED',
        actor,
        summary: `Artifact cache ${changes.length ? changes.join(', ') : 'settings saved'}`,
        target: { kind: 'setting', name: 'artifact_cache' },
        details: { enabled: next.enabled, limits: next.limits, effective: { enabled: wanted, ...toValues(limits) } },
      });
      // Pods that miss the message pick the change up with their next status report, within 15 s.
      await publishControl(fastify.redis).catch(() => undefined);
      return reply.send(await status());
    }
  );

  fastify.post<{ Body: { all?: boolean; ecosystem?: string; package?: string; version?: string } }>(
    '/api/artifact-cache/purge',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Artifact cache'],
        description:
          'Removes one package (every version, or one) or every file from the artifact cache of every running pod. ' +
          'Send `{ ecosystem, package, version? }` or `{ all: true }`.',
        body: {
          type: 'object',
          properties: {
            all: { type: 'boolean' },
            ecosystem: { type: 'string', enum: [...CACHE_ECOSYSTEMS] },
            package: { type: 'string', minLength: 1, maxLength: 512 },
            version: { type: 'string', maxLength: 256 },
          },
        },
        response: {
          202: {
            type: 'object',
            properties: {
              files: { type: 'integer', description: 'Files removed on the pod that answered' },
              bytes: { type: 'number' },
              pods: { type: 'integer', description: 'Pods that received the purge, including this one' },
            },
          },
          400: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      const target = parsePurgeTarget(request.body);
      if (!target) return reply.status(400).send({ error: 'Send { "ecosystem", "package", "version"? } or { "all": true }' });
      // Read before the first await: the request context is only guaranteed on the calling tick.
      const actor = currentActor();
      const cache = fastify.artifactCache;
      const applied = await cache.purge(target);
      recordEvent(fastify.db, {
        type: 'ARTIFACT_CACHE_PURGED',
        actor,
        summary: `Artifact cache purged: ${targetLabel(target)}`,
        target:
          'all' in target
            ? { kind: 'artifact_cache', name: '*' }
            : { kind: 'artifact_cache', ecosystem: target.ecosystem, name: target.packageName, version: target.version ?? null },
        details: { files: applied.files, bytes: applied.bytes, pod: cache.podName },
      });
      let receivers: number;
      try {
        receivers = await publishPurge(fastify.redis, cache, target);
      } catch {
        return reply.status(503).send({
          error: 'Purged on this pod only. Redis is unavailable, so the other pods did not get the purge; send it again when Redis is back.',
        });
      }
      // Every pod subscribes, this one included; it skips its own message because it already purged.
      return reply.status(202).send({ ...applied, pods: Math.max(receivers, 1) });
    }
  );
};

export default fp(artifactCacheRoutes);
