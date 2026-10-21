import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  acceptsGzip,
  blockedSignature,
  etagMatches,
  getNpmVersionInfo,
  getPackument,
  npmPackumentSource,
  renderPackument,
  repairDistTags,
  restoreBlockedVersions,
  wantsAbbreviatedPackument,
} from '../services/npm-packument.js';
import type { Packument, PackumentOutput } from '../services/npm-packument.js';
import { fetchStreamFromUpstream, sendUpstreamFailure } from '../services/upstream-provider.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, type RepoUrlContext } from '../services/repo-keys.js';
import { filterPackumentVersions } from '../services/policy-engine.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  trackArtifactSource,
  trackKnownSource,
} from './namespace-guard.js';
import type { RemoteTarget } from '../services/repository-resolve.js';
import { artifactRef, knownRemote } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

/**
 * Extract version from tarball filename. Supports standard semver (1.0.0), non-standard
 * (1.0, 1.0.0.0), prerelease (1.0.0-alpha.1), and multi-hyphen names (my-pkg-1.0.0.tgz).
 * Matches the hyphen that precedes a digit (version start) to handle prerelease hyphens.
 */
export function extractVersionFromTarball(tarball: string): string | null {
  const m = tarball.match(/-(\d[\d.+-]*(?:-[a-zA-Z0-9.-]+)?)\.tgz$/);
  return m ? m[1] : null;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(',');
  return value;
}

function deliverPackument(
  reply: FastifyReply,
  req: FastifyRequest,
  output: PackumentOutput,
  abbreviated: boolean,
  wantGzip: boolean
) {
  reply.header('ETag', output.etag);
  reply.header('Vary', 'Accept, Accept-Encoding');
  if (etagMatches(headerValue(req.headers['if-none-match']), output.etag)) {
    return reply.status(304).send();
  }
  const type = abbreviated ? 'application/vnd.npm.install-v1+json' : 'application/json';
  reply.header('Content-Type', type);
  if (wantGzip && output.gzip) {
    reply.header('Content-Encoding', 'gzip');
    return reply.status(200).send(output.gzip);
  }
  return reply.status(200).send(output.json);
}

function repoOf(req: FastifyRequest): RepoUrlContext {
  return {
    key: repoKeyFromRaw(req.raw),
    explicit: repoExplicitFromRaw(req.raw),
    accessToken: accessTokenFromRaw(req.raw),
  };
}

