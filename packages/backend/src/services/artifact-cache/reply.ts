import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import type { ArtifactRef } from './layout.js';
import type { CacheHit, FillResult } from './store.js';

/** F5: on every artifact response. */
export const CACHE_HEADER = 'X-DepGate-Cache';

type CacheApp = Pick<FastifyInstance, 'artifactCache'>;

/**
 * The stored file for a download the policy allowed (F1, F2), or null for a miss. A read error is a miss:
 * the route then fetches from upstream as it would without the cache.
 */
export async function readCachedArtifact(app: CacheApp, ref: ArtifactRef | null): Promise<CacheHit | null> {
  if (!ref) return null;
  try {
    return await app.artifactCache.lookup(ref);
  } catch {
    return null;
  }
}

export function sendCacheHit(reply: FastifyReply, hit: CacheHit): FastifyReply {
  reply.header('Content-Type', hit.contentType);
  reply.header('Content-Length', String(hit.size));
  reply.header(CACHE_HEADER, 'HIT');
  return reply.status(200).send(hit.stream);
}

/** An upstream 200, and the remote that answered it. */
export type UpstreamFile = { body: Readable; headers: Headers; source?: { id: string } | null };

/** MISS when the file is stored as it streams to the client, BYPASS when it only streams. */
export async function sendUpstreamArtifact(
  app: CacheApp,
  reply: FastifyReply,
  ecosystem: string,
  ref: ArtifactRef | null,
  file: UpstreamFile,
  defaultContentType = 'application/octet-stream'
): Promise<FastifyReply> {
  const contentType = file.headers.get('content-type') ?? defaultContentType;
  // fetch decodes a gzip or br body; its Content-Length is the encoded size, not what the client receives.
  const encoded = (file.headers.get('content-encoding') ?? 'identity').trim().toLowerCase() !== 'identity';
  const lengthHeader = encoded ? null : file.headers.get('content-length');
  const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : null;
  let served: FillResult = { body: file.body, result: 'BYPASS' };
  if (ref && file.source?.id === ref.remote.id) {
    try {
      served = await app.artifactCache.fill(ref, file.body, { contentType, contentLength });
    } catch {
      app.artifactCache.countBypass(ecosystem);
    }
  } else {
    app.artifactCache.countBypass(ecosystem);
  }
  reply.header('Content-Type', contentType);
  if (lengthHeader) reply.header('Content-Length', lengthHeader);
  reply.header(CACHE_HEADER, served.result);
  return reply.status(200).send(served.body);
}
