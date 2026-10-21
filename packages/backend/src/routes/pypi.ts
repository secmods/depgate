import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';
import { config } from '../config.js';
import {
  buildAuthHeaders,
  discardBody,
  fetchStreamFromUpstream,
  fetchUpstreamResponse,
  parseAuth,
  sendUpstreamFailure,
} from '../services/upstream-provider.js';
import { accessTokenFromRaw, repoExplicitFromRaw, repoKeyFromRaw, repoPathPrefix } from '../services/repo-keys.js';
import { targetForUrl, type PackageRoute } from '../services/namespace-protection.js';
import {
  denyNamespace,
  noteServed,
  notFoundInternally,
  packageRoute,
  servingTarget,
  trackDocumentSource,
  trackKnownSource,
} from './namespace-guard.js';
import {
  extractVersionFromArtifactUrl,
  findSimpleIndexFile,
  markYankedAnchor,
  simpleArtifactHref,
  splitFragment,
} from '../services/pypi-simple.js';
import { getCachedDocument } from '../services/metadata-cache.js';
import { evaluatePackageVersions } from '../services/policy-engine.js';
import { evaluateDownload } from '../services/monitor-recorder.js';
import { blockedVersionMessage, sendPolicyDenial } from '../services/policy-notice.js';
import { recordDownloadBlocked, recordDownloadAllowed } from '../services/events/download-events.js';
import { artifactRef } from '../services/artifact-cache/layout.js';
import { readCachedArtifact, sendCacheHit, sendUpstreamArtifact } from '../services/artifact-cache/reply.js';