const npmRoutes: FastifyPluginAsync = async (fastify) => {
  const npmAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  const handlePackument = async (pkg: string, req: FastifyRequest, reply: FastifyReply) => {
    try {
      const abbreviated = wantsAbbreviatedPackument(headerValue(req.headers.accept));
      const route = await packageRoute(fastify, req, 'npm', pkg);
      if (route.block) return denyNamespace(fastify, req, reply, route);
      const packed = await getPackument(fastify.db, fastify.redis, pkg, repoOf(req), { abbreviated, route });
      const { status, body } = packed;
      // R5: every version in the packument came from the remote that served it.
      let source: Promise<RemoteTarget | null> | null = null;
      route.servingSource = () => (source ??= npmPackumentSource(fastify.db, fastify.redis, pkg, route));
      if (status === 404) {
        return (await notFoundInternally(fastify, req, reply, route, null)) ?? reply.status(404).send({ error: 'Package not found' });
      }
      const { filtered, blockedVersions } = await filterPackumentVersions(
        fastify.db,
        'npm',
        body,
        fastify.redis,
        { repoKey: repoOf(req).key, route }
      );
      if (Object.keys(blockedVersions).length > 0) {
        fastify.log.debug({ pkg, blocked: Object.keys(blockedVersions) }, 'Policy blocked versions');
      }
      const filteredBody: Packument = restoreBlockedVersions(
        repairDistTags({ ...body, versions: filtered }),
        body,
        blockedVersions
      );
      const tagsSame =
        JSON.stringify(body['dist-tags'] ?? {}) === JSON.stringify(filteredBody['dist-tags'] ?? {});
      const blockedNames = Object.keys(blockedVersions);
      const serveStored =
        blockedNames.length === 0 &&
        tagsSame &&
        Boolean(packed.json && packed.etag && packed.gzip);
      if (status !== 200) {
        return reply.status(status).send(filteredBody);
      }
      if (blockedNames.length > 0) reply.header('Cache-Control', 'no-store');
      const wantGzip = acceptsGzip(headerValue(req.headers['accept-encoding']));
      let output: PackumentOutput;
      if (serveStored) {
        output = { json: packed.json!, etag: packed.etag!, gzip: packed.gzip };
      } else {
        const cacheKey = packed.cacheId ? `${packed.cacheId}|block-fetch|${blockedSignature(blockedNames)}` : undefined;
        output = await renderPackument(filteredBody, { cacheKey, wantGzip });
      }
      return deliverPackument(reply, req, output, abbreviated, wantGzip);
    } catch (err) {
      return sendUpstreamFailure(reply, err, 'Failed to fetch packument');
    }
  };

  const handleTarball = async (
    pkg: string,
    tarball: string,
    req: FastifyRequest,
    reply: FastifyReply
  ) => {
    if (!tarball || !tarball.endsWith('.tgz')) {
      return reply.status(400).send({ error: 'Invalid tarball filename' });
    }
    const version = extractVersionFromTarball(tarball);
    if (!version) {
      return reply.status(400).send({
        error: 'Invalid tarball filename: could not parse version (expected name-version.tgz)',
      });
    }
    try {
      const repo = repoOf(req);
      const route = await packageRoute(fastify, req, 'npm', pkg);
      // A small per-version index row, not the whole packument, which can be megabytes.
      const info = route.block
        ? { status: 403 }
        : await getNpmVersionInfo(fastify.db, fastify.redis, pkg, version, repo, route);
      const versionMeta = info.status === 200 ? info.versionMeta : undefined;
      // R5: the tarball comes from the remote whose packument listed it; without that record, probe.
      const path = `${pkg}/-/${tarball}`;
      const listedBy = route.targets.find((target) => target.id === (info as { sourceId?: string }).sourceId) ?? null;
      const fetchOptions = listedBy
        ? (trackKnownSource(route, listedBy), async () => ({ targets: [listedBy] }))
        : trackArtifactSource(fastify, route, path);
      const policyResult = await evaluateDownload(fastify, 'npm', pkg, version, {
        versionMeta,
        packageLastReleaseAt: info.status === 200 ? info.packageLastReleaseAt : undefined,
        repoKey: repo.key,
        route,
      });
      if (policyResult && policyResult.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'npm', packageName: pkg, version }, policyResult, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'npm',
            packageName: pkg,
            version,
            decision: policyResult.decision,
            policyId: policyResult.policyId,
            policyName: policyResult.policyName,
            reasons: policyResult.reasons,
          },
        });
        return sendPolicyDenial(reply, policyResult, {
          statusMessage: 'Forbidden',
          check: { ecosystem: 'npm', packageName: pkg, version, repository: repoKeyFromRaw(req.raw) },
        });
      }
      const options = await fetchOptions();
      // F3: a version the packument no longer lists is never served from the cache.
      const ref = artifactRef('npm', pkg, version, path, knownRemote(options), info.status === 200 && (info as { listed?: boolean }).listed !== false);
      const subject = { ecosystem: 'npm', packageName: pkg, version };
      const hit = await readCachedArtifact(fastify, ref);
      if (hit) {
        noteArtifactServed(fastify, route, ref!.remote, subject, policyResult);
        return sendCacheHit(reply, hit);
      }
      const { status, headers, body, source } = await fetchStreamFromUpstream(fastify.db, 'npm', path, options);
      if (status === 404) {
        const missing = await notFoundInternally(fastify, req, reply, route, version, { error: 'Upstream returned error' });
        if (missing) return missing;
      }
      if (status !== 200) {
        return reply.status(status).send({ error: 'Upstream returned error' });
      }
      noteArtifactServed(fastify, route, source, subject, policyResult);
      return sendUpstreamArtifact(fastify, reply, 'npm', ref, { body, headers, source });
    } catch (err) {
      return sendUpstreamFailure(reply, err, 'Failed to proxy tarball');
    }
  };

  fastify.get<{ Params: { pkg: string } }>(
    '/npm/:pkg',
    { preHandler: [npmAuth], schema: {
        tags: ['npm Proxy'],
        params: { type: 'object', required: ['pkg'], properties: { pkg: { type: 'string' } } },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'npm packument' },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const pkg = request.params.pkg;
      if (!pkg) return reply.status(400).send({ error: 'Package name required' });
      return handlePackument(pkg, request, reply);
    }
  );

  fastify.get<{ Params: { scope: string; name: string } }>(
    '/npm/@:scope/:name',
    { preHandler: [npmAuth], schema: {
        tags: ['npm Proxy'],
        params: {
          type: 'object',
          required: ['scope', 'name'],
          properties: { scope: { type: 'string' }, name: { type: 'string' } },
        },
        response: {
          200: { type: 'object', additionalProperties: true, description: 'npm packument' },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const { scope, name } = request.params;
      return handlePackument(`@${scope}/${name}`, request, reply);
    }
  );

  // Tarball routes (must be after packument routes; scoped before unscoped for correct matching)
  fastify.get<{ Params: { scope: string; name: string; tarball: string } }>(
    '/npm/@:scope/:name/-/:tarball',
    { preHandler: [npmAuth], schema: {
        tags: ['npm Proxy'],
        params: {
          type: 'object',
          required: ['scope', 'name', 'tarball'],
          properties: { scope: { type: 'string' }, name: { type: 'string' }, tarball: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { scope, name, tarball } = request.params;
      return handleTarball(`@${scope}/${name}`, tarball, request, reply);
    }
  );

  fastify.get<{ Params: { pkg: string; tarball: string } }>(
    '/npm/:pkg/-/:tarball',
    { preHandler: [npmAuth], schema: {
        tags: ['npm Proxy'],
        params: {
          type: 'object',
          required: ['pkg', 'tarball'],
          properties: { pkg: { type: 'string' }, tarball: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { pkg, tarball } = request.params;
      return handleTarball(pkg, tarball, request, reply);
    }
  );
};

export default npmRoutes;
