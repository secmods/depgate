import { AsyncLocalStorage } from 'node:async_hooks';
import { repoKeyFromRaw, type RepoTaggedRequest } from './repo-keys.js';

/**
 * The request being served, so code far from the route (the Decision Ledger writer) can read what
 * the route already knows, such as the repository key, without every call site passing it along.
 */
const requestStore = new AsyncLocalStorage<RepoTaggedRequest>();

export function runWithRequest<T>(raw: RepoTaggedRequest, fn: () => T): T {
  return requestStore.run(raw, fn);
}

/** The repository key of the current package request, or undefined outside one (admin calls, jobs). */
export function currentRepository(): string | undefined {
  const raw = requestStore.getStore();
  return raw ? repoKeyFromRaw(raw) : undefined;
}

export type ServedSource = { sourceRepository: string; sourceType: 'public' | 'internal' };

const servedBy = new WeakMap<object, ServedSource>();

/** Remember which remote served the current request, for its Decision Ledger row. */
export function noteServedSource(source: ServedSource): void {
  const raw = requestStore.getStore();
  if (raw) servedBy.set(raw, source);
}

export function currentServedSource(): ServedSource | undefined {
  const raw = requestStore.getStore();
  return raw ? servedBy.get(raw) : undefined;
}

const authMethodBy = new WeakMap<object, string>();

/** How the signed-in person of the current UI request signed in (password, oidc, saml). */
export function noteAuthMethod(raw: object, method: string): void {
  authMethodBy.set(raw, method);
}

export function currentAuthMethod(): string | undefined {
  const raw = requestStore.getStore();
  return raw ? authMethodBy.get(raw) : undefined;
}

/** Who caused an event (requirements_event_streaming.md §6.1 `actor`). */
export type EventActor = {
  kind: 'user' | 'api_key' | 'ci_token' | 'system' | 'anonymous';
  id?: string | null;
  name?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  authMethod?: string | null;
  /** The CI token or API key metadata, unchanged. */
  metadata?: Record<string, string> | null;
};

const actorBy = new WeakMap<object, EventActor>();

/** Remember the authenticated caller of a request, for every event it causes. */
export function noteActor(raw: object, actor: EventActor): void {
  actorBy.set(raw, actor);
}

/**
 * The caller of the current request: the authenticated actor, else anonymous with the request's address.
 * Undefined outside a request (jobs, startup). Read it before the first await.
 */
export function currentActor(): EventActor | undefined {
  const raw = requestStore.getStore() as (RepoTaggedRequest & { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) | undefined;
  if (!raw) return undefined;
  const known = actorBy.get(raw);
  if (known) return known;
  const ua = raw.headers?.['user-agent'];
  return { kind: 'anonymous', ip: raw.socket?.remoteAddress ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

/** What the policy engine learned about the current download (malware entry, exception), for its events. */
export type NotedDownload = {
  malware?: { id: string; source: 'feed' | 'custom'; reason: string | null; override: 'ALLOW' | 'BLOCK' };
  exception?: { id: string; reason: string | null };
};

const downloadBy = new WeakMap<object, NotedDownload>();

export function noteDownloadFacts(facts: NotedDownload): void {
  const raw = requestStore.getStore();
  if (raw) downloadBy.set(raw, facts);
}

export function currentDownloadFacts(): NotedDownload | undefined {
  const raw = requestStore.getStore();
  return raw ? downloadBy.get(raw) : undefined;
}
