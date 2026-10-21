export type CargoPath =
  | { type: 'metadata'; packageName?: string; path: string }
  | { type: 'artifact'; packageName: string; version: string; path: string };

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function parseCargoPath(path: string): CargoPath | null {
  const normalized = normalizePath(path);

  const crateMetadata = normalized.match(/^api\/v1\/crates\/([^/?#]+)$/i);
  if (crateMetadata) {
    return {
      type: 'metadata',
      packageName: decodeURIComponent(crateMetadata[1]).toLowerCase(),
      path: normalized,
    };
  }

  const crateArtifact = normalized.match(/^api\/v1\/crates\/([^/]+)\/([^/]+)\/(download|crate)$/i);
  if (crateArtifact) {
    return {
      type: 'artifact',
      packageName: decodeURIComponent(crateArtifact[1]).toLowerCase(),
      version: decodeURIComponent(crateArtifact[2]),
      path: normalized,
    };
  }

  if (/^api\/v1\/crates(\/|\?|$)/i.test(normalized)) {
    return { type: 'metadata', path: normalized };
  }

  return null;
}

/**
 * Sparse index paths (RFC 2789): `config.json`, and one file per crate under
 * `1/<name>`, `2/<name>`, `3/<c>/<name>` or `<ab>/<cd>/<name>`.
 */
export function parseCargoIndexPath(path: string): { type: 'config' } | { type: 'index'; packageName: string } | null {
  const normalized = normalizePath(path);
  if (normalized === 'config.json') return { type: 'config' };
  const m =
    normalized.match(/^(?:1|2)\/([a-z0-9_-]+)$/i) ??
    normalized.match(/^3\/[a-z0-9_-]\/([a-z0-9_-]+)$/i) ??
    normalized.match(/^[a-z0-9_-]{2}\/[a-z0-9_-]{2}\/([a-z0-9_-]{4,})$/i);
  return m ? { type: 'index', packageName: m[1].toLowerCase() } : null;
}

/** crates.io serves its sparse index from index.crates.io; other registries serve it at their own URL. */
export function cargoSparseIndexBase(upstreamUrl: string): string {
  const base = upstreamUrl.replace(/\/$/, '');
  try {
    const host = new URL(base).hostname;
    if (host === 'crates.io' || host === 'www.crates.io' || host === 'static.crates.io') return 'https://index.crates.io';
  } catch {
    /* fall through */
  }
  return base;
}

/** Points downloads at this gateway's download route; cargo appends `/{crate}/{version}/download`. */
export function cargoSparseConfig(gatewayBase: string, pathPrefix = ''): Record<string, unknown> {
  const base = `${gatewayBase.replace(/\/$/, '')}/cargo/${pathPrefix}`;
  return { dl: `${base}api/v1/crates`, api: base.replace(/\/$/, ''), 'auth-required': true };
}

export function extractCargoVersions(doc: unknown): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const versions = (doc as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return [];
  return versions
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const version = (entry as { num?: unknown }).num;
      return typeof version === 'string' ? version : null;
    })
    .filter((v): v is string => typeof v === 'string');
}

export function filterCargoVersions<T>(doc: T, blocked: Set<string>): T {
  if (!doc || typeof doc !== 'object') return doc;
  const obj = doc as { versions?: unknown[] };
  if (!Array.isArray(obj.versions)) return doc;
  return {
    ...(doc as Record<string, unknown>),
    versions: obj.versions.filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const version = (entry as { num?: unknown }).num;
      return typeof version !== 'string' || !blocked.has(version);
    }),
  } as T;
}

export type CargoVersionMeta = { license?: string; time?: string };

function cargoRowMeta(row: Record<string, unknown>): CargoVersionMeta {
  const license = typeof row.license === 'string' ? row.license : undefined;
  const timeRaw =
    typeof row.created_at === 'string'
      ? row.created_at
      : typeof row.updated_at === 'string'
        ? row.updated_at
        : undefined;
  return { license, time: timeRaw };
}

/** Every version's metadata in one pass, so callers do not search the list once per version. */
export function cargoVersionMetaMap(doc: unknown): Map<string, CargoVersionMeta> {
  const out = new Map<string, CargoVersionMeta>();
  if (!doc || typeof doc !== 'object') return out;
  const versions = (doc as { versions?: unknown[] }).versions;
  if (!Array.isArray(versions)) return out;
  for (const entry of versions) {
    if (!entry || typeof entry !== 'object') continue;
    const num = (entry as { num?: unknown }).num;
    if (typeof num !== 'string' || out.has(num)) continue;
    out.set(num, cargoRowMeta(entry as Record<string, unknown>));
  }
  return out;
}

function rewriteCargoUrl(url: string, gatewayBase: string, pathPrefix = ''): string {
  if (/^https?:\/\/crates\.io\/api\/v1\/crates\/.+\/(?:download|crate)$/i.test(url)) {
    const normalized = url.replace(/^https?:\/\/crates\.io\//i, '');
    return `${gatewayBase}/cargo/${pathPrefix}${normalized}`;
  }
  if (/^\/api\/v1\/crates\/.+\/(?:download|crate)$/i.test(url)) {
    return `${gatewayBase}/cargo/${pathPrefix}${url.replace(/^\/+/, '')}`;
  }
  return url;
}

export function rewriteCargoUrls<T>(value: T, gatewayBase: string, pathPrefix = ''): T {
  if (typeof value === 'string') return rewriteCargoUrl(value, gatewayBase, pathPrefix) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteCargoUrls(v, gatewayBase, pathPrefix)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteCargoUrls(v, gatewayBase, pathPrefix);
    }
    return out as T;
  }
  return value;
}
