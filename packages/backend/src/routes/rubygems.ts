import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import {
  fetchFromUpstream,
  fetchStreamFromUpstream,
  sendUpstreamFailure,
  type UpstreamFetchOptions,
} from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, repoPathPrefix } from '../services/repo-keys.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import {
  buildRubygemsDownloadUrl,
  parseGemFileName,
  parseRubygemsClientPath,
  parseRubygemsPath,
  type RubygemsClientPath,
  rewriteRubygemsUrls,
} from '../services/rubygems-proxy.js';
import type { PackageRoute } from '../services/namespace-protection.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  trackArtifactSource,
} from './namespace-guard.js';
import { artifactRef, knownRemote } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

/** The gem a compact-index or gemspec path is about, or null for the global `versions` file. */
function clientPackageName(client: RubygemsClientPath): string | null {
  if (client.type === 'gem') return client.packageName;
  const info = client.path.match(/^info\/([A-Za-z0-9._-]+)$/);
  if (info) return info[1].toLowerCase();
  const spec = client.path.match(/^quick\/Marshal\.4\.8\/([^/]+)\.gemspec\.rz$/);
  return spec ? (parseGemFileName(spec[1])?.packageName ?? null) : null;
}

const rubygemsRoutes: FastifyPluginAsync = async (fastify) => {
  const rubygemsAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  /**
   * The gem and Bundler clients: the compact index (`versions`, `info/<gem>`) and gemspecs pass
   * through unchanged, so blocked versions stay listed; `gems/<file>.gem` is a download.
   */
  async function serveClientPath(
    request: FastifyRequest,
    reply: FastifyReply,
    rawPath: string,
    client: RubygemsClientPath
  ) {
    const route = await packageRoute(fastify, request, 'rubygems', clientPackageName(client));
    if (client.type === 'gem') {
      // R5: probe for the serving remote only if a scoped policy needs it, and fetch from that remote.
      const fetchOptions = trackArtifactSource(
        fastify,
        route,
        client.path,
        `api/v1/versions/${encodeURIComponent(client.packageName)}.json`
      );
      return deliverGem(request, reply, route, client.packageName, client.version, client.path, fetchOptions);
    }
    if (route.block) return denyNamespace(fastify, request, reply, route);
    try {
      const result = await fetchStreamFromUpstream(fastify.db, 'rubygems', client.path, { route });
      if (result.status !== 200) {
        result.body.destroy();
        if (result.status === 404) {
          const missing = await notFoundInternally(fastify, request, reply, route, null, { error: 'Upstream returned error' });
          if (missing) return missing;
        }
        return reply.status(result.status === 404 ? 404 : 502).send({ error: 'Upstream returned error' });
      }
      reply.header('Content-Type', result.headers.get('content-type') ?? 'application/octet-stream');
      const contentLength = result.headers.get('content-length');
      if (contentLength) reply.header('Content-Length', contentLength);
      if (request.method === 'HEAD') {
        result.body.destroy();
        return reply.status(200).send();
      }
      return reply.status(200).send(result.body);
    } catch (err) {
      return sendUpstreamFailure(reply, err, 'Failed to proxy RubyGems index');
    }
  }

  /**
   * Policy and ledger for one .gem download (`gems/<file>.gem`, which the gem and Bundler clients
   * request and the JSON API links to).
   */
  async function deliverGem(
    request: FastifyRequest,
    reply: FastifyReply,
    route: PackageRoute,
    packageName: string,
    version: string,
    path: string,
    fetchOptions: () => Promise<UpstreamFetchOptions>
  ) {

    const policy = await evaluateDownload(fastify, 'rubygems', packageName, version, {
      repoKey: repoKeyFromRaw(request.raw),
      route,
    });
    if (policy && policy.decision === 'BLOCK') {
      recordDownloadBlocked(fastify, { ecosystem: 'rubygems', packageName, version }, policy, {
        webhookPayload: {
          event: 'package_blocked',
          timestamp: new Date().toISOString(),
          ecosystem: 'rubygems',
          packageName,
          version,
          decision: policy.decision,
          policyId: policy.policyId,
          policyName: policy.policyName,
          reasons: policy.reasons,
        },
      });
      return sendPolicyDenial(reply, policy, {
        check: { ecosystem: 'rubygems', packageName, version, repository: repoKeyFromRaw(request.raw) },
      });
    }

    try {
      const options = await fetchOptions();
      const ref = artifactRef('rubygems', packageName, version, path, knownRemote(options));
      const subject = { ecosystem: 'rubygems', packageName, version };
      const hit = await readCachedArtifact(fastify, ref);
      if (hit) {
        noteArtifactServed(fastify, route, ref!.remote, subject, policy);
        return sendCacheHit(reply, hit);
      }
      const upstream = await fetchStreamFromUpstream(fastify.db, 'rubygems', path, options);
      if (upstream.status === 404) {
        const missing = await notFoundInternally(fastify, request, reply, route, version, { error: 'Upstream returned error' });
        if (missing) return missing;
      }
      if (upstream.status !== 200) return reply.status(upstream.status).send({ error: 'Upstream returned error' });
      noteArtifactServed(fastify, route, upstream.source, subject, policy);
      return sendUpstreamArtifact(fastify, reply, 'rubygems', ref, upstream);
    } catch (err) {
      return sendUpstreamFailure(reply, err, 'Failed to proxy RubyGems artifact');
    }
  }

  fastify.get<{ Params: { '*': string } }>(
    '/rubygems/*',
    {
      preHandler: [rubygemsAuth],
      schema: {
        tags: ['RubyGems Proxy'],
        params: { type: 'object', required: ['*'], properties: { '*': { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      const client = parseRubygemsClientPath(rawPath);
      if (client) return serveClientPath(request, reply, rawPath, client);
      const parsed = parseRubygemsPath(rawPath);
      if (!parsed) return reply.status(400).send({ error: 'Invalid RubyGems path' });

      const route = await packageRoute(fastify, request, 'rubygems', parsed.packageName);
      if (route.block) return denyNamespace(fastify, request, reply, route);
      try {
        const cached = await getCachedDocument(fastify.redis, fastify.db, 'rubygems', route.cacheScope, rawPath, async () => {
          const result = await fetchFromUpstream(fastify.db, 'rubygems', rawPath, { route });
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

        if (Array.isArray(body)) {
          body = (body as Array<Record<string, unknown>>).map((row) => {
            if (!row || typeof row !== 'object') return row;
            const pkg =
              typeof row.name === 'string'
                ? row.name.toLowerCase()
                : parsed.packageName;
            const version = typeof row.number === 'string' ? row.number : undefined;
            if (!pkg || !version) return row;
            const gemUri = buildRubygemsDownloadUrl(pkg, version);
            return { ...row, gem_uri: gemUri };
          });
        }

        body = rewriteRubygemsUrls(
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
        return sendUpstreamFailure(reply, err, 'Failed to proxy RubyGems metadata');
      }
    }
  );
};

export default rubygemsRoutes;
