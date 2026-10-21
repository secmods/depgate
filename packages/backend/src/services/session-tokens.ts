import type { FastifyInstance } from 'fastify';
import { canonicalRole } from '../auth/roles.js';
import { config } from '../config.js';
import { User, type LoginMethod } from '../db/entities/User.js';
import { bumpReference } from './reference-cache.js';
import { getSessionTokenDays } from './gateway-config.js';

export interface SessionTokens {
  token: string;
  registryToken: string;
  user: { email: string; role: string };
}

/**
 * The UI token and the registry token, the same for every sign-in method (requirements_sso.md S1).
 * `sv` ties both to the user's session version, so raising it ends them (S3). `amr` and `idp` record how
 * the person signed in.
 */
export async function issueSessionTokens(
  fastify: FastifyInstance,
  user: User,
  login: { method: LoginMethod; providerId?: string }
): Promise<SessionTokens> {
  const role = canonicalRole(user.role);
  const sessionTokenDays = await getSessionTokenDays(fastify.db);
  const claims = {
    sub: user.id,
    role,
    username: user.email,
    sv: user.sessionVersion ?? 0,
    amr: login.method,
    ...(login.providerId ? { idp: login.providerId } : {}),
  };
  const token = fastify.jwt.sign({ ...claims, type: 'user' as const }, { expiresIn: config.auth.uiSessionExpiresIn });
  const registryToken = fastify.jwt.sign({ ...claims, type: 'registry' as const }, { expiresIn: `${sessionTokenDays}d` });
  return { token, registryToken, user: { email: user.email, role } };
}

/**
 * Last sign-in time and method. A query-builder update, so it does not reload the cached users on
 * every replica: sign-ins are frequent and the cache does not hold these columns.
 */
export async function recordLogin(fastify: FastifyInstance, userId: string, method: LoginMethod, providerId: string | null): Promise<void> {
  await fastify.db
    .createQueryBuilder()
    .update(User)
    .set({ lastLoginAt: () => 'now()', lastLoginMethod: method, lastLoginProviderId: providerId })
    .where('id = :id', { id: userId })
    .callListeners(false)
    .execute()
    .catch(() => undefined);
}

/** Ends every session of the user: UI and registry tokens issued before now stop working (S3). */
export async function bumpSessionVersion(fastify: FastifyInstance, userId: string): Promise<void> {
  await fastify.db.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [userId]);
  await bumpReference('users');
}
