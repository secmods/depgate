import type { DataSource } from 'typeorm';
import type Redis from 'ioredis';
import { fetchFromUpstream, fetchStreamFromUpstream } from './upstream-provider.js';
import { getCachedDocument, type CachedDocument } from './metadata-cache.js';
import { targetForUrl, type PackageRoute } from './namespace-protection.js';

/** 200 returns the document, 404 returns null, anything else throws so the result is not cached. */
export async function readUpstreamText(
  db: DataSource,
  redis: Redis | null | undefined,
  route: PackageRoute,
  path: string
): Promise<CachedDocument | null> {
  const doc = await getCachedDocument(redis, db, route.ecosystem, route.cacheScope, path, async () => {
    const result = await fetchStreamFromUpstream(db, route.ecosystem, path, { route });
    if (result.status !== 200) {
      return { status: result.status, fromUrl: result.fromUrl, bodyText: '' };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of result.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return {
      status: 200,
      fromUrl: result.fromUrl,
      bodyText: Buffer.concat(chunks).toString('utf8'),
      lastModified: result.headers.get('last-modified') ?? undefined,
    };
  });
  if (doc.status === 200) noteDocumentSource(route, doc);
  if (doc.status === 200) return doc;
  if (doc.status === 404) return null;
  throw new Error(`Upstream returned ${doc.status} for ${path}`);
}

/**
 * R5: a package read through a virtual repository came from the remote that served its first
 * metadata document, unless the route already knows (a token, a probe, an npm packument).
 */
function noteDocumentSource(route: PackageRoute, doc: CachedDocument): void {
  if (route.servingSource || route.targets.length < 2) return;
  const source = targetForUrl(route.targets, doc.fromUrl);
  if (source) route.servingSource = async () => source;
}

/** The same document cache the proxy routes use, parsed as JSON. */
export async function readUpstreamJson(
  db: DataSource,
  redis: Redis | null | undefined,
  route: PackageRoute,
  path: string
): Promise<unknown | null> {
  const doc = await getCachedDocument(redis, db, route.ecosystem, route.cacheScope, path, async () => {
    const result = await fetchFromUpstream(db, route.ecosystem, path, { route });
    return {
      status: result.status,
      fromUrl: result.fromUrl,
      bodyText: result.status === 200 ? JSON.stringify(result.body ?? {}) : '',
    };
  });
  if (doc.status === 404) return null;
  if (doc.status !== 200) throw new Error(`Upstream returned ${doc.status} for ${path}`);
  noteDocumentSource(route, doc);
  if (!doc.bodyText) return null;
  try {
    return JSON.parse(doc.bodyText) as unknown;
  } catch {
    return null;
  }
}
