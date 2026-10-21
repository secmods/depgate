import { FastifyPluginAsync } from 'fastify';
import { Readable } from 'stream';
import { fetchStreamFromUpstream, sendUpstreamFailure } from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { repoKeyFromRaw } from '../services/repo-keys.js';
import { filterGoVersionList, parseGoProxyPath } from '../services/go-proxy.js';
import { evaluatePackageVersions } from '../services/policy-engine.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  trackDocumentSource,
  trackArtifactSource,
} from './namespace-guard.js';
import { artifactRef, knownRemote } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const goRoutes: FastifyPluginAsync = async (fastify) => {
  const goAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  fastify.get<{ Params: { '*': string } }>(
    '/go/*',
    {
      preHandler: [goAuth],
      schema: {
        tags: ['Go Proxy'],
        params: {
          type: 'object',
          required: ['*'],
          properties: { '*': { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      // GOPROXY protocol: 404 on sumdb/<name>/supported makes the go command
      // contact the checksum database directly instead of failing.
      if (/^\/*sumdb\//.test(rawPath)) {
        return reply.status(404).send({ error: 'Checksum database proxying is not supported' });
      }
      const parsed = parseGoProxyPath(rawPath);
      if (!parsed) {
        return reply.status(400).send({ error: 'Invalid Go proxy path' });
      }
      const modulePath = parsed.modulePath;
      const route = await packageRoute(fastify, request, 'go', modulePath);

      if (parsed.type === 'list') {
        if (route.block) return denyNamespace(fastify, request, reply, route);
        try {
          const repoKey = repoKeyFromRaw(request.raw);
          const cached = await getCachedDocument(fastify.redis, fastify.db, 'go', route.cacheScope, rawPath, async () => {
            const result = await fetchStreamFromUpstream(fastify.db, 'go', rawPath, { route });
            if (result.status !== 200) {
              return { status: result.status, fromUrl: result.fromUrl, bodyText: '' };
            }
            return { status: 200, fromUrl: result.fromUrl, bodyText: await streamToString(result.body) };
          });
          if (cached.status === 404) {
            const missing = await notFoundInternally(fastify, request, reply, route, null, { error: 'Upstream returned error' });
            if (missing) return missing;
          }
          if (cached.status !== 200) {
            return reply.status(cached.status).send({ error: 'Upstream returned error' });
          }

          trackDocumentSource(route, cached.fromUrl);
          const listBody = cached.bodyText;
          const versions = listBody
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);

          const blockedVersions = new Set<string>();
          const decisions = await evaluatePackageVersions(
            fastify.db,
            'go',
            modulePath,
            versions.map((ver) => ({ version: ver })),
            fastify.redis,
            undefined,
            { repoKey, route }
          );
          for (const ver of versions) {
            const policy = decisions.get(ver) ?? null;
            if (policy && policy.decision === 'BLOCK') {
              blockedVersions.add(ver);
            }
          }

          const filtered = filterGoVersionList(listBody, blockedVersions);
          reply.header('Content-Type', 'text/plain; charset=utf-8');
          return reply.status(200).send(filtered);
        } catch (err) {
          return sendUpstreamFailure(reply, err, 'Failed to fetch go list');
        }
      }

      const version = parsed.version;
      // R5: probe for the serving remote only if a scoped policy needs it, and fetch from that remote.
      const fetchOptions = trackArtifactSource(fastify, route, rawPath, `${rawPath.slice(0, rawPath.indexOf('/@v/'))}/@v/list`);
      // .info and .mod are metadata: monitoring policies record only the module zip.
      const policy = await evaluateDownload(fastify, 'go', modulePath, version, {
        repoKey: repoKeyFromRaw(request.raw),
        monitor: parsed.type === 'zip',
        route,
      });
      if (policy && policy.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'go', packageName: modulePath, version }, policy, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'go',
            packageName: modulePath,
            version,
            decision: policy.decision,
            policyId: policy.policyId,
            policyName: policy.policyName,
            reasons: policy.reasons,
          },
        });
        return sendPolicyDenial(reply, policy, {
          check: { ecosystem: 'go', packageName: modulePath, version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      try {
        const options = await fetchOptions();
        const ref = artifactRef('go', modulePath, version, rawPath.replace(/^\/+/, ''), knownRemote(options));
        // One module download is .info, .mod and .zip: only the zip counts as the download.
        const subject = { ecosystem: 'go', packageName: modulePath, version };
        const zip = { artifact: parsed.type === 'zip' };
        const hit = await readCachedArtifact(fastify, ref);
        if (hit) {
          noteArtifactServed(fastify, route, ref!.remote, subject, policy, zip);
          return sendCacheHit(reply, hit);
        }
        const result = await fetchStreamFromUpstream(fastify.db, 'go', rawPath, options);
        if (result.status === 404) {
          const missing = await notFoundInternally(fastify, request, reply, route, version, { error: 'Upstream returned error' });
          if (missing) return missing;
        }
        if (result.status !== 200) {
          return reply.status(result.status).send({ error: 'Upstream returned error' });
        }
        noteArtifactServed(fastify, route, result.source, subject, policy, zip);
        const defaultType =
          parsed.type === 'info'
            ? 'application/json; charset=utf-8'
            : parsed.type === 'mod'
              ? 'text/plain; charset=utf-8'
              : 'application/octet-stream';
        return sendUpstreamArtifact(fastify, reply, 'go', ref, result, defaultType);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to fetch go module');
      }
    }
  );
};

export default goRoutes;
