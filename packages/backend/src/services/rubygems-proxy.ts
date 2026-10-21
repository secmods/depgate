export type RubygemsPath = { type: 'metadata'; packageName?: string; path: string };

type RubygemsVersionMeta = {
  packageName: string;
  version: string;
  time?: string;
  license?: string;
};

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function parseRubygemsPath(path: string): RubygemsPath | null {
  const normalized = normalizePath(path);
  if (/^api\/v1\/versions\/[^/]+\.json$/i.test(normalized)) {
    const pkg = normalized.match(/^api\/v1\/versions\/([^/]+)\.json$/i)?.[1];
    return { type: 'metadata', packageName: pkg?.toLowerCase(), path: normalized };
  }
  if (/^api\/v1\/versions\/[^/]+\/latest\.json$/i.test(normalized)) {
    const pkg = normalized.match(/^api\/v1\/versions\/([^/]+)\/latest\.json$/i)?.[1];
    return { type: 'metadata', packageName: pkg?.toLowerCase(), path: normalized };
  }
  return null;
}

/** What the gem and Bundler clients request: the compact index, gemspecs and .gem files. */
export type RubygemsClientPath =
  | { type: 'index'; path: string }
  | { type: 'gem'; packageName: string; version: string; path: string };

/** `<name>-<version>[-<platform>]`. The name ends before the first `-<digit>`; RubyGems versions contain no `-`. */
export function parseGemFileName(stem: string): { packageName: string; version: string } | null {
  const match = stem.match(/^(.+?)-(\d[^-]*)(?:-.+)?$/);
  if (!match) return null;
  return { packageName: match[1].toLowerCase(), version: match[2] };
}

export function parseRubygemsClientPath(path: string): RubygemsClientPath | null {
  const normalized = normalizePath(path);
  if (
    normalized === 'versions' ||
    /^info\/[A-Za-z0-9._-]+$/.test(normalized) ||
    /^quick\/Marshal\.4\.8\/[^/]+\.gemspec\.rz$/.test(normalized)
  ) {
    return { type: 'index', path: normalized };
  }
  const gem = normalized.match(/^gems\/([^/]+)\.gem$/);
  const parsed = gem ? parseGemFileName(gem[1]) : null;
  return parsed ? { type: 'gem', ...parsed, path: normalized } : null;
}

function toArray(doc: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(doc)) return doc.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
  if (doc && typeof doc === 'object') return [doc as Record<string, unknown>];
  return [];
}

export function extractRubygemsVersions(doc: unknown, packageName?: string): RubygemsVersionMeta[] {
  const out: RubygemsVersionMeta[] = [];
  for (const row of toArray(doc)) {
    const version = typeof row.number === 'string' ? row.number : undefined;
    if (!version) continue;
    const pkg = (
      typeof row.name === 'string'
        ? row.name
        : packageName ?? ''
    ).toLowerCase();
    if (!pkg) continue;
    // RubyGems does not say whether several licenses are alternatives, so all of them apply.
    const license = Array.isArray(row.licenses)
      ? row.licenses.filter((item): item is string => typeof item === 'string' && item.trim() !== '').join(' AND ') || undefined
      : typeof row.licenses === 'string'
        ? String(row.licenses)
        : undefined;
    // created_at is when the version was published; built_at is the gem file timestamp, which
    // reproducible builds pin to 1980-01-02.
    const time = typeof row.created_at === 'string'
      ? row.created_at
      : typeof row.built_at === 'string'
        ? row.built_at
        : undefined;
    out.push({
      packageName: pkg,
      version,
      time,
      license,
    });
  }
  return out;
}

export function buildRubygemsDownloadUrl(packageName: string, version: string): string {
  return `https://rubygems.org/downloads/${packageName}-${version}.gem`;
}

export function filterRubygemsVersions<T>(doc: T, blocked: Set<string>): T {
  if (Array.isArray(doc)) {
    return doc.filter((row) => {
      if (!row || typeof row !== 'object') return true;
      const version = (row as { number?: unknown }).number;
      return typeof version !== 'string' || !blocked.has(version);
    }) as T;
  }
  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    const version = obj.number;
    if (typeof version === 'string' && blocked.has(version)) {
      return {} as T;
    }
  }
  return doc;
}

/**
 * Points every `.gem` download URL (`.../downloads/<file>.gem` or `.../gems/<file>.gem`) at the gateway's
 * `gems/<file>.gem`, the path the gem and Bundler clients use, so the link carries no upstream address.
 */
export function rewriteRubygemsUrls<T>(value: T, gatewayBase: string, pathPrefix = ''): T {
  if (typeof value === 'string') {
    const match = value.match(/^https?:\/\/[^?#]*\/(?:downloads|gems)\/([^/?#]+\.gem)$/i);
    return (match ? `${gatewayBase}/rubygems/${pathPrefix}gems/${match[1]}` : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteRubygemsUrls(v, gatewayBase, pathPrefix)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteRubygemsUrls(v, gatewayBase, pathPrefix);
    }
    return out as T;
  }
  return value;
}
