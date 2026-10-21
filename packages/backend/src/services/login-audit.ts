import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { LoginMethod } from '../db/entities/User.js';
import { getRequestContext } from './audit-service.js';
import { recordEvent } from './events/record.js';
import { loginAuditDroppedTotal, loginsTotal } from './auth-metrics.js';
import { allowHit } from './rate-limit.js';
import { FAILURE_DESCRIPTIONS, type LoginFailureReason } from './sso-rules.js';

/** Shown as the package name of a failed sign-in whose email is not known (the provider never answered). */
export const UNKNOWN_EMAIL = '(unknown)';

interface ProviderRef {
  id: string;
  name: string;
}

function providerMetadata(provider?: ProviderRef | null): Record<string, string> {
  return provider ? { provider: provider.name, providerId: provider.id } : {};
}

/** SIGNIN_SUCCEEDED for every UI sign-in method (requirements_sso.md §9; D16: never for API keys or CI tokens). */
export function auditLoginSuccess(
  fastify: FastifyInstance,
  request: FastifyRequest,
  entry: {
    email: string;
    userId?: string | null;
    method: LoginMethod;
    provider?: ProviderRef | null;
    role: string;
    roleSource: 'configured' | 'provisioned';
  }
): void {
  loginsTotal.inc({ method: entry.method, result: 'success' });
  const { reqIp, userAgent } = getRequestContext(request);
  recordEvent(fastify.db, {
    type: 'SIGNIN_SUCCEEDED',
    actor: { kind: 'user', id: entry.userId ?? null, name: entry.email, ip: reqIp, userAgent, authMethod: entry.method },
    target: { kind: 'user', id: entry.userId ?? null, name: entry.email },
    summary: entry.provider
      ? `${entry.email} signed in with ${entry.provider.name} (${entry.method.toUpperCase()})`
      : `${entry.email} signed in with a password`,
    reasons: [entry.provider ? `Signed in with ${entry.provider.name} (${entry.method.toUpperCase()})` : 'Signed in with a password'],
    details: { method: entry.method, ...providerMetadata(entry.provider), role: entry.role, roleSource: entry.roleSource },
  });
}

/**
 * SIGNIN_FAILED. One IP gets at most LOGIN_FAILURE_AUDIT_PER_MINUTE events a minute, so guessing passwords
 * cannot flood the Audit Log (A1); the limit is well above any brute-force rule a SIEM would use.
 */
export async function auditLoginFailure(
  fastify: FastifyInstance,
  request: FastifyRequest,
  entry: { email?: string | null; method: LoginMethod; provider?: ProviderRef | null; reason: LoginFailureReason; detail?: string }
): Promise<void> {
  loginsTotal.inc({ method: entry.method, result: entry.reason });
  const { reqIp, userAgent } = getRequestContext(request);
  const cap = config.auth.loginFailureAuditPerMinute;
  if (cap > 0 && !(await allowHit(fastify.redis, `login-audit:${reqIp ?? 'unknown'}`, cap, 60))) {
    loginAuditDroppedTotal.inc({ method: entry.method });
    return;
  }
  const email = entry.email || UNKNOWN_EMAIL;
  const reasons = [FAILURE_DESCRIPTIONS[entry.reason]];
  if (entry.detail) reasons.push(entry.detail.slice(0, 500));
  recordEvent(fastify.db, {
    type: 'SIGNIN_FAILED',
    actor: { kind: 'anonymous', name: entry.email || null, ip: reqIp, userAgent, authMethod: entry.method },
    target: { kind: 'user', name: email },
    summary: `Sign-in failed for ${email}: ${reasons[0]}`,
    reasons,
    details: { method: entry.method, ...providerMetadata(entry.provider), reason: entry.reason },
  });
}