async function streamToString(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** pypi.org serves its files from this host, not from the index URL. */
/** files.pythonhosted.org: PyPI's file host, never a configured remote, so it has no repository ID. */
const PYPI_FILES_HOST = { id: 'files.pythonhosted.org', key: 'default', source: 'public' as const };

const pypiRoutes: FastifyPluginAsync = async (fastify) => {
  const pypiAuth = fastify.authenticate({ roles: ['User', 'Security'] });

  /** A package's simple index page, cached; file downloads read it again to find the upstream URL. */
  const simpleIndex = (route: PackageRoute, pkg: string) =>
    getCachedDocument(fastify.redis, fastify.db, 'pypi', route.cacheScope, `simple/${pkg}/`, async () => {
      const result = await fetchStreamFromUpstream(fastify.db, 'pypi', `simple/${pkg}/`, { route });
      if (result.status !== 200) {
        return { status: result.status, fromUrl: result.fromUrl, bodyText: '' };
      }
      return { status: 200, fromUrl: result.fromUrl, bodyText: await streamToString(result.body) };
    });

  /** The upstream URL of a file the package's index lists, and the remote whose index listed it (R5). */
  const findFile = async (route: PackageRoute, pkg: string, fileName: string) => {
    const index = await simpleIndex(route, pkg);
    if (index.status !== 200) return null;
    const url = findSimpleIndexFile(index.bodyText, index.fromUrl, fileName);
    return url ? { url, listedBy: targetForUrl(route.targets, index.fromUrl) } : null;
  };

  fastify.get<{ Params: { pkg: string } }>(
    '/pypi/simple/:pkg/',
    {
      preHandler: [pypiAuth],
      schema: {
        tags: ['PyPI Proxy'],
        params: {
          type: 'object',
          required: ['pkg'],
          properties: { pkg: { type: 'string' } },
        },
        response: {
          200: { type: 'string', description: 'PyPI simple index HTML with rewritten artifact URLs' },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const pkg = request.params.pkg;
      if (!pkg) {
        return reply.status(400).send({ error: 'Package name required' });
      }
      const repoKey = repoKeyFromRaw(request.raw);
      const filesPath = `/pypi/${repoPathPrefix({
        key: repoKey,
        explicit: repoExplicitFromRaw(request.raw),
        accessToken: accessTokenFromRaw(request.raw),
      })}files`;
      try {
        const route = await packageRoute(fastify, request, 'pypi', pkg);
        if (route.block) return denyNamespace(fastify, request, reply, route);
        const cached = await simpleIndex(route, pkg);
        if (cached.status === 404) {
          return (await notFoundInternally(fastify, request, reply, route, null)) ?? reply.status(404).send({ error: 'Package not found' });
        }
        if (cached.status !== 200) {
          return reply.status(cached.status).send({ error: 'Upstream returned error' });
        }
        const html = cached.bodyText;
        const upstreamUrl = cached.fromUrl;
        trackDocumentSource(route, upstreamUrl);
        const gatewayBase = config.gateway.baseUrl.replace(/\/$/, '');
        const anchorRegex = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
        const versions = new Set<string>();
        for (const found of html.matchAll(anchorRegex)) {
          const href = (found[1] ?? '').trim();
          if (!href) continue;
          try {
            const absolute = new URL(splitFragment(href).withoutFragment, upstreamUrl).toString();
            const version = extractVersionFromArtifactUrl(absolute, pkg);
            if (version) versions.add(version);
          } catch {
            /* skip unparseable links */
          }
        }
        const decisions = await evaluatePackageVersions(
          fastify.db,
          'pypi',
          pkg,
          [...versions].map((version) => ({ version })),
          fastify.redis,
          undefined,
          { repoKey, route }
        );
        anchorRegex.lastIndex = 0;
        let rewritten = '';
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = anchorRegex.exec(html)) !== null) {
          const anchor = match[0];
          const href = (match[1] ?? '').trim();
          rewritten += html.slice(lastIndex, match.index);
          lastIndex = match.index + anchor.length;

          if (!href) {
            continue;
          }

          const { withoutFragment, fragment } = splitFragment(href);
          let absolute: string;
          try {
            absolute = new URL(withoutFragment, upstreamUrl).toString();
          } catch {
            rewritten += anchor;
            continue;
          }
          const version = extractVersionFromArtifactUrl(absolute, pkg);
          const policyResult = version ? (decisions.get(version) ?? null) : null;
          const blocked = policyResult?.decision === 'BLOCK';

          const nextHref = simpleArtifactHref(gatewayBase, filesPath, pkg, absolute, fragment);
          // Not a file (no name to look up again): leave it out rather than link upstream directly.
          if (!nextHref) continue;
          let nextAnchor = anchor.replace(/(href\s*=\s*["'])([^"']+)(["'])/i, `$1${nextHref}$3`);
          if (blocked && policyResult) nextAnchor = markYankedAnchor(nextAnchor, blockedVersionMessage(policyResult));
          rewritten += nextAnchor;
        }
        rewritten += html.slice(lastIndex);
        reply.header('Content-Type', 'text/html; charset=utf-8');
        return reply.status(200).send(rewritten);
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to fetch PyPI simple index');
      }
    }
  );

  const handlePypiFile = async (request: FastifyRequest, reply: FastifyReply, pkg: string, fileName: string) => {
      const route = await packageRoute(fastify, request, 'pypi', pkg);
      if (route.block) return denyNamespace(fastify, request, reply, route);
      const file = await findFile(route, pkg, fileName);
      if (!file) return reply.status(404).send({ error: 'File not found in the package index' });
      const decodedUrl = new URL(file.url);
      const packageName = pkg;
      const version = extractVersionFromArtifactUrl(file.url, pkg) || '0.0.0';
      // R5: the file comes from the remote whose index listed it.
      const matchingRegistry = servingTarget(route, file.listedBy?.id, file.url);
      trackKnownSource(route, matchingRegistry);
      const policyResult = await evaluateDownload(fastify, 'pypi', packageName, version, {
        repoKey: repoKeyFromRaw(request.raw),
        route,
      });
      if (policyResult && policyResult.decision === 'BLOCK') {
        recordDownloadBlocked(fastify, { ecosystem: 'pypi', packageName, version }, policyResult, {
          webhookPayload: {
            event: 'package_blocked',
            timestamp: new Date().toISOString(),
            ecosystem: 'pypi',
            packageName,
            version,
            decision: policyResult.decision,
            policyId: policyResult.policyId,
            policyName: policyResult.policyName,
            reasons: policyResult.reasons,
          },
        });
        return sendPolicyDenial(reply, policyResult, {
          check: { ecosystem: 'pypi', packageName, version, repository: repoKeyFromRaw(request.raw) },
        });
      }

      const isPypiFilesHost = decodedUrl.hostname === 'files.pythonhosted.org';
      if (!matchingRegistry && route.reserved) {
        // Listed by a public remote (an index from before the policy): never fetched for a reserved name.
        const missing = await notFoundInternally(fastify, request, reply, route, version);
        if (missing) return missing;
      }
      if (!matchingRegistry && !isPypiFilesHost) {
        return reply.status(400).send({ error: 'The file is not on a configured PyPI upstream' });
      }
      noteServed(fastify, route, matchingRegistry ?? PYPI_FILES_HOST, version, { artifact: true });
      const ref = artifactRef('pypi', packageName, version, fileName, matchingRegistry);
      const hit = await readCachedArtifact(fastify, ref);
      if (hit) {
        recordDownloadAllowed(fastify, { ecosystem: 'pypi', packageName, version }, policyResult);
        return sendCacheHit(reply, hit);
      }

      try {
        const headers = matchingRegistry
          ? buildAuthHeaders(parseAuth(matchingRegistry))
          : {};
        const upstreamRes = await fetchUpstreamResponse(decodedUrl.href, {
          headers,
          timeoutMs: matchingRegistry?.timeoutMs,
          retryCount: matchingRegistry?.retryCount,
        });

        if (upstreamRes.status !== 200 || !upstreamRes.body) {
          await discardBody(upstreamRes);
          return reply.status(upstreamRes.status === 200 ? 502 : upstreamRes.status).send({ error: 'Upstream returned error' });
        }

        recordDownloadAllowed(fastify, { ecosystem: 'pypi', packageName, version }, policyResult);
        return sendUpstreamArtifact(fastify, reply, 'pypi', ref, {
          body: Readable.fromWeb(upstreamRes.body),
          headers: upstreamRes.headers,
          source: matchingRegistry,
        });
      } catch (err) {
        return sendUpstreamFailure(reply, err, 'Failed to fetch PyPI artifact');
      }
  };

  /**
   * PEP 658 core metadata (`<file URL>.metadata`) passes through: pip reads it to resolve, then
   * shows a blocked version as yanked with the policy sentence before its download gets 403.
   */
  const handlePypiMetadata = async (request: FastifyRequest, reply: FastifyReply, pkg: string, fileName: string) => {
    const route = await packageRoute(fastify, request, 'pypi', pkg);
    if (route.block) return denyNamespace(fastify, request, reply, route);
    const file = await findFile(route, pkg, fileName);
    if (!file) return reply.status(404).send({ error: 'File not found in the package index' });
    const matching = servingTarget(route, file.listedBy?.id, file.url);
    if (!matching && route.reserved) return reply.status(404).send({ error: 'Package not found' });
    if (!matching && new URL(file.url).hostname !== 'files.pythonhosted.org') {
      return reply.status(400).send({ error: 'The file is not on a configured PyPI upstream' });
    }
    const version = extractVersionFromArtifactUrl(file.url, pkg) || '0.0.0';
    const ref = artifactRef('pypi', pkg, version, `${fileName}.metadata`, matching);
    const hit = await readCachedArtifact(fastify, ref);
    if (hit) return sendCacheHit(reply, hit);
    try {
      const res = await fetchUpstreamResponse(`${file.url}.metadata`, {
        headers: matching ? buildAuthHeaders(parseAuth(matching)) : {},
        timeoutMs: matching?.timeoutMs,
        retryCount: matching?.retryCount,
      });
      if (res.status !== 200 || !res.body) {
        await discardBody(res);
        return reply.status(res.status === 404 ? 404 : 502).send({ error: 'Upstream returned error' });
      }
      return sendUpstreamArtifact(fastify, reply, 'pypi', ref, { body: Readable.fromWeb(res.body), headers: res.headers, source: matching });
    } catch (err) {
      return sendUpstreamFailure(reply, err, 'Failed to fetch PyPI core metadata');
    }
  };

  fastify.get<{ Params: { pkg: string; filename: string } }>(
    '/pypi/files/:pkg/:filename',
    { preHandler: [pypiAuth], schema: { tags: ['PyPI Proxy'] } },
    (request, reply) => {
      const { pkg, filename } = request.params;
      return filename.endsWith('.metadata')
        ? handlePypiMetadata(request, reply, pkg, filename.slice(0, -'.metadata'.length))
        : handlePypiFile(request, reply, pkg, filename);
    }
  );
};

export default pypiRoutes;
