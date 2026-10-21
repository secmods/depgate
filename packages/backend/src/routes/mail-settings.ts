import fp from 'fastify-plugin';
import { FastifyPluginAsync } from 'fastify';
import { ROLE_SECURITY } from '../auth/roles.js';
import { config } from '../config.js';
import { User } from '../db/entities/User.js';
import { effectiveMailServer, loadMailSettings, saveMailSettings } from '../services/mail-settings.js';
import { sendMailOrThrow, testMail } from '../services/mailer.js';
import { logAudit, getRequestContext } from '../services/audit-service.js';

const HOST = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;

const view = {
  type: 'object',
  properties: {
    host: { type: 'string' },
    port: { type: 'integer' },
    secure: { type: 'boolean' },
    user: { type: 'string' },
    hasPassword: { type: 'boolean' },
    from: { type: 'string' },
    /** 'ui' when saved here, 'environment' when read from SMTP_* variables, 'none' when mail is off. */
    source: { type: 'string', enum: ['ui', 'environment', 'none'] },
  },
};

const mailSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  const requireSecurity = fastify.authenticate({ roles: [ROLE_SECURITY] });

  async function current() {
    const row = await loadMailSettings(fastify.db);
    if (row?.host) {
      return {
        host: row.host,
        port: row.port,
        secure: row.secure,
        user: row.user,
        hasPassword: row.passwordEnc !== '',
        from: row.fromAddress,
        source: 'ui' as const,
      };
    }
    if (config.mail.host) {
      return {
        host: config.mail.host,
        port: config.mail.port,
        secure: config.mail.secure,
        user: config.mail.user,
        hasPassword: config.mail.password !== '',
        from: config.mail.from,
        source: 'environment' as const,
      };
    }
    return { host: '', port: 587, secure: false, user: '', hasPassword: false, from: '', source: 'none' as const };
  }

  fastify.get(
    '/api/admin/mail-settings',
    { onRequest: [requireSecurity], schema: { tags: ['Mail'], response: { 200: view } } },
    async (_request, reply) => reply.send(await current())
  );

  fastify.put<{
    Body: { host?: string; port?: number; secure?: boolean; user?: string; password?: string; from?: string};
  }>(
    '/api/admin/mail-settings',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Mail'],
        body: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'integer' },
            secure: { type: 'boolean' },
            user: { type: 'string' },
            password: { type: 'string' },
            from: { type: 'string' },
          },
        },
        response: { 200: view },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const host = (body.host ?? '').trim();
      const port = body.port ?? 587;
      if (host !== '' && !HOST.test(host)) return reply.status(400).send({ error: 'Enter a valid SMTP host name' });
      if (port < 1 || port > 65535) return reply.status(400).send({ error: 'Port must be between 1 and 65535' });
      const from = (body.from ?? '').trim();
      if (host !== '' && from === '') return reply.status(400).send({ error: 'Enter the From address' });

      await saveMailSettings(fastify.db, {
        host,
        port,
        secure: body.secure ?? false,
        user: (body.user ?? '').trim(),
        fromAddress: from,
        // Omitted keeps the saved password; an empty string clears it.
        password: body.password,
      });
      const { reqIp, userAgent, requester } = getRequestContext(request);
      logAudit(fastify.db, {
        requesterIp: reqIp,
        userAgent,
        requester,
        ecosystem: 'settings',
        packageName: 'mail',
        decision: 'MAIL_SETTINGS_UPDATED',
        conditionReasons: [host === '' ? 'SMTP host cleared' : `SMTP host set to ${host}`],
      });
      return reply.send(await current());
    }
  );

  /** Sends to the signed-in admin's own address, so the test cannot be aimed at someone else. */
  fastify.post(
    '/api/admin/mail-settings/test',
    {
      onRequest: [requireSecurity],
      schema: {
        tags: ['Mail'],
        response: {
          200: { type: 'object', properties: { sentTo: { type: 'string' } } },
          400: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
    async (request, reply) => {
      const sub = (request.user as { sub?: string } | undefined)?.sub;
      const user = sub ? await fastify.db.getRepository(User).findOne({ where: { id: sub } }) : null;
      if (!user) return reply.status(400).send({ error: 'Sign in as a user to send a test email' });
      if (!(await effectiveMailServer(fastify.db))) return reply.status(400).send({ error: 'Save an SMTP host first' });
      try {
        await sendMailOrThrow(fastify.db, testMail(user.email));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Send failed';
        return reply.status(400).send({ error: `Could not send: ${message}` });
      }
      return reply.send({ sentTo: user.email });
    }
  );
};

export default fp(mailSettingsRoutes);
