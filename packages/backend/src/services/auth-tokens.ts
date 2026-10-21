import { createHash, randomBytes } from 'node:crypto';
import { DataSource, LessThan } from 'typeorm';
import { config } from '../config.js';
import { resolvePublicUrl } from './public-url.js';
import { AuthToken, type AuthTokenPurpose } from '../db/entities/AuthToken.js';
import { User } from '../db/entities/User.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function expiryFor(purpose: AuthTokenPurpose): Date {
  const ms =
    purpose === 'invite'
      ? config.auth.inviteExpiryHours * 3_600_000
      : config.auth.resetExpiryMinutes * 60_000;
  return new Date(Date.now() + ms);
}

/** Replaces any link the user already has, so only the newest one works. */
export async function issueToken(db: DataSource, userId: string, purpose: AuthTokenPurpose): Promise<string> {
  const repo = db.getRepository(AuthToken);
  const token = randomBytes(32).toString('base64url');
  await repo.delete({ userId });
  await repo.delete({ expiresAt: LessThan(new Date()) });
  await repo.save(repo.create({ userId, purpose, tokenHash: hashToken(token), expiresAt: expiryFor(purpose) }));
  return token;
}

export interface TokenLookup {
  token: AuthToken;
  user: User;
}

export async function findValidToken(db: DataSource, token: string): Promise<TokenLookup | null> {
  if (!token || token.length > 256) return null;
  const row = await db.getRepository(AuthToken).findOne({ where: { tokenHash: hashToken(token) } });
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  const user = await db.getRepository(User).findOne({ where: { id: row.userId } });
  return user && !signsInWithSsoOnly(user) ? { token: row, user } : null;
}

/** Created by single sign-on: never gets a password, so removing the person at the identity provider ends their access. */
export function signsInWithSsoOnly(user: Pick<User, 'source'>): boolean {
  return user.source === 'sso';
}

/** Consumes the link and sets the password in one transaction. Returns null when the link is no longer valid. */
export async function redeemToken(db: DataSource, token: string, passwordHash: string): Promise<User | null> {
  return db.transaction(async (tx) => {
    const row = await tx.getRepository(AuthToken).findOne({
      where: { tokenHash: hashToken(token) },
      lock: { mode: 'pessimistic_write' },
    });
    if (!row || row.expiresAt.getTime() < Date.now()) return null;
    const user = await tx.getRepository(User).findOne({ where: { id: row.userId } });
    if (!user || signsInWithSsoOnly(user)) return null;
    user.passwordHash = passwordHash;
    // A reset ends every existing session: whoever knew the old password is signed out (requirements_sso.md S3).
    if (row.purpose === 'reset') user.sessionVersion = (user.sessionVersion ?? 0) + 1;
    await tx.getRepository(User).save(user);
    await tx.getRepository(AuthToken).delete({ userId: user.id });
    return user;
  });
}

export async function setPasswordUrl(db: DataSource, token: string): Promise<string> {
  const url = await resolvePublicUrl(db);
  return `${url}/set-password?token=${encodeURIComponent(token)}`;
}
