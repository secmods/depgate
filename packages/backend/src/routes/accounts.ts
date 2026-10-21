import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { HUMAN_ROLES, ROLE_SECURITY, ROLE_SERVICE, canonicalRole, userDeletionBlock, type HumanRole } from '../auth/roles.js';
import { ApiKey } from '../db/entities/ApiKey.js';
import { User } from '../db/entities/User.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { SsoProvider } from '../db/entities/SsoProvider.js';
import { In, IsNull, MoreThan } from 'typeorm';
import { WaiverRequest } from '../db/entities/WaiverRequest.js';
import { generateApiKey, hashApiKey, isValidEmail, normalizeEmail } from '../services/auth.js';
import { AuthToken } from '../db/entities/AuthToken.js';
import { issueToken, setPasswordUrl, signsInWithSsoOnly } from '../services/auth-tokens.js';
import { config } from '../config.js';
import { learnPublicUrl } from '../services/public-url.js';
import { inviteMail, mailConfigured, resetMail, sendMail } from '../services/mailer.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';

const ACCOUNT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,127}$/;

type PageQuery = { limit?: string; offset?: string; search?: string };

const pageQuerySchema = {
  type: 'object',
  properties: { limit: { type: 'string' }, offset: { type: 'string' }, search: { type: 'string' } },
} as const;

function pageOf(query: PageQuery): { limit: number; offset: number; search: string } {
  return {
    limit: Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 200),
    offset: Math.max(parseInt(query.offset ?? '0', 10) || 0, 0),
    search: (query.search ?? '').trim().slice(0, 254),
  };
}

type UserQuery = PageQuery & { source?: 'local' | 'sso'; role?: HumanRole; status?: 'active' | 'invited' | 'disabled' };

/** The values a role may still be stored as; `canonicalRole` maps the older names. */
function storedRoles(role: HumanRole): string[] {
  return role === ROLE_SECURITY ? [ROLE_SECURITY, 'Admin'] : [role, 'Viewer'];
}

