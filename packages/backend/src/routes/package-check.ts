import type Redis from 'ioredis';
import { FastifyPluginAsync } from 'fastify';
import { ROLE_SECURITY, ROLE_SERVICE, ROLE_USER } from '../auth/roles.js';
import { config } from '../config.js';
import { ECOSYSTEMS, isEcosystem } from '../services/repo-keys.js';
import { isVersionInput, STORED_VERSION_MAX_LENGTH } from '../services/version-range.js';
import { normalizePackageName, packageNameError } from '../services/package-versions.js';
import { PackageCheckError, runPackageCheck, type PackageCheckResult } from '../services/package-check.js';
import { recordEvent } from '../services/events/record.js';
import { currentActor } from '../services/request-context.js';
import type { PackageCheckOutcome } from '../plugins/metrics.js';

const MAX_VERSIONS = 20;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const REPOSITORY_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;

type CheckBody = {
  ecosystem?: string;
  package?: string;
  repository?: string;
  versions?: unknown;
  offset?: number;
  limit?: number;
  showDev?: boolean;
};

type Validated = {
  ecosystem: string;
  package: string;
  repository: string;
  versions: string[];
  offset: number;
  limit: number;
  composerDev: boolean;
};

function validate(body: CheckBody): Validated | string {
  const ecosystem = String(body.ecosystem ?? '').trim();
  if (!isEcosystem(ecosystem)) return `ecosystem must be one of ${ECOSYSTEMS.join(', ')}`;
  const nameError = packageNameError(ecosystem, String(body.package ?? ''));
  if (nameError) return nameError;
  const repository = String(body.repository ?? 'default').trim() || 'default';
  if (!REPOSITORY_KEY.test(repository)) return `Repository "${repository}" is not a valid repository key`;

  const raw = body.versions ?? [];
  if (!Array.isArray(raw)) return 'versions must be a list';
  const versions = [...new Set(raw.map((item) => String(item ?? '').trim()).filter(Boolean))];
  if (versions.length > MAX_VERSIONS) return `Check up to ${MAX_VERSIONS} versions at a time`;
  for (const version of versions) {
    if (version.length > STORED_VERSION_MAX_LENGTH || !isVersionInput(version, [ecosystem])) {
      return `"${version}" is not a version. Enter a single version such as 1.2.3, 2.0.0-rc.1, or 1.0-SNAPSHOT`;
    }
  }

  const offset = body.offset ?? 0;
  const limit = body.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) return 'offset must be a whole number of 0 or more';
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return `limit must be between 1 and ${MAX_LIMIT}`;

  return {
    ecosystem,
    package: normalizePackageName(ecosystem, String(body.package)),
    repository,
    versions,
    offset,
    limit,
    composerDev: body.showDev === true,
  };
}

/** Fixed one-minute window per caller. Returns seconds to wait, or 0 when the check may run. */
async function rateLimited(
  redis: Pick<Redis, 'multi'> | null,
  caller: string
): Promise<number> {
  const limit = config.packageCheck.rateLimitPerMinute;
  if (limit <= 0 || typeof redis?.multi !== 'function') return 0;
  const now = Date.now();
  const bucket = Math.floor(now / 60_000);
  const key = `pkgcheck:rate:${caller}:${bucket}`;
  try {
    // One MULTI, so a crash between the two can never leave a counter without a TTL.
    const replies = await redis.multi().set(key, '0', 'EX', 60, 'NX').incr(key).exec();
    const count = Number(replies?.[1]?.[1] ?? 0);
    if (count <= limit) return 0;
  } catch {
    return 0;
  }
  return Math.max(1, Math.ceil(((bucket + 1) * 60_000 - now) / 1000));
}

