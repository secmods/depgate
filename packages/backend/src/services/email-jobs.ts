import type { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { User } from '../db/entities/User.js';
import { canonicalRole } from '../auth/roles.js';
import { config } from '../config.js';
import { issueToken, setPasswordUrl, signsInWithSsoOnly } from './auth-tokens.js';
import { inviteMail, mailConfigured, resetMail, sendMailOrThrow } from './mailer.js';
import { logAudit } from './audit-service.js';
import { enqueue, registerHandler } from './jobs/queue.js';

/**
 * Password-reset email on the queue (requirements_job_queue.md §8.1). Job data holds the user ID
 * only: the link token is issued when the message is sent, so no token ever sits in Redis. Issuing
 * a token replaces the person's older one, so of two requests in a row only the newer link works.
 */

/** Queues the reset (or, for a person who never accepted, the invitation). False when the queue is unavailable. */
export async function queueAuthLinkEmail(userId: string): Promise<boolean> {
  return (await enqueue('email', 'send', { kind: 'auth-link', userId })) !== null;
}

export function registerEmailJobs(db: DataSource): void {
  registerHandler('email', 'send', async (job: Job) => {
    const { kind, userId } = job.data as { kind?: string; userId?: string };
    if (kind !== 'auth-link' || !userId) return { skipped: 'Unknown email kind' };
    const user = await db.getRepository(User).findOne({ where: { id: userId } });
    if (!user) return { skipped: 'Person deleted' };
    if (signsInWithSsoOnly(user)) return { skipped: 'Account signs in with single sign-on' };
    // Not configured is not a failure to retry: nothing will change until Security sets up mail.
    if (!(await mailConfigured(db))) return { skipped: 'Mail is not configured' };
    const invited = !user.passwordHash;
    const token = await issueToken(db, user.id, invited ? 'invite' : 'reset');
    const url = await setPasswordUrl(db, token);
    const mail = invited
      ? inviteMail(user.email, url, canonicalRole(user.role), config.auth.inviteExpiryHours)
      : resetMail(user.email, url, config.auth.resetExpiryMinutes);
    await sendMailOrThrow(db, mail);
    logAudit(db, {
      requester: user.email,
      ecosystem: 'auth',
      packageName: user.email,
      decision: 'PASSWORD_RESET_EMAIL_SENT',
      conditionReasons: [invited ? 'Invitation email sent' : 'Reset email sent', `Attempt ${job.attemptsMade + 1}`],
    });
    return { sent: true };
  });
}
