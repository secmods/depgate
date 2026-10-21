import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { config } from '../config.js';
import {
  buildAuthHeaders,
  discardBody,
  fetchFromUpstream,
  fetchStreamFromUpstream,
  fetchUpstreamResponse,
  parseAuth,
  sendUpstreamFailure,
} from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { upstreamUrl } from '../services/upstream-path.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, repoPathPrefix } from '../services/repo-keys.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import {
  cargoSparseConfig,
  cargoSparseIndexBase,
  parseCargoIndexPath,
  parseCargoPath,
  rewriteCargoUrls,
} from '../services/cargo-proxy.js';
import {
  denyNamespace,
  noteArtifactServed,
  noteServed,
  notFoundInternally,
  packageRoute,
  trackArtifactSource,
} from './namespace-guard.js';
import { artifactRef, knownRemote } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

const cargoRoutes: FastifyPluginAsync = async (fastify) => {
  const cargoAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  /**
   * Sparse index files pass through unchanged, so blocked versions stay listed and their
   * download is refused with the policy reason. Metadata only: nothing is recorded.
   */
  async function proxySparseIndex(request: FastifyRequest, reply: FastifyReply, rawPath: string, crate: string) {
    const route = await packageRoute(fastify, request, 'cargo', crate);
    if (route.block) return denyNamespace(fastify, request, reply, route);
    for (const target of route.targets) {
      try {
        const res = await fetchUpstreamResponse(upstreamUrl(cargoSparseIndexBase(target.url), rawPath), {
          headers: buildAuthHeaders(parseAuth(target)),
          timeoutMs: target.timeoutMs,
          retryCount: target.retryCount,
        });
        if (res.status !== 200 || !res.body) await discardBody(res);
        if (res.status === 404 || res.status === 410) continue;
        if (res.status !== 200 || !res.body) return reply.status(502).send({ error: 'Upstream returned error' });
        noteServed(fastify, route, target, null);
        reply.header('Content-Type', res.headers.get('content-type') ?? 'text/plain; charset=utf-8');
        return reply.status(200).send(Readable.fromWeb(res.body));
      } catch (err) {
        // Only a 404 moves on to the next remote (R1): another remote must not answer for a failed one.
        fastify.log.warn(err, 'Cargo sparse index fetch failed');
        return reply
          .status(502)
          .send({ error: `Upstream cargo/${target.key} is unavailable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    return (
      (await notFoundInternally(fastify, request, reply, route, null, { error: 'Crate not found' })) ??
      reply.status(404).send({ error: 'Crate not found' })
    );
  }

  fastify.get<{ Params: { '*': string } }>(
    '/cargo/*',
    {
      preHandler: [cargoAuth],
      schema: {
        tags: ['Cargo Proxy'],
        params: { type: 'object', required: ['*'], properties: { '*': { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      const sparse = parseCargoIndexPath(rawPath);
      if (sparse) {
        const pathPrefix = repoPathPrefix({
          key: repoKeyFromRaw(request.raw),
          explicit: repoExplicitFromRaw(request.raw),
          accessToken: accessTokenFromRaw(request.raw),
        });
        if (sparse.type === 'config') {
          reply.header('Content-Type', 'application/json; charset=utf-8');
          return reply.status(200).send(cargoSparseConfig(config.gateway.baseUrl, pathPrefix));
        }
        return proxySparseIndex(request, reply, rawPath, sparse.packageName);
      }
      const parsed = parseCargoPath(rawPath);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Cargo path' });

      const route = await packageRoute(fastify, request, 'cargo', parsed.packageName);
      if (parsed.type === 'metadata') {
        if (route.block) return denyNamespace(fastify, request, reply, route);
        try {
          const cached = await getCachedDocument(fastify.redis, fastify.db, 'cargo', route.cacheScope, rawPath, async () => {
            const result = await fetchFromUpstream(fastify.db, 'cargo', rawPath, { route });
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
          body = rewriteCargoUrls(
            body,
            config.gateway.baseUrl.replace(/\/$/, ''),
            repoPathPrefix({
              key: repoKeyFromRaw(request.raw),
              explicit: repoExplicitFromRaw(request.raw),
              accessToken: accessTokenFromRaw(request.raw),
            })
          );
          reply.header('Content-Type', 'application/json; charset=utf-8');
          return reply.status(200).send(body);
        } catch (err) {
          return sendUpstreamFailure(reply, err, 'Failed to proxy Cargo metadata');
        }
      }

      // R5: probe for the serving remote only if a scoped policy needs it, and fetch from that remote.
      const fetchOptions = trackArtifactSource(
        fastify,
        route,
        rawPath,
        `api/v1/crates/${encodeURIComponent(parsed.packageName)}`
      );
      const policy = await evaluateDownload(fastify, 'cargo', parsed.packageName, parsed.version, {
        repoKey: repoKeyFromRaw(request.raw),
        route,
      });
      if (policy && policy.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'cargo', packageName: parsed.packageName, version: parsed.version }, policy, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'cargo',
            packageName: parsed.packageName,
            version: parsed.version,
            decision: policy.decision,
            policyId: policy.policyId,
            policyName: policy.policyName,
            reasons: policy.reasons,
          },
        });
        return sendPolicyDenial(reply, policy, {
          check: { ecosystem: 'cargo', packageName: parsed.packageName, version: parsed.version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      try {
        const options = await fetchOptions();
        const ref = artifactRef('cargo', parsed.packageName, parsed.version, parsed.path, knownRemote(options));
        const subject = { ecosystem: 'cargo', packageName: parsed.packageName, version: parsed.version };
        const hit = await readCachedArtifact(fastify, ref);
        if (hit) {
          noteArtifactServed(fastify, route, ref!.remote, subject, policy);
          return sendCacheHit(reply, hit);
        }
        const artifact = await fetchStreamFromUpstream(fastify.db, 'cargo', rawPath, options);
        if (artifact.status === 404) {
          return (
            (await notFoundInternally(fastify, request, reply, route, parsed.version, { error: 'Artifact not found' })) ??
            reply.status(404).send({ error: 'Artifact not found' })
          );
        }
        if (artifact.status !== 200) return reply.status(artifact.status).send({ error: 'Upstream returned error' });
        noteArtifactServed(fastify, route, artifact.source, subject, policy);
        return sendUpstreamArtifact(fastify, reply, 'cargo', ref, artifact);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to proxy Cargo artifact');
      }
    }
  );
};

export default cargoRoutes;