/** What a check found, for its PACKAGE_CHECKED event (R-P5). */
export function checkSummary(result: PackageCheckResult, asked: string[]): Record<string, unknown> {
  const rows = result.versions;
  const served =
    rows.find((row) => row.requested) ??
    rows.find((row) => row.isDefault) ??
    (result.recommended ? rows.find((row) => row.version === result.recommended!.version) : undefined);
  const decision = (status: string | undefined) => (status === 'allowed' ? 'ALLOW' : status === 'blocked' ? 'BLOCK' : status ? 'UNKNOWN' : null);
  return {
    version: served?.version ?? null,
    decision: decision(served?.status),
    ...(served?.policyName ? { policy: served.policyName } : {}),
    ...(served?.reasons?.length ? { reasons: served.reasons } : {}),
    ...(served?.malicious ? { malware: true } : {}),
    allowed: rows.filter((row) => row.status === 'allowed').length,
    blocked: rows.filter((row) => row.status === 'blocked').length,
    unknown: rows.filter((row) => row.status === 'unknown').length,
    totalVersions: result.totalVersions,
    ...(result.recommended ? { recommended: result.recommended.version } : {}),
    ...(asked.length ? { requested: asked } : {}),
  };
}

const packageCheckRoutes: FastifyPluginAsync = async (fastify) => {
  const requireCaller = fastify.authenticate({ roles: [ROLE_USER, ROLE_SECURITY, ROLE_SERVICE] });

  fastify.post<{ Body: CheckBody }>(
    '/api/package-check',
    {
      preHandler: [requireCaller],
      schema: {
        tags: ['Package check'],
        summary: 'Which versions of a package can be used, and why the others are blocked',
        body: {
          type: 'object',
          properties: {
            ecosystem: { type: 'string' },
            package: { type: 'string' },
            repository: { type: 'string' },
            versions: { type: 'array', items: { type: 'string' } },
            offset: { type: 'integer' },
            limit: { type: 'integer' },
            showDev: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const started = process.hrtime.bigint();
      const body = request.body ?? {};
      const ecoLabel = isEcosystem(String(body.ecosystem ?? '')) ? String(body.ecosystem) : 'unknown';
      const record = (outcome: PackageCheckOutcome, timed = false) => {
        const seconds = timed ? Number(process.hrtime.bigint() - started) / 1e9 : undefined;
        fastify.metrics?.recordPackageCheck(ecoLabel, outcome, seconds);
      };

      const user = request.user;
      const caller = user?.sub ?? request.ip;
      const wait = await rateLimited(fastify.redis, caller);
      if (wait > 0) {
        record('rate_limited');
        reply.header('Retry-After', String(wait));
        return reply.status(429).send({ error: `Too many checks. Try again in ${wait} seconds.` });
      }

      const input = validate(body);
      if (typeof input === 'string') {
        record('invalid');
        return reply.status(400).send({ error: input });
      }
      request.log.debug(
        { user: user?.username ?? user?.name ?? caller, ecosystem: input.ecosystem, package: input.package, repository: input.repository },
        'package check'
      );

      // Read before the first await: who asked, from where (R-P5). Every check is recorded, allowed or not.
      const actor = currentActor();
      const audit = (details: Record<string, unknown>) =>
        recordEvent(fastify.db, {
          type: 'PACKAGE_CHECKED',
          actor,
          target: {
            kind: 'package',
            ecosystem: input.ecosystem,
            name: input.package,
            version: input.versions.length ? input.versions.join(', ').slice(0, 128) : null,
            repository: input.repository,
          },
          summary: `Checked ${input.ecosystem} ${input.package}${input.versions.length ? `@${input.versions.join(', ')}` : ''} in ${input.repository}`,
          details,
        });
      try {
        const result = await runPackageCheck(
          fastify.db,
          fastify.redis,
          { ...input, userId: user?.type === 'user' ? user.sub : undefined },
          config.packageCheck.timeoutMs
        );
        record('ok', true);
        audit({ result: checkSummary(result, input.versions) });
        return reply.send(result);
      } catch (err) {
        if (err instanceof PackageCheckError) {
          record(err.status === 404 ? 'not_found' : err.status === 502 ? 'upstream_error' : 'invalid', true);
          audit({ result: { error: err.message, status: err.status } });
          return reply
            .status(err.status)
            .send(err.registry ? { error: err.message, registry: err.registry } : { error: err.message });
        }
        throw err;
      }
    }
  );
};

export default packageCheckRoutes;
