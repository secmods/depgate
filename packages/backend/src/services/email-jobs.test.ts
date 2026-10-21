import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

const mail = vi.hoisted(() => ({ configured: true, sent: [] as unknown[] }));
vi.mock('./mailer.js', async (orig) => ({
  ...(await orig<object>()),
  mailConfigured: vi.fn(async () => mail.configured),
  sendMailOrThrow: vi.fn(async (_db: unknown, message: unknown) => {
    mail.sent.push(message);
    return true;
  }),
}));
vi.mock('./auth-tokens.js', async (orig) => ({
  ...(await orig<object>()),
  issueToken: vi.fn(async () => 'fresh-token'),
  setPasswordUrl: vi.fn(async (_db: unknown, token: string) => `http://ui.test/set-password?token=${token}`),
}));
vi.mock('./audit-service.js', () => ({ logAudit: vi.fn() }));

import { registerEmailJobs } from './email-jobs.js';
import { handlerFor } from './jobs/queue.js';

function db(user: unknown): DataSource {
  return { getRepository: () => ({ findOne: async () => user }) } as unknown as DataSource;
}

const job = (data: Record<string, unknown>) => ({ data, attemptsMade: 0, opts: { attempts: 5 } }) as never;

describe('email jobs', () => {
  it('builds the reset link when it sends, so no token is ever in the queue', async () => {
    mail.sent = [];
    registerEmailJobs(db({ id: 'u1', email: 'ada@corp.test', passwordHash: 'x', role: 'User' }));
    const result = await handlerFor('email', 'send')!(job({ kind: 'auth-link', userId: 'u1' }));
    expect(result).toEqual({ sent: true });
    expect(mail.sent).toHaveLength(1);
    expect(JSON.stringify(mail.sent[0])).toContain('set-password?token=fresh-token');
    expect(JSON.stringify(mail.sent[0])).toContain('Reset');
  });

  it('a person who never accepted gets an invitation instead', async () => {
    mail.sent = [];
    registerEmailJobs(db({ id: 'u2', email: 'bob@corp.test', passwordHash: null, role: 'User' }));
    await handlerFor('email', 'send')!(job({ kind: 'auth-link', userId: 'u2' }));
    expect(JSON.stringify(mail.sent[0])).toContain('invited');
  });

  it('ends without sending for a deleted person or when mail is not configured', async () => {
    mail.sent = [];
    registerEmailJobs(db(null));
    expect(await handlerFor('email', 'send')!(job({ kind: 'auth-link', userId: 'gone' }))).toEqual({ skipped: 'Person deleted' });
    mail.configured = false;
    registerEmailJobs(db({ id: 'u3', email: 'c@corp.test', passwordHash: 'x', role: 'User' }));
    expect(await handlerFor('email', 'send')!(job({ kind: 'auth-link', userId: 'u3' }))).toEqual({ skipped: 'Mail is not configured' });
    mail.configured = true;
    expect(mail.sent).toHaveLength(0);
  });

  it('never sends a password link to an account created by single sign-on', async () => {
    mail.sent = [];
    registerEmailJobs(db({ id: 'u4', email: 'sso@corp.test', passwordHash: null, role: 'User', source: 'sso' }));
    expect(await handlerFor('email', 'send')!(job({ kind: 'auth-link', userId: 'u4' }))).toEqual({
      skipped: 'Account signs in with single sign-on',
    });
    expect(mail.sent).toHaveLength(0);
  });
});
