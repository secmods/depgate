import { FastifyPluginAsync } from 'fastify';
import { canonicalRole, isHumanRole, ROLE_SECURITY } from '../auth/roles.js';
import { config } from '../config.js';
import { findUserByEmail, hashPassword, isValidEmail, normalizeEmail, verifyPassword } from '../services/auth.js';
import { findValidToken, issueToken, redeemToken, setPasswordUrl, signsInWithSsoOnly } from '../services/auth-tokens.js';
import { inviteMail, resetMail, sendMail } from '../services/mailer.js';
import { allowHit, failureCount, noteFailure } from '../services/rate-limit.js';
import { auditLoginFailure, auditLoginSuccess } from '../services/login-audit.js';
import { issueSessionTokens, recordLogin } from '../services/session-tokens.js';
import { queueAuthLinkEmail } from '../services/email-jobs.js';
import { learnPublicUrl } from '../services/public-url.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: { email?: string; password?: string };
  }>(
    '/api/auth/login',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              registryToken: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  role: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply.status(400).send({ error: 'email and password required' });
      }
      const typed = normalizeEmail(email).slice(0, 254);

      // Only failures count, so a busy office behind one address is never limited by its own sign-ins (§8.5).
      const ipKey = `login-fail:ip:${request.ip}`;
      const emailKey = `login-fail:email:${typed}`;
      const [ipFailures, emailFailures] = await Promise.all([
        failureCount(fastify.redis, ipKey),
        failureCount(fastify.redis, emailKey),
      ]);
      const { loginFailuresPerIp, loginFailuresPerEmail } = config.auth;
      if ((loginFailuresPerIp > 0 && ipFailures >= loginFailuresPerIp) || (loginFailuresPerEmail > 0 && emailFailures >= loginFailuresPerEmail)) {
        await auditLoginFailure(fastify, request, { email: typed, method: 'password', reason: 'rate_limited' });
        return reply.status(429).send({ error: 'Too many failed sign-ins. Try again in 15 minutes.' });
      }

      const fail = async (reason: 'no_account' | 'bad_password') => {
        await Promise.all([noteFailure(fastify.redis, ipKey, 900), noteFailure(fastify.redis, emailKey, 900)]);
        await auditLoginFailure(fastify, request, { email: typed, method: 'password', reason });
        return reply.status(401).send({ error: 'Invalid email or password' });
      };

      const user = await findUserByEmail(fastify.db, email);
      if (!user) return fail('no_account');

      // An invited account has no password yet and cannot sign in until the invitation is accepted.
      const valid = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
      if (!valid) return fail('bad_password');

      // Told only after the right password, so the message does not reveal which accounts exist.
      if (user.disabledAt) {
        await auditLoginFailure(fastify, request, { email: user.email, method: 'password', reason: 'user_disabled' });
        return reply.status(403).send({ error: 'This account is disabled. Ask your DepGate administrator.' });
      }
      if (signsInWithSsoOnly(user)) {
        await auditLoginFailure(fastify, request, { email: user.email, method: 'password', reason: 'sso_only' });
        return reply.status(403).send({ error: 'This account signs in with single sign-on.' });
      }

      const role = canonicalRole(user.role);
      if (!isHumanRole(role)) {
        return reply.status(403).send({ error: 'This account cannot sign in' });
      }

      // Remember where an admin reaches the UI, so emailed links point there without any setting.
      if (role === ROLE_SECURITY) await learnPublicUrl(fastify.db, request.headers.origin).catch(() => undefined);

      const session = await issueSessionTokens(fastify, user, { method: 'password' });
      await recordLogin(fastify, user.id, 'password', null);
      auditLoginSuccess(fastify, request, { email: user.email, userId: user.id, method: 'password', role, roleSource: 'configured' });
      return reply.send(session);
    }
  );

  /** Same answer whether or not the address has an account, so the form cannot be used to list users. */
  fastify.post<{ Body: { email?: string } }>(
    '/api/auth/forgot-password',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { message: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email ?? '');
      const answer = { message: 'If that address has an account, we have sent it a link.' };
      const { reqIp, userAgent } = getRequestContext(request);

      if (!isValidEmail(email)) return reply.send(answer);
      const ipOk = await allowHit(fastify.redis, `forgot:ip:${request.ip}`, 20, 3600);
      const emailOk = await allowHit(fastify.redis, `forgot:email:${email}`, 5, 3600);
      if (!ipOk || !emailOk) return reply.send(answer);

      const user = await findUserByEmail(fastify.db, email);
      if (!user) return reply.send(answer);
      if (signsInWithSsoOnly(user)) {
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester: user.email,
          ecosystem: 'auth',
          packageName: user.email,
          decision: 'PASSWORD_RESET_REQUESTED',
          conditionReasons: ['Email not sent: the account signs in with single sign-on'],
        });
        return reply.send(answer);
      }

      // Queued, so the answer never waits on SMTP and a transient failure is retried.
      if (await queueAuthLinkEmail(user.id)) {
        logAudit(fastify.db, {
          requesterIp: reqIp,
          userAgent,
          requester: user.email,
          ecosystem: 'auth',
          packageName: user.email,
          decision: 'PASSWORD_RESET_REQUESTED',
          conditionReasons: ['Email queued'],
        });
        return reply.send(answer);
      }

      // The queue is unavailable: send now, once. Someone who never accepted their invitation gets a fresh invitation instead of a reset.
      const invited = !user.passwordHash;
      const token = await issueToken(fastify.db, user.id, invited ? 'invite' : 'reset');
      const url = await setPasswordUrl(fastify.db, token);
      const mail = invited
        ? inviteMail(user.email, url, canonicalRole(user.role), config.auth.inviteExpiryHours)
        : resetMail(user.email, url, config.auth.resetExpiryMinutes);
      const sent = await sendMail(fastify.db, mail, fastify.log);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester: user.email,
        ecosystem: 'auth',
        packageName: user.email,
        decision: 'PASSWORD_RESET_REQUESTED',
        conditionReasons: [sent ? 'Email sent' : 'Email not sent: mail is not configured or failed'],
      });
      return reply.send(answer);
    }
  );

  /** Lets the set-password page show who the link is for before asking for a password. */
  fastify.get<{ Querystring: { token?: string } }>(
    '/api/auth/token-info',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        querystring: { type: 'object', properties: { token: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: { email: { type: 'string' }, purpose: { type: 'string', enum: ['invite', 'reset'] } },
          },
          404: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      if (!(await allowHit(fastify.redis, `token-info:ip:${request.ip}`, 60, 3600))) {
        return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
      }
      const found = await findValidToken(fastify.db, request.query?.token ?? '');
      if (!found) return reply.status(404).send({ error: 'This link is invalid or has expired' });
      return reply.send({ email: found.user.email, purpose: found.token.purpose });
    }
  );

  /** Accepts an invitation or completes a reset. The link is the proof of owning the address. */
  fastify.post<{ Body: { token?: string; password?: string } }>(
    '/api/auth/set-password',
    {
      schema: {
        tags: ['Auth'],
        security: [],
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: { token: { type: 'string' }, password: { type: 'string' } },
        },
        response: {
          200: { type: 'object', properties: { message: { type: 'string' } } },
          400: { type: 'object', properties: { error: { type: 'string' } } },
          429: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      if (!(await allowHit(fastify.redis, `set-password:ip:${request.ip}`, 30, 3600))) {
        return reply.status(429).send({ error: 'Too many attempts. Try again later.' });
      }
      const token = request.body?.token ?? '';
      const password = request.body?.password ?? '';
      if (password.length < 8 || password.length > 128) {
        return reply.status(400).send({ error: 'Password must be 8–128 characters' });
      }
      const found = await findValidToken(fastify.db, token);
      if (!found) return reply.status(400).send({ error: 'This link is invalid or has expired' });

      const user = await redeemToken(fastify.db, token, await hashPassword(password));
      if (!user) return reply.status(400).send({ error: 'This link is invalid or has expired' });

      const { reqIp, userAgent } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester: user.email,
        ecosystem: 'auth',
        packageName: user.email,
        decision: found.token.purpose === 'invite' ? 'INVITE_ACCEPTED' : 'PASSWORD_RESET',
      });
      return reply.send({ message: 'Password set' });
    }
  );
};

export default authRoutes;
