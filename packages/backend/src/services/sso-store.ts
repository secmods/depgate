/**
 * Short-lived single sign-on state in Redis. Every value is read once and deleted in the same
 * command (GETDEL), so a state, handoff code or test ticket cannot be replayed (requirements_sso.md §8.1, S2).
 */
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import type { PendingLogin } from './sso-oidc.js';
import type { PendingSamlLogin } from './sso-saml.js';

const STATE_TTL_SECONDS = 600;
const HANDOFF_TTL_SECONDS = 60;
const TEST_TTL_SECONDS = 600;

export interface StoredLogin extends PendingLogin {
  providerId: string;
  /** Same-origin path to open after sign-in (R20). */
  returnTo: string | null;
  /** Set for the admin Test button: the outcome is stored under it instead of signing anyone in (R5). */
  testTicket: string | null;
}

export interface Handoff {
  token: string;
  registryToken: string;
  user: { email: string; role: string };
  returnTo: string | null;
}

export interface TestTicket {
  providerId: string;
  requestedBy: string;
}

export function randomCode(): string {
  return randomBytes(32).toString('base64url');
}

/** Codes are base64url of 32 random bytes; anything else is not looked up. */
function plausible(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(code);
}

async function put(redis: Redis, key: string, value: unknown, ttl: number): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttl);
}

async function takeOnce<T>(redis: Redis, key: string): Promise<T | null> {
  const raw = await redis.getdel(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function saveLoginState(redis: Redis, login: StoredLogin): Promise<void> {
  await put(redis, `sso:state:${login.state}`, login, STATE_TTL_SECONDS);
}

export async function takeLoginState(redis: Redis, state: unknown): Promise<StoredLogin | null> {
  if (!plausible(state)) return null;
  return takeOnce<StoredLogin>(redis, `sso:state:${state}`);
}

export interface StoredSamlLogin extends PendingSamlLogin {
  providerId: string;
  returnTo: string | null;
  testTicket: string | null;
}

/** Keyed by RelayState. The ACS takes it once, so the request it names is answered at most once (§8.2). */
export async function saveSamlLoginState(redis: Redis, login: StoredSamlLogin): Promise<void> {
  await put(redis, `sso:saml-state:${login.relayState}`, login, STATE_TTL_SECONDS);
}

export async function takeSamlLoginState(redis: Redis, relayState: unknown): Promise<StoredSamlLogin | null> {
  if (!plausible(relayState)) return null;
  return takeOnce<StoredSamlLogin>(redis, `sso:saml-state:${relayState}`);
}

/** Records an assertion ID until it expires. False when it was seen before: a replay (§8.2). */
export async function rememberSamlAssertion(redis: Redis, providerId: string, assertionId: string, ttlSeconds: number): Promise<boolean> {
  const key = `sso:saml-assertion:${providerId}:${createHash('sha256').update(assertionId).digest('base64url')}`;
  return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
}

/** The tokens wait here for the UI to collect them, so they never travel in a URL (S2). */
export async function saveHandoff(redis: Redis, handoff: Handoff): Promise<string> {
  const code = randomCode();
  await put(redis, `sso:handoff:${code}`, handoff, HANDOFF_TTL_SECONDS);
  return code;
}

export async function takeHandoff(redis: Redis, code: unknown): Promise<Handoff | null> {
  if (!plausible(code)) return null;
  return takeOnce<Handoff>(redis, `sso:handoff:${code}`);
}

export async function saveTestTicket(redis: Redis, ticket: TestTicket): Promise<string> {
  const code = randomCode();
  await put(redis, `sso:test-ticket:${code}`, ticket, TEST_TTL_SECONDS);
  return code;
}

export async function takeTestTicket(redis: Redis, code: unknown): Promise<TestTicket | null> {
  if (!plausible(code)) return null;
  return takeOnce<TestTicket>(redis, `sso:test-ticket:${code}`);
}

export async function saveTestResult(redis: Redis, ticket: string, result: unknown): Promise<void> {
  await put(redis, `sso:test-result:${ticket}`, result, TEST_TTL_SECONDS);
}

/** Read, not taken: the Settings page polls until it appears. */
export async function readTestResult(redis: Redis, ticket: unknown): Promise<unknown | null> {
  if (!plausible(ticket)) return null;
  const raw = await redis.get(`sso:test-result:${ticket}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
