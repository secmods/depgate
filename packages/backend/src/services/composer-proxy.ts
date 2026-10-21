export type ComposerPath = { type: 'metadata'; packageName?: string; path: string };

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function parseComposerPath(path: string): ComposerPath | null {
  const normalized = normalizePath(path);
  if (/^packages\.json$/i.test(normalized)) {
    return { type: 'metadata', path: normalized };
  }
  const packagesMatch = normalized.match(/^packages\/([^/]+\/[^/]+)\.json$/i);
  if (packagesMatch) {
    return {
      type: 'metadata',
      packageName: decodeURIComponent(packagesMatch[1]).toLowerCase(),
      path: normalized,
    };
  }
  const p2Match = normalized.match(/^p2\/([^/]+\/[^/]+)(?:~dev)?\.json$/i);
  if (p2Match) {
    return {
      type: 'metadata',
      packageName: decodeURIComponent(p2Match[1]).toLowerCase(),
      path: normalized,
    };
  }
  return null;
}

type VersionRecord = {
  packageName: string;
  version: string;
  time?: string;
  license?: string;
  distUrl?: string;
  reference?: string;
};

/**
 * Composer's normalised form pads to four parts (3.12.1.0). Show the familiar three-part form
 * (3.12.1, 3.0.0-RC1); the padding carries no information. Branches (dev-main) are unchanged.
 */
export function canonicalComposerVersion(version: string): string {
  return version.replace(/^(\d+\.\d+\.\d+)\.0(?=$|-)/, '$1');
}

function normalizeComposerVersion(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  if (typeof e.version_normalized === 'string') return canonicalComposerVersion(e.version_normalized);
  if (typeof e.version === 'string') return e.version;
  return undefined;
}

function readComposerDist(vObj: Record<string, unknown>): { distUrl?: string; reference?: string } {
  const dist = vObj.dist;
  const distObj = dist && typeof dist === 'object' ? (dist as Record<string, unknown>) : undefined;
  const distUrl = distObj && typeof distObj.url === 'string' && distObj.url ? distObj.url : undefined;
  let reference =
    distObj && typeof distObj.reference === 'string' && distObj.reference ? distObj.reference : undefined;
  if (!reference && vObj.source && typeof vObj.source === 'object') {
    const sourceRef = (vObj.source as Record<string, unknown>).reference;
    if (typeof sourceRef === 'string' && sourceRef) reference = sourceRef;
  }
  return { distUrl, reference };
}

/** Composer lists alternatives: the user may pick any license in the array, so they are joined with OR. */
function composerLicense(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  if (ids.length === 0) return undefined;
  return ids.length === 1 ? ids[0] : ids.map((id) => (/\s/.test(id) ? `(${id})` : id)).join(' OR ');
}

