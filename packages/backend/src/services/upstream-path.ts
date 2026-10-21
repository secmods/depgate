/**
 * The URL parser behind fetch() resolves `..` and `%2e%2e`, reads `\` as `/` and drops tabs and
 * newlines; many registries also decode `%2F` before resolving. Any of these lets a path the policy
 * judged as one package fetch another, or leave the remote's base path.
 */
export class UnsafeUpstreamPathError extends Error {
  readonly statusCode = 400;
  constructor(readonly path: string) {
    super('Invalid package path');
    this.name = 'UnsafeUpstreamPathError';
  }
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Decodes `%XX` until nothing changes. Byte-wise, so a malformed sequence elsewhere cannot hide one. */
function decodeAll(value: string): string {
  let current = value;
  for (let i = 0; i < 4; i++) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

function hasDotSegment(value: string): boolean {
  return value.split(/[/\\]/).some((part) => part === '.' || part === '..');
}

/**
 * True when `path` cannot be sent to a remote as is: a `.` or `..` segment (encoded or not), a
 * backslash or control character, or a `?` or `#` that would cut the path short.
 */
export function isUnsafeUpstreamPath(path: string): boolean {
  if (/[?#\\]/.test(path) || hasControlChar(path)) return true;
  const decoded = decodeAll(path);
  return decoded.includes('\\') || hasControlChar(decoded) || hasDotSegment(decoded);
}

/**
 * A path parameter from the router, already decoded once. It is one segment unless `wildcard`, so
 * a `/` in it came from `%2F`; `allowScopedName` lets the npm form `@scope/name` through.
 */
export function isUnsafePathParam(value: string, opts: { wildcard: boolean; allowScopedName?: boolean }): boolean {
  if (isUnsafeUpstreamPath(value)) return true;
  if (opts.wildcard || !value.includes('/')) return false;
  return !(opts.allowScopedName && /^@[^/]+\/[^/]+$/.test(value));
}

/** The URL of `path` on the remote at `remoteUrl`. Throws unless it stays under the remote's path. */
export function upstreamUrl(remoteUrl: string, path: string, basePath = ''): string {
  const fullPath = basePath.replace(/^\//, '') + path.replace(/^\//, '');
  if (isUnsafeUpstreamPath(fullPath)) throw new UnsafeUpstreamPathError(path);
  const base = remoteUrl.replace(/\/$/, '');
  const url = `${base}/${fullPath}`.replace(/([^:]\/)\/+/g, '$1');
  const root = new URL(`${base}/`);
  const resolved = new URL(url);
  if (resolved.origin !== root.origin || !resolved.pathname.startsWith(root.pathname)) {
    throw new UnsafeUpstreamPathError(path);
  }
  return url;
}
