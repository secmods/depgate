/**
 * Who a validated single sign-on becomes in DepGate (requirements_sso.md R11). The identity provider
 * proves the email; the role always comes from Users & Access. Single sign-on never grants Security.
 */
import { DataSource, QueryFailedError } from 'typeorm';
import { ROLE_USER } from '../auth/roles.js';
import { User } from '../db/entities/User.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { normalizeEmail } from './auth.js';
import type { LoginFailureReason } from './sso-rules.js';

export interface SsoAccount {
  providerId: string;
  subject: string;
  /** Normalized, from the checked claims. */
  email: string;
}

export type SsoPlan =
  /** Signed in with this provider account before. */
  | { kind: 'linked'; user: User; identity: UserIdentity }
  /** First sign-in with this provider for someone already in Users & Access. */
  | { kind: 'link'; user: User }
  /** Not in Users & Access; unlisted people may sign in, so a User account is created. */
  | { kind: 'create' }
  | { kind: 'deny'; reason: LoginFailureReason; detail: string; user?: User };

/** Decides without writing anything, so the provider Test button can show the outcome (R5). */
export async function planSsoSignIn(db: DataSource, account: SsoAccount, allowUnlisted: boolean): Promise<SsoPlan> {
  const identities = db.getRepository(UserIdentity);
  const users = db.getRepository(User);

  const identity = await identities.findOne({ where: { providerId: account.providerId, subject: account.subject } });
  if (identity) {
    const user = await users.findOne({ where: { id: identity.userId } });
    if (user) {
      if (user.disabledAt) return { kind: 'deny', reason: 'user_disabled', detail: `${user.email} is disabled`, user };
      return { kind: 'linked', user, identity };
    }
    // The user was deleted and the link left behind (identities are not foreign-keyed). Treat as new.
    await identities.delete({ id: identity.id });
  }

  const user = await users.findOne({ where: { email: normalizeEmail(account.email) } });
  if (user) {
    const other = await identities.findOne({ where: { userId: user.id, providerId: account.providerId } });
    // A concurrent first sign-in of the same person linked this subject since the lookup above.
    if (other && other.subject === account.subject) {
      if (user.disabledAt) return { kind: 'deny', reason: 'user_disabled', detail: `${user.email} is disabled`, user };
      return { kind: 'linked', user, identity: other };
    }
    if (other) {
      return {
        kind: 'deny',
        reason: 'subject_mismatch',
        detail: `${user.email} is linked to another account (subject ${other.subject}) at this provider; this one is ${account.subject}`,
        user,
      };
    }
    if (user.disabledAt) return { kind: 'deny', reason: 'user_disabled', detail: `${user.email} is disabled`, user };
    return { kind: 'link', user };
  }

  if (!allowUnlisted) {
    return { kind: 'deny', reason: 'not_invited', detail: `${account.email} is not in Users & Access` };
  }
  return { kind: 'create' };
}

export interface SsoSignInResult {
  user: User;
  created: boolean;
  linked: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof QueryFailedError && (err as QueryFailedError & { driverError?: { code?: string } }).driverError?.code === '23505';
}

/**
 * Carries out a plan. Two first sign-ins racing for the same person meet a unique index; the loser
 * plans again and finds what the winner wrote.
 */
export async function applySsoSignIn(
  db: DataSource,
  account: SsoAccount,
  allowUnlisted: boolean,
  plan?: SsoPlan
): Promise<SsoSignInResult | { denied: Extract<SsoPlan, { kind: 'deny' }> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = attempt === 0 && plan ? plan : await planSsoSignIn(db, account, allowUnlisted);
    try {
      switch (current.kind) {
        case 'deny':
          return { denied: current };
        case 'linked':
          await db.getRepository(UserIdentity).update({ id: current.identity.id }, { lastUsedAt: new Date() });
          return { user: current.user, created: false, linked: false };
        case 'link':
          await db.getRepository(UserIdentity).insert({
            userId: current.user.id,
            providerId: account.providerId,
            subject: account.subject,
            emailAtLink: account.email,
            lastUsedAt: new Date(),
          });
          return { user: current.user, created: false, linked: true };
        case 'create': {
          const user = await db.transaction(async (tx) => {
            const repo = tx.getRepository(User);
            const saved = await repo.save(
              repo.create({ email: normalizeEmail(account.email), passwordHash: null, role: ROLE_USER, source: 'sso' })
            );
            await tx.getRepository(UserIdentity).insert({
              userId: saved.id,
              providerId: account.providerId,
              subject: account.subject,
              emailAtLink: account.email,
              lastUsedAt: new Date(),
            });
            return saved;
          });
          return { user, created: true, linked: true };
        }
      }
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
  throw new Error('Single sign-on could not settle the account after a concurrent sign-in');
}
