import { FastifyPluginAsync } from 'fastify';
import { Readable } from 'stream';
import { config } from '../config.js';
import { discardBody, fetchFromUpstream, fetchUpstreamResponse, sendUpstreamFailure } from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, repoPathPrefix } from '../services/repo-keys.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import {
  canonicalComposerVersion,
  composerDistHref,
  composerRootDocument,
  createComposerArtifactMatcher,
  extractComposerVersions,
  parseComposerPath,
  rewriteComposerDistUrls,
} from '../services/composer-proxy.js';
import { targetForUrl, type PackageRoute } from '../services/namespace-protection.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  servingTarget,
  trackKnownSource,
} from './namespace-guard.js';
import { artifactRef, composerCacheable } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

const composerRoutes: FastifyPluginAsync = async (fastify) => {
  const composerAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  fastify.get<{ Params: { '*': string } }>(
    '/composer/*',
    {
      preHandler: [composerAuth],
      schema: {
        tags: ['Composer Proxy'],
        params: { type: 'object', required: ['*'], properties: { '*': { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      const parsed = parseComposerPath(rawPath);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Composer path' });

      const route = await packageRoute(fastify, request, 'composer', parsed.packageName);
      if (route.block) return denyNamespace(fastify, request, reply, route);
      try {
        const cached = await getCachedDocument(fastify.redis, fastify.db, 'composer', route.cacheScope, rawPath, async () => {
          const result = await fetchFromUpstream(fastify.db, 'composer', rawPath, { route });
          return {
            status: result.status,
            fromUrl: result.fromUrl,
            bodyText: result.status === 200 ? JSON.stringify(result.body ?? {}) : '',
          };
        });
        if (cached.status === 404) {
          return (
            (await notFoundInternally(fastify, request, reply, route, null, { error: 'Metadata not found' })) ??
            reply.status(404).send({ error: 'Metadata not found' })
          );
        }
        if (cached.status !== 200) return reply.status(cached.status).send({ error: 'Upstream returned error' });

        let body = JSON.parse(cached.bodyText) as unknown;
        const pathPrefix = repoPathPrefix({
          key: repoKeyFromRaw(request.raw),
          explicit: repoExplicitFromRaw(request.raw),
          accessToken: accessTokenFromRaw(request.raw),
        });
        if (/^\/*packages\.json$/i.test(rawPath)) body = composerRootDocument(body, pathPrefix);

        const versions = extractComposerVersions(body, parsed.packageName);
        const matchVersion = createComposerArtifactMatcher(versions);
        const gatewayBase = config.gateway.baseUrl.replace(/\/$/, '');
        body = rewriteComposerDistUrls(body, (url) => {
          const row = matchVersion(url);
          // A URL that is no version's archive (a git source, a homepage) points at the gateway and is refused there.
          return row
            ? composerDistHref(gatewayBase, row.packageName, row.version, pathPrefix)
            : `${gatewayBase}/composer/${pathPrefix}dist/unlisted`;
        });

        reply.header('Content-Type', 'application/json; charset=utf-8');
        return reply.status(200).send(body);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to proxy Composer metadata');
      }
    }
  );

  /** A version's upstream archive URL in the package's cached metadata, and the remote that listed it (R5). */
  const findDist = async (route: PackageRoute, packageName: string, version: string) => {
    for (const path of [`p2/${packageName}.json`, `p2/${packageName}~dev.json`, `packages/${packageName}.json`]) {
      const cached = await getCachedDocument(fastify.redis, fastify.db, 'composer', route.cacheScope, path, async () => {
        const result = await fetchFromUpstream(fastify.db, 'composer', path, { route });
        return {
          status: result.status,
          fromUrl: result.fromUrl,
          bodyText: result.status === 200 ? JSON.stringify(result.body ?? {}) : '',
        };
      });
      if (cached.status !== 200) continue;
      const row = extractComposerVersions(JSON.parse(cached.bodyText), packageName).find(
        (item) => item.packageName === packageName && item.version === version
      );
      if (row?.distUrl && /^https?:\/\//i.test(row.distUrl)) {
        return { url: row.distUrl, reference: row.reference, listedBy: targetForUrl(route.targets, cached.fromUrl) };
      }
    }
    return null;
  };

  fastify.get<{ Params: { vendor: string; name: string; version: string } }>(
    '/composer/dist/:vendor/:name/:version',
    {
      preHandler: [composerAuth],
      schema: {
        tags: ['Composer Proxy'],
        params: {
          type: 'object',
          required: ['vendor', 'name', 'version'],
          properties: { vendor: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const packageName = `${request.params.vendor}/${request.params.name}`.toLowerCase();
      const version = canonicalComposerVersion(request.params.version);

      const route = await packageRoute(fastify, request, 'composer', packageName);
      if (route.block) return denyNamespace(fastify, request, reply, route);
      const dist = await findDist(route, packageName, version);
      if (!dist) return reply.status(404).send({ error: 'Version not found in the package metadata' });
      // R5: the archive comes from the remote whose metadata listed it.
      const served = servingTarget(route, dist.listedBy?.id, dist.url);
      trackKnownSource(route, served);
      const policy = await evaluateDownload(fastify, 'composer', packageName, version, {
        repoKey: repoKeyFromRaw(request.raw),
        route,
      });
      if (policy && policy.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'composer', packageName, version }, policy, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'composer',
            packageName,
            version,
            decision: policy.decision,
            policyId: policy.policyId,
            policyName: policy.policyName,
            reasons: policy.reasons,
          },
        });
        return sendPolicyDenial(reply, policy, {
          check: { ecosystem: 'composer', packageName, version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      if (!served && route.reserved) {
        // Listed by a public remote (metadata from before the policy): never fetched for a reserved name.
        const missing = await notFoundInternally(fastify, request, reply, route, version);
        if (missing) return missing;
      }

      const ref = artifactRef(
        'composer',
        packageName,
        version,
        `${packageName}|${version}|${dist.reference ?? ''}`,
        served,
        composerCacheable(version, dist.reference)
      );
      const subject = { ecosystem: 'composer', packageName, version };
      const hit = await readCachedArtifact(fastify, ref);
      if (hit) {
        noteArtifactServed(fastify, route, served, subject, policy);
        return sendCacheHit(reply, hit);
      }

      try {
        const url = new URL(dist.url);
        // The archive host (often codeload.github.com) is not the remote, so its breaker is not involved.
        const upstreamRes = await fetchUpstreamResponse(url.toString(), { timeoutMs: served?.timeoutMs, retryCount: served?.retryCount });
        if (upstreamRes.status !== 200 || !upstreamRes.body) {
          await discardBody(upstreamRes);
          return reply.status(upstreamRes.status === 200 ? 502 : upstreamRes.status).send({ error: 'Upstream returned error' });
        }

        noteArtifactServed(fastify, route, served, subject, policy);
        return sendUpstreamArtifact(fastify, reply, 'composer', ref, {
          body: Readable.fromWeb(upstreamRes.body),
          headers: upstreamRes.headers,
          source: served,
        });
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to proxy Composer artifact');
      }
    }
  );
};

export default composerRoutes;
