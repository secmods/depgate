export const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const RESERVED_REPO_KEYS = ['default', 'all'] as const;
const RESERVED = new Set<string>(RESERVED_REPO_KEYS);
/** Path segments that belong to a package protocol, not a repository key. */
const BLOCKED_KEYS = new Set(['simple', 'files', 'v3', 'index', 'api', 'packages']);

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const keysByEco = new Map<string, Set<string>>();
for (const eco of ECOSYSTEMS) {
  keysByEco.set(eco, new Set(RESERVED_REPO_KEYS));
}

/** Cross-process notification. rewriteUrl is synchronous, so each process applies this to its own set. */
export const REPO_KEY_CHANNEL = 'depgate:repo-keys';

type RepoKeyPublisher = {
  publish: (channel: string, message: string) => unknown;
};

let publisher: RepoKeyPublisher | null = null;

export function bindRepoKeyPublisher(next: RepoKeyPublisher | null): void {
  publisher = next;
}

function publishRepoKey(event: { op: 'add' | 'remove'; ecosystem: string; key: string }): void {
  if (!publisher) return;
  try {
    const result = publisher.publish(REPO_KEY_CHANNEL, JSON.stringify(event));
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    /* a DB refresh on each process still converges */
  }
}

export function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}

export function validateRepoKey(key: string): string | null {
  if (!KEY_PATTERN.test(key)) {
    return 'Key must be 1–64 characters: lowercase letters, digits, and hyphens, starting with a letter or digit';
  }
  if (RESERVED.has(key)) return `Key "${key}" is reserved`;
  if (BLOCKED_KEYS.has(key)) return `Key "${key}" is used by the package protocol`;
  return null;
}

export function rememberRepoKey(ecosystem: string, key: string): void {
  let set = keysByEco.get(ecosystem);
  if (!set) {
    set = new Set(RESERVED_REPO_KEYS);
    keysByEco.set(ecosystem, set);
  }
  set.add(key);
}

export function forgetRepoKey(ecosystem: string, key: string): void {
  if (RESERVED.has(key)) return;
  keysByEco.get(ecosystem)?.delete(key);
}

/** Remember the key here and tell other processes. Does not publish when called from the subscriber. */
export function shareRepoKey(ecosystem: string, key: string): void {
  rememberRepoKey(ecosystem, key);
  publishRepoKey({ op: 'add', ecosystem, key });
}

export function unshareRepoKey(ecosystem: string, key: string): void {
  if (RESERVED.has(key)) return;
  forgetRepoKey(ecosystem, key);
  publishRepoKey({ op: 'remove', ecosystem, key });
}

export function applyRepoKeyMessage(message: string): void {
  let event: { op?: string; ecosystem?: string; key?: string };
  try {
    event = JSON.parse(message) as { op?: string; ecosystem?: string; key?: string };
  } catch {
    return;
  }
  if (!event.ecosystem || !event.key) return;
  if (event.op === 'add') rememberRepoKey(event.ecosystem, event.key);
  else if (event.op === 'remove') forgetRepoKey(event.ecosystem, event.key);
}

export function rememberRepoKeys(rows: Array<{ ecosystem: string; key: string }>): void {
  for (const eco of ECOSYSTEMS) {
    keysByEco.set(eco, new Set(RESERVED_REPO_KEYS));
  }
  for (const row of rows) rememberRepoKey(row.ecosystem, row.key);
}

export function isKnownRepoKey(ecosystem: string, key: string): boolean {
  if (RESERVED.has(key)) return true;
  return keysByEco.get(ecosystem)?.has(key) ?? false;
}

export const ACCESS_TOKEN_SEGMENT = '_auth';

export type RepoTaggedRequest = {
  url?: string;
  headers?: { authorization?: string | string[] | undefined };
  depgateRepoKey?: string;
  depgateRepoExplicit?: boolean;
  depgateAccessToken?: string;
};

export type RepoUrlContext = {
  key?: string;
  explicit?: boolean;
  accessToken?: string;
};

/** Repository key inserted after the ecosystem. The client sends the token as a header. */
export function repoPathPrefix(repo?: RepoUrlContext): string {
  if (repo?.explicit && repo.key) return `${encodeURIComponent(repo.key)}/`;
  return '';
}

/**
 * Strip a known repository key from `/{ecosystem}/{key}/...` so existing
 * protocol routes keep matching. Legacy paths stay unchanged and resolve as `default`.
 */
export function rewritePackageUrl(url: string, req?: RepoTaggedRequest): string {
  const qIndex = url.indexOf('?');
  const beforeQuery = qIndex === -1 ? url : url.slice(0, qIndex);
  const query = qIndex === -1 ? '' : url.slice(qIndex);
  const hashIndex = beforeQuery.indexOf('#');
  const path = hashIndex === -1 ? beforeQuery : beforeQuery.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : beforeQuery.slice(hashIndex);

  const trailing = path.endsWith('/');
  const parts = path.split('/').filter(Boolean);
  const mark = (key: string, explicit: boolean) => {
    if (req) {
      req.depgateRepoKey = key;
      req.depgateRepoExplicit = explicit;
    }
  };

  if (parts.length < 2 || !(ECOSYSTEMS as readonly string[]).includes(parts[0])) {
    mark('default', false);
    return url;
  }

  const eco = parts[0];
  const maybeKey = safeDecode(parts[1]);
  let rest: string[];
  if (isKnownRepoKey(eco, maybeKey)) {
    rest = parts.slice(2);
    mark(maybeKey, true);
  } else if (maybeKey === ACCESS_TOKEN_SEGMENT) {
    rest = parts.slice(1);
    mark('default', false);
  } else {
    mark('default', false);
    return url;
  }

  if (rest[0] === ACCESS_TOKEN_SEGMENT && rest[1]) {
    const token = safeDecode(rest[1]);
    if (req) {
      req.depgateAccessToken = token;
      if (req.headers && !req.headers.authorization) {
        req.headers.authorization = `Bearer ${token}`;
      }
    }
    rest = rest.slice(2);
  }

  const rewritten =
    rest.length === 0
      ? `/${eco}${trailing ? '/' : ''}`
      : `/${eco}/${rest.join('/')}${trailing ? '/' : ''}`;
  return rewritten + hash + query;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function accessTokenFromRaw(raw: RepoTaggedRequest | undefined): string | undefined {
  return raw?.depgateAccessToken || undefined;
}

export function repoKeyFromRaw(raw: RepoTaggedRequest | undefined): string {
  return raw?.depgateRepoKey || 'default';
}

export function repoExplicitFromRaw(raw: RepoTaggedRequest | undefined): boolean {
  return raw?.depgateRepoExplicit === true;
}

export function clientPath(ecosystem: string, key: string): string {
  switch (ecosystem) {
    case 'npm':
      return `/npm/${key}/`;
    case 'pypi':
      return `/pypi/${key}/simple/`;
    case 'go':
      return `/go/${key}`;
    case 'maven':
      return `/maven/${key}/`;
    case 'nuget':
      return `/nuget/${key}/v3/index.json`;
    case 'cargo':
      return `/cargo/${key}/`;
    case 'composer':
      return `/composer/${key}/packages.json`;
    case 'rubygems':
      return `/rubygems/${key}`;
    default:
      return `/${ecosystem}/${key}/`;
  }
}