/** `%` and `_` in a search match themselves, not any text. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function requestUser(request: { user?: unknown }): { sub?: string; username?: string; name?: string } | undefined {
  const user = request.user;
  if (!user || typeof user !== 'object') return undefined;
  return user as { sub?: string; username?: string; name?: string };
}

const accountsRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });

  const userSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      status: { type: 'string', enum: ['invited', 'active', 'disabled'] },
      role: { type: 'string', enum: [...HUMAN_ROLES] },
      source: { type: 'string', enum: ['local', 'sso'] },
      /** An invitation link is outstanding. */
      invitePending: { type: 'boolean' },
      hasPassword: { type: 'boolean' },
      /** "Password" and the name of each identity provider the person has signed in with. */
      signInMethods: { type: 'array', items: { type: 'string' } },
      lastLoginAt: { type: 'string', nullable: true },
      lastLoginMethod: { type: 'string', nullable: true },
      lastLoginProvider: { type: 'string', nullable: true },
      createdAt: { type: 'string' },
    },
  } as const;

  /** Users & Access rows (requirements_sso.md R17). Never includes a password hash. */
  async function userViews(users: User[]) {
    const ids = users.map((user) => user.id);
    if (ids.length === 0) return [];
    const [identities, providers, invites] = await Promise.all([
      fastify.db.getRepository(UserIdentity).find({ where: { userId: In(ids) } }),
      fastify.db.getRepository(SsoProvider).find({ select: { id: true, name: true } }),
      fastify.db.getRepository(AuthToken).find({
        where: { userId: In(ids), purpose: 'invite', expiresAt: MoreThan(new Date()) },
        select: { userId: true },
      }),
    ]);
    const providerName = new Map(providers.map((provider) => [provider.id, provider.name]));
    const invited = new Set(invites.map((row) => row.userId));
    return users.map((user) => {
      const methods = user.passwordHash ? ['Password'] : [];
      for (const identity of identities) {
        if (identity.userId === user.id) methods.push(providerName.get(identity.providerId) ?? 'Removed provider');
      }
      return {
        id: user.id,
        email: user.email,
        status: user.disabledAt ? 'disabled' : user.passwordHash || user.lastLoginAt ? 'active' : 'invited',
        role: canonicalRole(user.role),
        source: user.source ?? 'local',
        invitePending: invited.has(user.id),
        hasPassword: Boolean(user.passwordHash),
        signInMethods: methods,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        lastLoginMethod: user.lastLoginMethod ?? null,
        lastLoginProvider: user.lastLoginProviderId ? (providerName.get(user.lastLoginProviderId) ?? null) : null,
        createdAt: user.createdAt.toISOString(),
      };
    });
  }

  fastify.get<{ Querystring: UserQuery }>(
    '/api/admin/users',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        description:
          'People, by email. Paged: limit (1–200, default 50) and offset; search matches part of the email. ' +
          'Filters: source (local | sso), role (User | Security), status (active | invited | disabled).',
        querystring: {
          type: 'object',
          properties: {
            ...pageQuerySchema.properties,
            source: { type: 'string', enum: ['local', 'sso'] },
            role: { type: 'string', enum: [...HUMAN_ROLES] },
            status: { type: 'string', enum: ['active', 'invited', 'disabled'] },
          },
        },
        response: { 200: { type: 'object', properties: { items: { type: 'array', items: userSchema }, total: { type: 'number' } } } },
      },
    },
    async (request, reply) => {
      const { limit, offset, search } = pageOf(request.query);
      const { source, role, status } = request.query;
      const qb = fastify.db.getRepository(User).createQueryBuilder('u').orderBy('u.email', 'ASC').skip(offset).take(limit);
      if (search) qb.andWhere(`u.email ILIKE :search ESCAPE '\\'`, { search: `%${escapeLike(search)}%` });
      if (source) qb.andWhere('u.source = :source', { source });
      if (role) qb.andWhere('u.role IN (:...roles)', { roles: storedRoles(role) });
      // Same rules as `status` in userViews.
      if (status === 'disabled') qb.andWhere('u.disabledAt IS NOT NULL');
      if (status === 'active') qb.andWhere('u.disabledAt IS NULL AND (u.passwordHash IS NOT NULL OR u.lastLoginAt IS NOT NULL)');
      if (status === 'invited') qb.andWhere('u.disabledAt IS NULL AND u.passwordHash IS NULL AND u.lastLoginAt IS NULL');
      const [users, total] = await qb.getManyAndCount();
      return reply.send({ items: await userViews(users), total });
    }
  );

  const inviteResponse = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      status: { type: 'string' },
      role: { type: 'string' },
      createdAt: { type: 'string' },
      emailSent: { type: 'boolean' },
      /** False when the admin chose not to send a password invitation (the person signs in with SSO). */
      invited: { type: 'boolean' },
      /** Only present when the email could not be sent, so the admin can pass the link on. */
      inviteUrl: { type: 'string' },
    },
  };

  /** Issues a fresh invitation link and mails it. The admin never sees a password, only a link when mail is unavailable. */
  async function invite(user: User) {
    const token = await issueToken(fastify.db, user.id, 'invite');
    const url = await setPasswordUrl(fastify.db, token);
    const emailSent = await sendMail(fastify.db, inviteMail(user.email, url, user.role, config.auth.inviteExpiryHours), fastify.log);
    return {
      id: user.id,
      email: user.email,
      status: 'invited' as const,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      emailSent,
      invited: true,
      ...(emailSent ? {} : { inviteUrl: url }),
    };
  }

  fastify.post<{ Body: { email?: string; role?: string; sendInvite?: boolean } }>(
    '/api/admin/users',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['email', 'role'],
          properties: {
            email: { type: 'string' },
            role: { type: 'string', enum: [...HUMAN_ROLES] },
            sendInvite: {
              type: 'boolean',
              description: 'Default true. False adds the person without a password invitation, for single sign-on.',
            },
          },
        },
        response: { 201: inviteResponse },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email ?? '');
      const role = request.body?.role;
      if (!isValidEmail(email)) {
        return reply.status(400).send({ error: 'Enter a valid email address' });
      }
      if (!role || !HUMAN_ROLES.includes(role as HumanRole)) {
        return reply.status(400).send({ error: 'role must be User or Security' });
      }

      const repo = fastify.db.getRepository(User);
      const existing = await repo.findOne({ where: { email } });
      if (existing) return reply.status(409).send({ error: 'Email already exists' });

      await learnPublicUrl(fastify.db, request.headers.origin);
      const saved = await repo.save(repo.create({ email, passwordHash: null, role: role as HumanRole }));
      const result =
        request.body?.sendInvite === false
          ? {
              id: saved.id,
              email: saved.email,
              status: 'invited' as const,
              role: saved.role,
              createdAt: saved.createdAt.toISOString(),
              emailSent: false,
              invited: false,
            }
          : await invite(saved);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'user',
        packageName: saved.email,
        resolvedVersion: saved.role,
        decision: 'USER_CREATED',
        conditionReasons: [
          !result.invited
            ? 'No password invitation: signs in with single sign-on'
            : result.emailSent
              ? 'Invitation emailed'
              : 'Invitation not emailed: link shown to admin',
        ],
      });
      return reply.status(201).send(result);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/resend-invite',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        response: { 200: inviteResponse },
      },
    },
    async (request, reply) => {
      const user = await fastify.db.getRepository(User).findOne({ where: { id: request.params.id } });
      if (!user) return reply.status(404).send({ error: 'User not found' });
      if (signsInWithSsoOnly(user)) return reply.status(409).send({ error: 'This user signs in with single sign-on and has no password' });
      if (user.passwordHash) return reply.status(409).send({ error: 'This user has already set a password' });
      const result = await invite(user);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'user',
        packageName: user.email,
        resolvedVersion: user.role,
        decision: 'INVITE_RESENT',
        conditionReasons: [result.emailSent ? 'Invitation emailed' : 'Invitation not emailed: link shown to admin'],
      });
      return reply.send(result);
    }
  );

  /**
   * Emails a password-reset link to someone who already has a password. Unlike an invitation, the
   * link is never shown to the admin: with it, the admin could set the password and sign in as them.
   * The current password keeps working until the link is used.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/send-reset',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        response: { 200: { type: 'object', properties: { sentTo: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const user = await fastify.db.getRepository(User).findOne({ where: { id: request.params.id } });
      if (!user) return reply.status(404).send({ error: 'User not found' });
      if (signsInWithSsoOnly(user)) return reply.status(409).send({ error: 'This user signs in with single sign-on and has no password' });
      if (!user.passwordHash) return reply.status(409).send({ error: 'This user has no password yet; send an invitation instead' });
      if (user.disabledAt) return reply.status(409).send({ error: 'This user is disabled' });
      if (!(await mailConfigured(fastify.db))) {
        return reply.status(409).send({ error: 'Email is not set up. Configure it under Settings → Email first.' });
      }

      await learnPublicUrl(fastify.db, request.headers.origin);
      const token = await issueToken(fastify.db, user.id, 'reset');
      const url = await setPasswordUrl(fastify.db, token);
      const sent = await sendMail(fastify.db, resetMail(user.email, url, config.auth.resetExpiryMinutes), fastify.log);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'auth',
        packageName: user.email,
        decision: 'PASSWORD_RESET_REQUESTED',
        conditionReasons: [sent ? 'Reset email sent by an admin' : 'Email not sent: sending failed'],
      });
      if (!sent) {
        await fastify.db.getRepository(AuthToken).delete({ userId: user.id });
        return reply.status(502).send({ error: 'The reset email could not be sent. Check the email settings and try again.' });
      }
      return reply.send({ sentTo: user.email });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/users/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const repo = fastify.db.getRepository(User);
      const user = await repo.findOne({ where: { id } });
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const securityCount = user.role === ROLE_SECURITY ? await repo.count({ where: { role: ROLE_SECURITY } }) : 0;
      const blocked = userDeletionBlock(requestUser(request)?.sub, user, securityCount);
      if (blocked) return reply.status(400).send({ error: blocked });

      await fastify.db.getRepository(AuthToken).delete({ userId: id });
      await fastify.db.getRepository(UserIdentity).delete({ userId: id });
      await repo.remove(user);
      // A deleted requester can no longer be told the outcome, so their open requests are closed.
      await fastify.db.getRepository(WaiverRequest).update(
        { requestedById: id, status: 'pending' },
        { status: 'rejected', reviewedBy: requestUser(request)?.username ?? 'system', reviewNote: 'Requester was deleted', reviewedAt: new Date() }
      );
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'user',
        packageName: user.email,
        resolvedVersion: user.role,
        decision: 'USER_DELETED',
      });
      return reply.status(204).send();
    }
  );

  /** Security users who can still sign in. Demoting or disabling the last one would lock everyone out. */
  async function activeSecurityCount(): Promise<number> {
    return fastify.db.getRepository(User).count({ where: { role: ROLE_SECURITY, disabledAt: IsNull() } });
  }

  function auditUser(request: Parameters<typeof getRequestContext>[0], decision: string, user: User, reasons: string[], metadata?: Record<string, string>) {
    const { reqIp, userAgent, requester } = getRequestContext(request);
    logAudit(fastify.db, {
      requesterIp: reqIp,
      userAgent,
      requester,
      ecosystem: 'user',
      packageName: user.email,
      resolvedVersion: canonicalRole(user.role),
      repository: null,
      decision,
      conditionReasons: reasons,
      metadata: metadata ?? null,
    });
  }

  fastify.patch<{ Params: { id: string }; Body: { role?: string; disabled?: boolean } }>(
    '/api/admin/users/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        description:
          "Changes a user's role, or disables or enables the account (requirements_sso.md R15, R16). Either change signs the user out everywhere.",
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: [...HUMAN_ROLES] },
            disabled: { type: 'boolean' },
          },
        },
        response: { 200: userSchema, 400: { type: 'object', properties: { error: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const repo = fastify.db.getRepository(User);
      const user = await repo.findOne({ where: { id: request.params.id } });
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const fromRole = canonicalRole(user.role);
      const toRole = request.body.role ?? fromRole;
      if (!HUMAN_ROLES.includes(toRole as HumanRole)) return reply.status(400).send({ error: 'role must be User or Security' });
      const wasDisabled = user.disabledAt !== null;
      const disable = request.body.disabled ?? wasDisabled;
      const roleChanged = toRole !== fromRole;
      const disabledChanged = disable !== wasDisabled;
      if (!roleChanged && !disabledChanged) return reply.send((await userViews([user]))[0]);

      if (requestUser(request)?.sub === user.id) {
        return reply.status(400).send({ error: 'You cannot change your own role or disable yourself. Ask another Security user.' });
      }
      const losesSecurity = fromRole === ROLE_SECURITY && !wasDisabled && (toRole !== ROLE_SECURITY || disable);
      if (losesSecurity && (await activeSecurityCount()) <= 1) {
        return reply.status(400).send({ error: 'At least one Security user who can sign in is required' });
      }

      user.role = toRole as HumanRole;
      user.disabledAt = disable ? (user.disabledAt ?? new Date()) : null;
      // Old tokens carry the old role, and a disabled user must lose access now (S3).
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
      const saved = await repo.save(user);

      if (roleChanged) {
        auditUser(request, 'USER_ROLE_CHANGED', saved, [`${fromRole} → ${toRole}`, 'Signed out everywhere'], { from: fromRole, to: toRole });
      }
      if (disabledChanged) {
        auditUser(request, disable ? 'USER_DISABLED' : 'USER_ENABLED', saved, [
          disable ? 'Cannot sign in by any method; signed out everywhere' : 'Can sign in again',
        ]);
      }
      return reply.send((await userViews([saved]))[0]);
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/admin/users/:id/revoke-sessions',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Users'],
        description: 'Sign out everywhere: every UI session and registry token of the user stops working (requirements_sso.md S3).',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const repo = fastify.db.getRepository(User);
      const user = await repo.findOne({ where: { id: request.params.id } });
      if (!user) return reply.status(404).send({ error: 'User not found' });
      user.sessionVersion = (user.sessionVersion ?? 0) + 1;
      await repo.save(user);
      auditUser(request, 'SESSIONS_REVOKED', user, ['Every UI session and registry token stopped working']);
      return reply.status(204).send();
    }
  );

  fastify.get<{ Querystring: PageQuery }>(
    '/api/admin/service-accounts',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Service accounts'],
        description: 'Service accounts, newest first. Paged: limit (1–200, default 50) and offset; search matches part of the name.',
        querystring: pageQuerySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              total: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    expiresAt: { type: 'string', nullable: true },
                    lastUsedAt: { type: 'string', nullable: true },
                    createdAt: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { limit, offset, search } = pageOf(request.query);
      const qb = fastify.db
        .getRepository(ApiKey)
        .createQueryBuilder('k')
        .where('k.role = :role', { role: ROLE_SERVICE })
        .orderBy('k.createdAt', 'DESC')
        .skip(offset)
        .take(limit);
      if (search) qb.andWhere(`k.name ILIKE :search ESCAPE '\\'`, { search: `%${escapeLike(search)}%` });
      const [keys, total] = await qb.getManyAndCount();
      return reply.send({
        total,
        items: keys.map((key) => ({
          id: key.id,
          name: key.name,
          expiresAt: key.expiresAt?.toISOString() ?? null,
          lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
          createdAt: key.createdAt.toISOString(),
        })),
      });
    }
  );

  fastify.post<{ Body: { name?: string } }>(
    '/api/admin/service-accounts',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Service accounts'],
        body: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          201: {
            type: 'object',
            required: ['id', 'name', 'key'],
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              key: { type: 'string', description: 'Shown only once. Mints CI tokens. Cannot sign in.' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const name = request.body?.name?.trim() ?? '';
      if (!ACCOUNT_NAME.test(name)) {
        return reply.status(400).send({ error: 'Name must be 1–128 characters and use letters, numbers, spaces, ., _, or -' });
      }

      const plainKey = generateApiKey();
      const repo = fastify.db.getRepository(ApiKey);
      const saved = await repo.save(
        repo.create({
          keyHash: hashApiKey(plainKey),
          name,
          role: ROLE_SERVICE,
          namespace: null,
          expiresAt: null,
        })
      );
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'service_account',
        packageName: saved.name,
        decision: 'SERVICE_ACCOUNT_CREATED',
      });
      return reply.status(201).send({ id: saved.id, name: saved.name, key: plainKey });
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/admin/service-accounts/:id',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Service accounts'],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const repo = fastify.db.getRepository(ApiKey);
      const key = await repo.findOne({ where: { id: request.params.id, role: ROLE_SERVICE } });
      if (!key) return reply.status(404).send({ error: 'Service account not found' });
      await repo.remove(key);
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'service_account',
        packageName: key.name,
        decision: 'SERVICE_ACCOUNT_REVOKED',
      });
      return reply.status(204).send();
    }
  );
};

export default fp(accountsRoutes);