export function extractComposerVersions(doc: unknown, fallbackPackage?: string): VersionRecord[] {
  if (!doc || typeof doc !== 'object') return [];
  const out: VersionRecord[] = [];
  const root = doc as Record<string, unknown>;

  const pkgObj = root.package;
  if (pkgObj && typeof pkgObj === 'object') {
    const p = pkgObj as Record<string, unknown>;
    const packageName = (typeof p.name === 'string' ? p.name : fallbackPackage)?.toLowerCase();
    const versions = p.versions;
    if (packageName && versions && typeof versions === 'object') {
      for (const value of Object.values(versions as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const vObj = value as Record<string, unknown>;
        const version = normalizeComposerVersion(vObj);
        if (!version) continue;
        const { distUrl, reference } = readComposerDist(vObj);
        const time = typeof vObj.time === 'string' ? vObj.time : undefined;
        const license = composerLicense(vObj.license);
        out.push({ packageName, version, time, license, distUrl, reference });
      }
    }
  }

  const packages = root.packages;
  if (packages && typeof packages === 'object') {
    for (const [pkgName, versions] of Object.entries(packages as Record<string, unknown>)) {
      if (!Array.isArray(versions)) continue;
      for (const entry of versions) {
        if (!entry || typeof entry !== 'object') continue;
        const vObj = entry as Record<string, unknown>;
        const version = normalizeComposerVersion(vObj);
        if (!version) continue;
        const { distUrl, reference } = readComposerDist(vObj);
        const time = typeof vObj.time === 'string' ? vObj.time : undefined;
        const license = composerLicense(vObj.license);
        out.push({ packageName: pkgName.toLowerCase(), version, time, license, distUrl, reference });
      }
    }
  }

  return out;
}

function referenceCandidates(url: string, byReference: Map<string, VersionRecord>): VersionRecord | undefined {
  const hashes = url.match(/[a-f0-9]{7,64}/gi);
  if (!hashes) return undefined;
  for (const hash of hashes) {
    const direct = byReference.get(hash.toLowerCase());
    if (direct) return direct;
  }
  const candidates: VersionRecord[] = [];
  const seen = new Set<VersionRecord>();
  for (const hash of hashes) {
    const key = hash.toLowerCase();
    for (const [ref, row] of byReference) {
      if (seen.has(row)) continue;
      if (ref.startsWith(key) || key.startsWith(ref)) {
        seen.add(row);
        candidates.push(row);
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Match a dist URL to its version via the exact URL or the commit hash it carries. */
export function createComposerArtifactMatcher(versions: readonly VersionRecord[]): (url: string) => VersionRecord | undefined {
  const byDistUrl = new Map<string, VersionRecord>();
  const byReference = new Map<string, VersionRecord>();
  for (const row of versions) {
    if (row.distUrl && !byDistUrl.has(row.distUrl)) byDistUrl.set(row.distUrl, row);
    const reference = row.reference?.trim().toLowerCase();
    if (reference && reference.length >= 7 && /^[a-f0-9]+$/.test(reference) && !byReference.has(reference)) {
      byReference.set(reference, row);
    }
  }
  return (url: string) => {
    const exact = byDistUrl.get(url);
    if (exact) return exact;
    if (!/^https?:\/\//i.test(url)) return undefined;
    return referenceCandidates(url, byReference);
  };
}

export function filterComposerVersions<T>(doc: T, blocked: Map<string, Set<string>>): T {
  if (!doc || typeof doc !== 'object') return doc;
  const root = doc as Record<string, unknown>;

  const pkgObj = root.package;
  let nextPackage = pkgObj;
  if (pkgObj && typeof pkgObj === 'object') {
    const p = pkgObj as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name.toLowerCase() : undefined;
    const blockedSet = name ? blocked.get(name) : undefined;
    const versions = p.versions;
    if (blockedSet && versions && typeof versions === 'object') {
      const filteredEntries = Object.entries(versions as Record<string, unknown>).filter(([, v]) => {
        const version = normalizeComposerVersion(v);
        return !version || !blockedSet.has(version);
      });
      nextPackage = { ...p, versions: Object.fromEntries(filteredEntries) };
    }
  }

  const packages = root.packages;
  let nextPackages = packages;
  if (packages && typeof packages === 'object') {
    const out: Record<string, unknown> = {};
    for (const [pkgName, versions] of Object.entries(packages as Record<string, unknown>)) {
      if (!Array.isArray(versions)) {
        out[pkgName] = versions;
        continue;
      }
      const blockedSet = blocked.get(pkgName.toLowerCase());
      if (!blockedSet) {
        out[pkgName] = versions;
        continue;
      }
      out[pkgName] = versions.filter((entry) => {
        const version = normalizeComposerVersion(entry);
        return !version || !blockedSet.has(version);
      });
    }
    nextPackages = out;
  }

  return {
    ...root,
    package: nextPackage,
    packages: nextPackages,
  } as T;
}

/**
 * packages.json: Composer v2 resolves every package through `metadata-url`. Point it
 * at this gateway's p2 route (relative, so it is not rewritten as an artifact URL) and
 * drop upstream-only endpoints (notify-batch, search, list, providers, advisories),
 * which would otherwise send clients to the public registry.
 */
export function composerRootDocument(doc: unknown, pathPrefix = ''): Record<string, unknown> {
  const root = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  return {
    packages: root.packages ?? [],
    'metadata-url': `/composer/${pathPrefix}p2/%package%.json`,
  };
}

/**
 * Gateway URL for one version's archive: `<base>/composer/<prefix>dist/<vendor>/<name>/<version>`. The
 * download finds the upstream `dist.url` again in the package's metadata, so the link carries no address.
 */
export function composerDistHref(gatewayBase: string, packageName: string, version: string, pathPrefix = ''): string {
  const name = packageName.split('/').map(encodeURIComponent).join('/');
  return `${gatewayBase}/composer/${pathPrefix}dist/${name}/${encodeURIComponent(version)}`;
}

/** Replaces every absolute http(s) URL in a metadata document, so no download goes to the upstream directly. */
export function rewriteComposerDistUrls<T>(value: T, rewrite: (url: string) => string): T {
  if (typeof value === 'string') {
    return (/^https?:\/\//i.test(value) ? rewrite(value) : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteComposerDistUrls(v, rewrite)) as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteComposerDistUrls(v, rewrite);
    }
    return out as T;
  }
  return value;
}
