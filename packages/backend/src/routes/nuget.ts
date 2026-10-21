import { FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { fetchFromUpstream, fetchStreamFromUpstream, sendUpstreamFailure } from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, repoPathPrefix } from '../services/repo-keys.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import { isNugetPackageFile, parseNugetPath, rewriteNugetUrls } from '../services/nuget-proxy.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  trackArtifactSource,
} from './namespace-guard.js';
import { artifactRef, knownRemote, nugetCacheable } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

const nugetRoutes: FastifyPluginAsync = async (fastify) => {
  const nugetAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  fastify.get<{ Params: { '*': string } }>(
    '/nuget/*',
    {
      preHandler: [nugetAuth],
      schema: {
        tags: ['NuGet Proxy'],
        params: { type: 'object', required: ['*'], properties: { '*': { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      const parsed = parseNugetPath(rawPath);
      if (!parsed) return reply.status(400).send({ error: 'Invalid NuGet path' });

      const route = await packageRoute(fastify, request, 'nuget', parsed.packageName);
      if (parsed.type === 'metadata') {
        if (route.block) return denyNamespace(fastify, request, reply, route);
        try {
          const cached = await getCachedDocument(fastify.redis, fastify.db, 'nuget', route.cacheScope, rawPath, async () => {
            const result = await fetchFromUpstream(fastify.db, 'nuget', rawPath, { route });
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

          const gatewayBase = config.gateway.baseUrl.replace(/\/$/, '');
          body = rewriteNugetUrls(
            body,
            gatewayBase,
            repoPathPrefix({
              key: repoKeyFromRaw(request.raw),
              explicit: repoExplicitFromRaw(request.raw),
              accessToken: accessTokenFromRaw(request.raw),
            })
          );
          reply.header('Content-Type', 'application/json; charset=utf-8');
          return reply.status(200).send(body);
        } catch (err) {
          return sendUpstreamFailure(reply, err, 'Failed to proxy NuGet metadata');
        }
      }

      // R5: probe for the serving remote only if a scoped policy needs it, and fetch from that remote.
      const fetchOptions = trackArtifactSource(fastify, route, rawPath, `v3-flatcontainer/${parsed.packageName}/index.json`);
      const policy = await evaluateDownload(fastify, 'nuget', parsed.packageName, parsed.version, {
        repoKey: repoKeyFromRaw(request.raw),
        route,
      });
      if (policy && policy.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'nuget', packageName: parsed.packageName, version: parsed.version }, policy, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'nuget',
            packageName: parsed.packageName,
            version: parsed.version,
            decision: policy.decision,
            policyId: policy.policyId,
            policyName: policy.policyName,
            reasons: policy.reasons,
          },
        });
        return sendPolicyDenial(reply, policy, {
          check: { ecosystem: 'nuget', packageName: parsed.packageName, version: parsed.version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      try {
        const options = await fetchOptions();
        const ref = artifactRef(
          'nuget',
          parsed.packageName,
          parsed.version,
          parsed.path,
          knownRemote(options),
          nugetCacheable(parsed.fileName)
        );
        const subject = { ecosystem: 'nuget', packageName: parsed.packageName, version: parsed.version };
        // A .nuspec is read with its package and counts as a download; only the .nupkg is a namespace monitor hit.
        const counted = { artifact: isNugetPackageFile(parsed.fileName), download: true };
        const hit = await readCachedArtifact(fastify, ref);
        if (hit) {
          noteArtifactServed(fastify, route, ref!.remote, subject, policy, counted);
          return sendCacheHit(reply, hit);
        }
        const artifact = await fetchStreamFromUpstream(fastify.db, 'nuget', rawPath, options);
        if (artifact.status === 404) {
          return (
            (await notFoundInternally(fastify, request, reply, route, parsed.version, { error: 'Artifact not found' })) ??
            reply.status(404).send({ error: 'Artifact not found' })
          );
        }
        if (artifact.status !== 200) return reply.status(artifact.status).send({ error: 'Upstream returned error' });
        noteArtifactServed(fastify, route, artifact.source, subject, policy, counted);
        return sendUpstreamArtifact(fastify, reply, 'nuget', ref, artifact);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to proxy NuGet artifact');
      }
    }
  );
};

export default nugetRoutes;

