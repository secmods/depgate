export type NugetPath =
  | { type: 'metadata'; packageName?: string; path: string }
  | { type: 'artifact'; packageName: string; version: string; fileName: string; path: string };

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function parseNugetPath(path: string): NugetPath | null {
  const normalized = normalizePath(path);

  const flatIndex = normalized.match(/^v3-flatcontainer\/([^/]+)\/index\.json$/i);
  if (flatIndex) {
    return {
      type: 'metadata',
      packageName: decodeURIComponent(flatIndex[1]).toLowerCase(),
      path: normalized,
    };
  }

  const flatArtifact = normalized.match(/^v3-flatcontainer\/([^/]+)\/([^/]+)\/([^/]+)$/i);
  if (flatArtifact) {
    return {
      type: 'artifact',
      packageName: decodeURIComponent(flatArtifact[1]).toLowerCase(),
      version: decodeURIComponent(flatArtifact[2]),
      fileName: decodeURIComponent(flatArtifact[3]),
      path: normalized,
    };
  }

  if (/^v3\/index\.json$/i.test(normalized)) {
    return { type: 'metadata', path: normalized };
  }

  const registration = normalized.match(/^registration5-gz-semver2\/([^/]+)\/.+\.json$/i);
  if (registration) {
    return {
      type: 'metadata',
      packageName: decodeURIComponent(registration[1]).toLowerCase(),
      path: normalized,
    };
  }

  return null;
}

/** The package itself (.nupkg), not its .nuspec or other files next to it. */
export function isNugetPackageFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.nupkg');
}

export function extractFlatContainerVersions(doc: unknown): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const versions = (doc as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return [];
  return versions.filter((v): v is string => typeof v === 'string');
}

export function filterFlatContainerVersions(doc: unknown, blocked: Set<string>): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const obj = doc as { versions?: unknown[] };
  if (!Array.isArray(obj.versions)) return doc;
  return {
    ...(doc as Record<string, unknown>),
    versions: obj.versions.filter((v) => typeof v !== 'string' || !blocked.has(v)),
  };
}

function replaceStringUrl(url: string, gatewayBase: string, pathPrefix = ''): string {
  const pattern = /^https?:\/\/api\.nuget\.org\/(v3-flatcontainer\/.*)$/i;
  const m = url.match(pattern);
  if (!m) return url;
  return `${gatewayBase}/nuget/${pathPrefix}${m[1]}`;
}

export function rewriteNugetUrls<T>(value: T, gatewayBase: string, pathPrefix = ''): T {
  if (typeof value === 'string') {
    return replaceStringUrl(value, gatewayBase, pathPrefix) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteNugetUrls(v, gatewayBase, pathPrefix)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteNugetUrls(v, gatewayBase, pathPrefix);
    }
    return out as T;
  }
  return value;
}

function extractVersionFromRegistrationItem(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const asObj = item as Record<string, unknown>;
  const catalogEntry = asObj.catalogEntry;
  if (catalogEntry && typeof catalogEntry === 'object') {
    const version = (catalogEntry as { version?: unknown }).version;
    if (typeof version === 'string') return version;
  }
  const packageContent = asObj.packageContent;
  if (typeof packageContent === 'string') {
    const m = packageContent.match(/\/v3-flatcontainer\/[^/]+\/([^/]+)\//i);
    if (m) return m[1];
  }
  return undefined;
}

export function filterRegistrationVersions<T>(doc: T, blocked: Set<string>): T {
  if (!doc || typeof doc !== 'object') return doc;
  const root = doc as Record<string, unknown>;
  const items = root.items;
  if (!Array.isArray(items)) return doc;

  const filteredItems = items
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const e = entry as Record<string, unknown>;
      const child = e.items;
      if (!Array.isArray(child)) return entry;
      const kept = child.filter((leaf) => {
        const version = extractVersionFromRegistrationItem(leaf);
        return !version || !blocked.has(version);
      });
      return { ...e, items: kept };
    })
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') return true;
      const child = (entry as Record<string, unknown>).items;
      return !Array.isArray(child) || child.length > 0;
    });

  return { ...root, items: filteredItems } as T;
}

