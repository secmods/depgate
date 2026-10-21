function stripArchiveSuffix(filename: string): string {
  return filename
    .replace(/\.tar\.gz$/i, '')
    .replace(/\.tar\.bz2$/i, '')
    .replace(/\.tar\.xz$/i, '')
    .replace(/\.zip$/i, '')
    .replace(/\.whl$/i, '')
    .replace(/\.tgz$/i, '');
}

function normalizeName(input: string): string {
  return input.toLowerCase().replace(/[-_.]+/g, '-');
}

export function extractVersionFromArtifactUrl(artifactUrl: string, packageName: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(artifactUrl);
  } catch {
    return null;
  }
  const file = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
  if (!file) return null;

  const isWheel = /\.whl$/i.test(file);
  const stem = stripArchiveSuffix(file);
  const normalizedPkg = normalizeName(packageName);

  if (isWheel) {
    const parts = stem.split('-');
    if (parts.length >= 2) {
      return parts[1] || null;
    }
    return null;
  }

  const normalizedStem = normalizeName(stem);
  const prefix = `${normalizedPkg}-`;
  if (!normalizedStem.startsWith(prefix)) return null;

  const rawAfterPrefix = stem.slice(prefix.length);
  if (!rawAfterPrefix) return null;
  return rawAfterPrefix;
}

/** The file name an upstream file URL ends in (`toml-0.10.2-py2.py3-none-any.whl`), or null. */
export function artifactName(artifactUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(artifactUrl);
  } catch {
    return null;
  }
  let file: string;
  try {
    file = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
  } catch {
    return null;
  }
  return file && !file.includes('/') ? file : null;
}

/**
 * Gateway URL for a file a simple index lists: `<files>/<package>/<file name>`. The link carries
 * no upstream address; the download finds it again in the same index (findSimpleIndexFile).
 * Nothing follows the file name, so pip's PEP 658 `<file URL>.metadata` is a gateway URL too.
 */
export function simpleArtifactHref(
  gatewayBase: string,
  filesPath: string,
  packageName: string,
  artifactUrl: string,
  fragment: string
): string | null {
  const name = artifactName(artifactUrl);
  if (!name) return null;
  return `${gatewayBase.replace(/\/$/, '')}${filesPath}/${encodeURIComponent(packageName)}/${encodeURIComponent(name)}${fragment}`;
}

/** The upstream URL of `fileName` in a simple index page, or null when the page does not list it. */
export function findSimpleIndexFile(html: string, indexUrl: string, fileName: string): string | null {
  for (const found of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    const href = (found[1] ?? '').trim();
    if (!href) continue;
    let absolute: string;
    try {
      absolute = new URL(splitFragment(href).withoutFragment, indexUrl).toString();
    } catch {
      continue;
    }
    if (artifactName(absolute) === fileName) return absolute;
  }
  return null;
}

/** PEP 592. pip skips the file unless the version is pinned, and prints this reason. */
export function markYankedAnchor(anchor: string, reason: string): string {
  if (/data-yanked\s*=/i.test(anchor)) return anchor;
  const safe = reason
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/[\r\n]+/g, ' ');
  return anchor.replace(/<a\b/i, `<a data-yanked="${safe}"`);
}

export function splitFragment(href: string): { withoutFragment: string; fragment: string } {
  const idx = href.indexOf('#');
  if (idx < 0) return { withoutFragment: href, fragment: '' };
  return { withoutFragment: href.slice(0, idx), fragment: href.slice(idx) };
}
