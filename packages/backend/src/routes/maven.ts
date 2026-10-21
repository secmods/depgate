import { FastifyPluginAsync } from 'fastify';
import { Readable } from 'stream';
import { fetchStreamFromUpstream, sendUpstreamFailure } from '../services/upstream-provider.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { repoKeyFromRaw } from '../services/repo-keys.js';
import {
  extractMavenMetadataVersions,
  filterMavenMetadataXml,
  isMavenPrimaryArtifact,
  parseMavenPath,
} from '../services/maven-proxy.js';
import { evaluatePackageVersions } from '../services/policy-engine.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { recordDownloadBlocked } from '../services/events/download-events.js';
import { sendPolicyDenial } from '../services/policy-notice.js';
import type { PackageRoute } from '../services/namespace-protection.js';
import {
  denyNamespace,
  noteArtifactServed,
  notFoundInternally,
  packageRoute,
  trackDocumentSource,
  trackArtifactSource,
} from './namespace-guard.js';
import { artifactRef, knownRemote, mavenCacheable } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

const mavenRoutes: FastifyPluginAsync = async (fastify) => {
  const mavenAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  const handlePolicyDecision = async (
    packageName: string,
    version: string,
    fileName: string,
    repoKey: string,
    route: PackageRoute
  ) => {
    const policy = await evaluateDownload(fastify, 'maven', packageName, version, {
      repoKey,
      monitor: isMavenPrimaryArtifact(fileName),
      route,
    });
    if (!policy || policy.decision !== 'BLOCK') {
      return policy;
    }
    recordDownloadBlocked(fastify, { ecosystem: 'maven', packageName, version }, policy, {
      webhookPayload: {
        event: 'package_blocked',
        timestamp: new Date().toISOString(),
        ecosystem: 'maven',
        packageName,
        version,
        decision: policy.decision,
        policyId: policy.policyId,
        policyName: policy.policyName,
        reasons: policy.reasons,
      },
    });
    return policy;
  };

  fastify.get<{ Params: { '*': string } }>(
    '/maven/*',
    {
      preHandler: [mavenAuth],
      schema: {
        tags: ['Maven Proxy'],
        params: { type: 'object', required: ['*'], properties: { '*': { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const rawPath = request.params['*'];
      const parsed = parseMavenPath(rawPath);
      if (!parsed) return reply.status(400).send({ error: 'Invalid Maven path' });
      const route = await packageRoute(fastify, request, 'maven', parsed.packageName);

      if (parsed.type === 'metadata') {
        if (route.block) return denyNamespace(fastify, request, reply, route);
        try {
          const repoKey = repoKeyFromRaw(request.raw);
          const cached = await getCachedDocument(fastify.redis, fastify.db, 'maven', route.cacheScope, rawPath, async () => {
            const result = await fetchStreamFromUpstream(fastify.db, 'maven', rawPath, { route });
            if (result.status !== 200) {
              return { status: result.status, fromUrl: result.fromUrl, bodyText: '' };
            }
            return { status: 200, fromUrl: result.fromUrl, bodyText: await streamToString(result.body) };
          });
          if (cached.status === 404) {
            return (
              (await notFoundInternally(fastify, request, reply, route, null, { error: 'Metadata not found' })) ??
              reply.status(404).send({ error: 'Metadata not found' })
            );
          }
          if (cached.status !== 200) return reply.status(cached.status).send({ error: 'Upstream returned error' });
          trackDocumentSource(route, cached.fromUrl);

          const xml = cached.bodyText;
          const versions = extractMavenMetadataVersions(xml);
          const blocked = new Set<string>();
          const decisions = await evaluatePackageVersions(
            fastify.db,
            'maven',
            parsed.packageName,
            versions.map((version) => ({ version })),
            fastify.redis,
            undefined,
            { repoKey, route }
          );
          for (const version of versions) {
            const decision = decisions.get(version) ?? null;
            if (!decision || decision.decision !== 'BLOCK') continue;
            blocked.add(version);
          }

          const filtered = filterMavenMetadataXml(xml, blocked);
          reply.header('Content-Type', 'application/xml; charset=utf-8');
          return reply.status(200).send(filtered);
        } catch (err) {
          return sendUpstreamFailure(reply, err, 'Failed to proxy maven metadata');
        }
      }

      // R5: probe for the serving remote only if a scoped policy needs it, and fetch from that remote.
      const fetchOptions = trackArtifactSource(
        fastify,
        route,
        rawPath,
        `${parsed.groupId.replace(/\./g, '/')}/${parsed.artifactId}/maven-metadata.xml`
      );
      const decided = await handlePolicyDecision(
        parsed.packageName,
        parsed.version,
        parsed.fileName,
        repoKeyFromRaw(request.raw),
        route
      );
      if (decided?.decision === 'BLOCK') {
        return sendPolicyDenial(reply, decided, {
          check: { ecosystem: 'maven', packageName: parsed.packageName, version: parsed.version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      try {
        const options = await fetchOptions();
        const ref = artifactRef(
          'maven',
          parsed.packageName,
          parsed.version,
          parsed.path,
          knownRemote(options),
          mavenCacheable(parsed.fileName, parsed.version)
        );
        // POMs, checksums and signatures are read alongside the package: only the package itself counts as a download.
        const subject = { ecosystem: 'maven', packageName: parsed.packageName, version: parsed.version };
        const primary = { artifact: isMavenPrimaryArtifact(parsed.fileName) };
        const hit = await readCachedArtifact(fastify, ref);
        if (hit) {
          noteArtifactServed(fastify, route, ref!.remote, subject, decided, primary);
          return sendCacheHit(reply, hit);
        }
        const artifact = await fetchStreamFromUpstream(fastify.db, 'maven', rawPath, options);
        if (artifact.status === 404) {
          return (
            (await notFoundInternally(fastify, request, reply, route, parsed.version, { error: 'Artifact not found' })) ??
            reply.status(404).send({ error: 'Artifact not found' })
          );
        }
        if (artifact.status !== 200) return reply.status(artifact.status).send({ error: 'Upstream returned error' });
        noteArtifactServed(fastify, route, artifact.source, subject, decided, primary);
        return sendUpstreamArtifact(fastify, reply, 'maven', ref, artifact);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to proxy maven artifact');
      }
    }
  );
};

export default mavenRoutes;
