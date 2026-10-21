import { Readable } from 'stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DataSource } from 'typeorm';
import { UpstreamRegistry } from '../db/entities/UpstreamRegistry.js';
import { getCircuitBreaker, retryAfterSeconds } from './circuit-breaker.js';
import { listEnabledUpstreams, type RemoteTarget } from './repository-resolve.js';
import type { PackageRoute } from './namespace-protection.js';
import { logAudit } from './audit-service.js';
import { upstreamUrl } from './upstream-path.js';
import { decryptSecret, encryptSecret } from './mail-settings.js';

/**
 * A remote failed (timeout, connection error, open circuit breaker). The search stops there:
 * moving on would let the next remote, often a public registry, answer for the package (R1).
 * Routes answer 502, or 503 with Retry-After while the remote's breaker is open (sendUpstreamFailure,
 * also used by the root error handler for failures outside a route's catch).
 */
export class UpstreamUnavailableError extends Error {
  /** Set when the breaker was open: when it lets a request through again. */
  readonly retryAfterSeconds?: number;

  constructor(
    readonly ecosystem: string,
    readonly remote: Pick<RemoteTarget, 'id' | 'key'>,
    reason: string,
    retryAfterMs?: number
  ) {
    super(`Upstream ${ecosystem}/${remote.key} is unavailable: ${reason}`);
    this.name = 'UpstreamUnavailableError';
    if (retryAfterMs !== undefined) this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

/**
 * The answer to a failed upstream call, logged as `logMessage`. While the remote's circuit breaker
 * is open: 503 with Retry-After, logged at debug, because every request is refused until it closes
 * and the UPSTREAM_UNAVAILABLE ledger row already records the outage. Otherwise 502, logged as an error.
 */
export function sendUpstreamFailure(reply: FastifyReply, err: unknown, logMessage = 'Upstream fetch failed'): FastifyReply {
  const error = err instanceof Error ? err.message : 'Upstream fetch failed';
  const retryAfter = retryAfterSeconds(err);
  if (retryAfter) {
    reply.log.debug({ reason: error }, logMessage);
    return reply.header('Retry-After', String(retryAfter)).status(503).send({ error });
  }
  reply.log.error(err, logMessage);
  return reply.status(502).send({ error });
}

/**
 * Root error handler. An upstream failure that escapes a route's own catch, such as an open
 * breaker met while a policy loads its facts, is answered like one the route caught (502 or 503).
 * Every other error goes on to Fastify's default handler.
 */
export function upstreamErrorHandler(error: Error, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (!(error instanceof UpstreamUnavailableError) && !retryAfterSeconds(error)) throw error;
  return sendUpstreamFailure(reply, error, `Upstream unavailable during ${request.method} ${request.routeOptions.url ?? request.url}`);
}

/** One ledger row per remote per minute, so an outage is visible without flooding the ledger. */
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;
const lastUnavailableLog = new Map<string, number>();

function unavailable(
  db: DataSource,
  ecosystem: string,
  remote: RemoteTarget,
  reason: string,
  retryAfterMs?: number
): UpstreamUnavailableError {
  const error = new UpstreamUnavailableError(ecosystem, remote, reason, retryAfterMs);
  const now = Date.now();
  if (now - (lastUnavailableLog.get(remote.id) ?? 0) >= UNAVAILABLE_LOG_INTERVAL_MS) {
    lastUnavailableLog.set(remote.id, now);
    void logAudit(db, {
      ecosystem,
      packageName: remote.key,
      decision: 'UPSTREAM_UNAVAILABLE',
      conditionReasons: [error.message, 'The request was not passed to another remote'],
    }).catch(() => undefined);
  }
  return error;
}

/** For tests: forget when each remote's outage was last written to the ledger. */
export function resetUnavailableLog(): void {
  lastUnavailableLog.clear();
}

export type AuthConfig = {
  type: 'bearer' | 'basic' | 'header';
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  value?: string;
};

/** The stored form of a remote's credentials: AES-256-GCM, like the SMTP and SSO secrets. */
export function encodeAuth(payload: Record<string, string>): string {
  return encryptSecret(JSON.stringify(payload));
}

/** Null when nothing is stored, or when it cannot be decrypted (JWT_SECRET changed): the remote is then called without credentials. */
export function parseAuth(reg: { authEncrypted: string | null; authType: string | null }): AuthConfig | null {
  if (!reg.authEncrypted || !reg.authType) return null;
  try {
    const plain = decryptSecret(reg.authEncrypted);
    if (!plain) return null;
    const raw = JSON.parse(plain) as Record<string, string>;
    if (reg.authType === 'bearer' && raw.token) return { type: 'bearer', token: raw.token };
    if (reg.authType === 'basic' && raw.username && raw.password) {
      return { type: 'basic', username: raw.username, password: raw.password };
    }
    if (reg.authType === 'header' && raw.headerName && raw.value) {
      return { type: 'header', headerName: raw.headerName, value: raw.value };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function buildAuthHeaders(auth: AuthConfig | null): Record<string, string> {
  if (!auth) return {};
  if (auth.type === 'bearer' && auth.token) return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'basic' && auth.username && auth.password) {
    const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  if (auth.type === 'header' && auth.headerName && auth.value) {
    return { [auth.headerName]: auth.value };
  }
  return {};
}

export async function getRegistriesForEcosystem(
  db: DataSource,
  ecosystem: string
): Promise<UpstreamRegistry[]> {
  return listEnabledUpstreams(db, ecosystem);
}

const USER_AGENT = 'depgate/0.1 (+https://depgate.local)';
/** First pause between attempts; doubles on each retry. */
const RETRY_BACKOFF_MS = 200;

/** Why an upstream call failed. undici hides the cause (ETIMEDOUT, EAI_AGAIN, ECONNRESET) behind "fetch failed". */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = (typeof cause?.message === 'string' && cause.message.trim()) || (typeof cause?.code === 'string' && cause.code) || '';
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message;
}

/** Release the connection of a response whose body is not read. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * GET an upstream URL. Transport errors (DNS, connect, reset) are retried up to `retryCount` times,
 * which is safe because nothing has reached the client yet. Any HTTP answer is returned as it is.
 * `timeoutMs` bounds the wait for response headers across every attempt; the body is not timed.
 */
export async function fetchUpstreamResponse(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; retryCount?: number } = {}
): Promise<Response> {
  const { headers = {}, timeoutMs = 30000, retryCount = 3 } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(deadline - Date.now(), 1));
    try {
      return await fetch(url, {
        // Some registries (e.g. crates.io) reject requests without a User-Agent.
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs} ms`, { cause: err });
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    const backoff = RETRY_BACKOFF_MS * 2 ** attempt;
    if (attempt >= retryCount || Date.now() + backoff >= deadline) break;
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(describeFetchError(lastError), { cause: lastError });
}

async function readJsonBody(res: Response): Promise<unknown> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    await discardBody(res);
    return {};
  }
  return res.json().catch(() => ({}));
}

export async function fetchWithRetry(
  url: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
    retryCount?: number;
    circuitKey?: string;
  } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const { headers = {}, timeoutMs = 30000, retryCount = 3, circuitKey } = opts;
  const cb = circuitKey ? getCircuitBreaker(circuitKey) : null;

  if (cb && !cb.canExecute()) {
    throw new Error(`Circuit breaker open for ${circuitKey}`);
  }

  let res: Response;
  try {
    res = await fetchUpstreamResponse(url, { headers: { Accept: 'application/json', ...headers }, timeoutMs, retryCount });
  } catch (err) {
    cb?.recordFailure();
    throw err;
  }
  cb?.recordSuccess();
  return { status: res.status, body: await readJsonBody(res), headers: res.headers };
}

/**
 * One request to one remote of a search, behind its circuit breaker: one breaker result per request,
 * however many attempts it took. A failure is an UpstreamUnavailableError (R1).
 */
async function requestRemote(
  db: DataSource,
  ecosystem: string,
  reg: RemoteTarget,
  url: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const breaker = getCircuitBreaker(`upstream:${reg.id}`);
  if (!breaker.canExecute()) throw unavailable(db, ecosystem, reg, 'circuit breaker open', breaker.retryAfterMs());
  try {
    const res = await fetchUpstreamResponse(url, {
      headers: { ...headers, ...buildAuthHeaders(parseAuth(reg)) },
      timeoutMs: reg.timeoutMs,
      retryCount: reg.retryCount,
    });
    breaker.recordSuccess();
    return res;
  } catch (err) {
    breaker.recordFailure();
    throw unavailable(db, ecosystem, reg, err instanceof Error ? err.message : String(err));
  }
}

/**
 * `route` is the only way to fetch a package: it carries the targets the internal namespace
 * rule left (see resolvePackageTargets). `targets` is for callers that already hold such a list.
 */
export type UpstreamFetchOptions = { basePath?: string; route?: Pick<PackageRoute, 'targets'>; targets?: RemoteTarget[] };

async function targetsForFetch(db: DataSource, ecosystem: string, opts?: UpstreamFetchOptions): Promise<RemoteTarget[]> {
  if (opts?.route) return opts.route.targets;
  if (opts?.targets) return opts.targets;
  const registries = await getRegistriesForEcosystem(db, ecosystem);
  return registries.map((reg) => ({
    id: reg.id,
    key: 'default',
    url: reg.url,
    timeoutMs: reg.timeoutMs,
    retryCount: reg.retryCount,
    authType: reg.authType,
    authEncrypted: reg.authEncrypted,
    source: 'public' as const,
  }));
}

export async function fetchFromUpstream(
  db: DataSource,
  ecosystem: string,
  path: string,
  opts?: UpstreamFetchOptions
): Promise<{ status: number; body: unknown; fromUrl: string; source?: RemoteTarget }> {
  const registries = await targetsForFetch(db, ecosystem, opts);
  if (registries.length === 0) {
    if (opts?.route || opts?.targets) {
      return { status: 404, body: {}, fromUrl: '' };
    }
    throw new Error(`No upstream registries configured for ecosystem: ${ecosystem}`);
  }

  // Only a 404 moves on to the next remote; any other failure stops the search (R1).
  let last404Url: string | null = null;
  for (const reg of registries) {
    const url = upstreamUrl(reg.url, path, opts?.basePath);
    const res = await requestRemote(db, ecosystem, reg, url, { Accept: 'application/json' });
    if (res.status === 404) {
      await discardBody(res);
      last404Url = url;
      continue;
    }
    return { status: res.status, body: await readJsonBody(res), fromUrl: url, source: reg };
  }
  return { status: 404, body: {}, fromUrl: last404Url ?? '' };
}

export type StreamResult = {
  status: number;
  headers: Headers;
  body: Readable;
  fromUrl: string;
  /** The remote that answered 200. */
  source?: RemoteTarget;
};

/** Fetch from upstream and return a Node.js Readable stream (for tarballs, etc.). Only a 200 carries a body. */
export async function fetchStreamFromUpstream(
  db: DataSource,
  ecosystem: string,
  path: string,
  opts?: UpstreamFetchOptions
): Promise<StreamResult> {
  const registries = await targetsForFetch(db, ecosystem, opts);
  if (registries.length === 0) {
    if (opts?.route || opts?.targets) {
      return { status: 404, headers: new Headers(), body: Readable.from([]), fromUrl: '' };
    }
    throw new Error(`No upstream registries configured for ecosystem: ${ecosystem}`);
  }

  // Only a 404 moves on to the next remote; any other failure stops the search (R1).
  let last404Url: string | null = null;
  for (const reg of registries) {
    const url = upstreamUrl(reg.url, path, opts?.basePath);
    const res = await requestRemote(db, ecosystem, reg, url);
    if (res.status === 404) {
      await discardBody(res);
      last404Url = url;
      continue;
    }
    if (res.status !== 200) {
      // No caller reads an error body; release the connection instead of holding it until GC.
      await discardBody(res);
      return { status: res.status, headers: res.headers, body: Readable.from([]), fromUrl: url, source: reg };
    }
    if (!res.body) throw unavailable(db, ecosystem, reg, 'no response body');
    return { status: res.status, headers: res.headers, body: Readable.fromWeb(res.body), fromUrl: url, source: reg };
  }
  return { status: 404, headers: new Headers(), body: Readable.from([]), fromUrl: last404Url ?? '' };
}

/**
 * Which remote would serve `path`: the first that does not answer 404, asked in order. Reads only
 * the response headers. A failure stops the search like a fetch does (R1). Null when every remote
 * answers 404. Used when a policy is scoped to one member of a virtual repository (R5); the fetch
 * that follows is then pinned to this remote, so the remote judged is the remote that serves.
 */
export async function probeServingRemote(
  db: DataSource,
  ecosystem: string,
  path: string,
  targets: RemoteTarget[],
  basePath = ''
): Promise<RemoteTarget | null> {
  for (const reg of targets) {
    const res = await requestRemote(db, ecosystem, reg, upstreamUrl(reg.url, path, basePath));
    await discardBody(res);
    if (res.status === 404) continue;
    return reg;
  }
  return null;
}
