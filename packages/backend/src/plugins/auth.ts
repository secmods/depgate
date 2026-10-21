import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { canonicalRole, ROLE_SECURITY, ROLE_USER, roleAllowed } from '../auth/roles.js';
import { config } from '../config.js';
import { findApiKey, isApiKey, touchApiKey } from '../services/auth.js';
import { CiToken } from '../db/entities/CiToken.js';
import { User } from '../db/entities/User.js';
import { readReference } from '../services/reference-cache.js';
import { tokenFromAuthorization } from '../services/request-auth.js';
import { noteActor, noteAuthMethod, type EventActor } from '../services/request-context.js';

export type AuthPayload = {
  sub: string;
  role: string;
  type: 'user' | 'registry' | 'apikey' | 'ci';
  /** Human-readable identifier: username for users, API key name or CI token name */
  username?: string;
  name?: string;
  metadata?: Record<string, string> | null;
  /** Session version the token was issued under (requirements_sso.md S3). Tokens from before it was added count as 0. */
  sv?: number;
  /** How the person signed in: password, oidc or saml. */
  amr?: string;
  /** Identity provider id, for single sign-on. */
  idp?: string;
};

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (opts?: { roles?: string[] }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Optional auth: validates token when present, does not fail when absent */
    authenticateOptional: (opts?: { roles?: string[] }) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function isSessionToken(type: AuthPayload['type']): boolean {
  return type === 'user' || type === 'registry';
}

/**
 * Package clients that read Basic credentials from their config (Maven, NuGet)
 * send them only after a 401 that names the scheme. API routes get no challenge,
 * so browsers do not open their own sign-in dialog.
 */
function unauthorized(req: FastifyRequest, reply: FastifyReply, error: string) {
  if (!req.url.startsWith('/api/')) reply.header('WWW-Authenticate', 'Basic realm="DepGate"');
  return reply.status(401).send({ error });
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(jwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.uiSessionExpiresIn },
  });

  const defaultRoles = [ROLE_USER, ROLE_SECURITY];

  async function ciUser(decoded: AuthPayload, allowedRoles: string[]): Promise<AuthPayload | 'invalid' | 'forbidden'> {
    if (decoded.type !== 'ci') return 'forbidden';
    if (canonicalRole(decoded.role) !== ROLE_USER || !roleAllowed(ROLE_USER, allowedRoles)) return 'forbidden';
    const row = await fastify.db.getRepository(CiToken).findOne({ where: { id: decoded.sub } });
    if (!row || row.revokedAt || new Date(row.expiresAt) < new Date()) return 'invalid';
    return {
      sub: row.id,
      role: ROLE_USER,
      type: 'ci',
      name: row.name,
      metadata: row.metadata ?? {},
    };
  }

  /**
   * A sign-in token outlives the account it was minted for. Users are cached like the policies
   * (re-read when one is added, removed, disabled or signed out everywhere, at most every few seconds),
   * so a deleted or disabled user, or a token from before "Sign out everywhere", is refused on the next
   * request without a database read per download.
   */
  async function sessionUserValid(decoded: AuthPayload): Promise<boolean> {
    if (!decoded.sub) return false;
    const states = await readReference('users', async () => {
      const rows = await fastify.db.getRepository(User).find({ select: { id: true, disabledAt: true, sessionVersion: true } });
      return new Map(rows.map((row) => [row.id, { disabled: row.disabledAt !== null, version: row.sessionVersion ?? 0 }]));
    });
    const state = states.get(decoded.sub);
    if (!state || state.disabled) return false;
    return (decoded.sv ?? 0) === state.version;
  }

  /** The caller as an event actor (requirements_event_streaming.md §6.1), for every event the request causes. */
  function actorOf(req: FastifyRequest, user: AuthPayload): EventActor {
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
    if (user.type === 'apikey') return { kind: 'api_key', id: user.sub, name: user.name ?? null, ip, userAgent, authMethod: 'api_key' };
    if (user.type === 'ci') {
      return { kind: 'ci_token', id: user.sub, name: user.name ?? null, ip, userAgent, authMethod: 'ci_token', metadata: user.metadata ?? null };
    }
    const authMethod = user.type === 'registry' ? 'registry_token' : (user.amr ?? 'password');
    return { kind: 'user', id: user.sub, name: user.username || user.name || null, ip, userAgent, authMethod };
  }

  function setUser(req: FastifyRequest, user: AuthPayload): void {
    req.user = user;
    noteActor(req.raw, actorOf(req, user));
  }

  /** The Decision Ledger records how an admin signed in on the events they cause (requirements_sso.md A3). */
  function rememberAuthMethod(req: FastifyRequest, decoded: AuthPayload): void {
    if (decoded.type === 'user') noteAuthMethod(req.raw, decoded.amr ?? 'password');
  }

  fastify.decorate('authenticate', (opts?: { roles?: string[] }) => {
    const allowedRoles = opts?.roles ?? defaultRoles;
    return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
      const token = tokenFromAuthorization(req.headers.authorization);
      if (!token) {
        return unauthorized(req, reply, 'Missing or invalid Authorization header');
      }

      if (isApiKey(token)) {
        const apiKey = await findApiKey(fastify.db, token);
        if (!apiKey) {
          return unauthorized(req, reply, 'Invalid API key');
        }
        if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
          return unauthorized(req, reply, 'API key expired');
        }
        if (!roleAllowed(apiKey.role, allowedRoles)) {
          return reply.status(403).send({ error: 'Insufficient permissions' });
        }
        touchApiKey(fastify.db, apiKey);
        setUser(req, { sub: apiKey.id, role: canonicalRole(apiKey.role), type: 'apikey', name: apiKey.name });
        return;
      }

      let decoded: AuthPayload;
      try {
        decoded = await fastify.jwt.verify<AuthPayload>(token);
      } catch {
        return unauthorized(req, reply, 'Invalid or expired token');
      }
      if (decoded.type === 'ci') {
        const user = await ciUser(decoded, allowedRoles);
        if (user === 'invalid') return unauthorized(req, reply, 'Invalid or expired token');
        if (user === 'forbidden') return reply.status(403).send({ error: 'Insufficient permissions' });
        setUser(req, user);
        return;
      }
      if (!isSessionToken(decoded.type) || !roleAllowed(decoded.role, allowedRoles)) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
      if (!(await sessionUserValid(decoded))) return unauthorized(req, reply, 'Invalid or expired token');
      rememberAuthMethod(req, decoded);
      setUser(req, { ...decoded, role: canonicalRole(decoded.role) });
    };
  });

  fastify.decorate('authenticateOptional', (opts?: { roles?: string[] }) => {
    const allowedRoles = opts?.roles ?? defaultRoles;
    return async function authenticateOptional(req: FastifyRequest, _reply: FastifyReply) {
      const token = tokenFromAuthorization(req.headers.authorization);
      if (!token) return;

      if (isApiKey(token)) {
        const apiKey = await findApiKey(fastify.db, token);
        if (!apiKey || (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date())) return;
        if (!roleAllowed(apiKey.role, allowedRoles)) return;
        touchApiKey(fastify.db, apiKey);
        setUser(req, { sub: apiKey.id, role: canonicalRole(apiKey.role), type: 'apikey', name: apiKey.name });
        return;
      }

      let decoded: AuthPayload;
      try {
        decoded = await fastify.jwt.verify<AuthPayload>(token);
      } catch {
        return;
      }
      if (decoded.type === 'ci') {
        const user = await ciUser(decoded, allowedRoles);
        if (typeof user !== 'string') setUser(req, user);
        return;
      }
      if (isSessionToken(decoded.type) && roleAllowed(decoded.role, allowedRoles) && (await sessionUserValid(decoded))) {
        rememberAuthMethod(req, decoded);
        setUser(req, { ...decoded, role: canonicalRole(decoded.role) });
      }
    };
  });

  return;
};

export default fp(authPlugin);
