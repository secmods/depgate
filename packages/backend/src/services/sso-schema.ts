import type { DataSource } from 'typeorm';

/** Serializes replicas that start together. Any constant unique to this job. */
const LOCK_KEY = 74_201_539;

/**
 * An account single sign-on created signs in only through its identity provider, so removing the
 * person there ends their access. Removes any password such an account was given through a reset
 * link, the links still outstanding, and the sessions started with that password. Returns the
 * number of accounts that had a password.
 */
export async function clearSsoPasswords(db: DataSource): Promise<number> {
  return db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await manager.query(
      `DELETE FROM auth_tokens WHERE user_id IN (SELECT id FROM users WHERE source = 'sso')`
    );
    const [, affected] = (await manager.query(
      `UPDATE users SET password_hash = NULL, session_version = session_version + 1
       WHERE source = 'sso' AND password_hash IS NOT NULL`
    )) as [unknown, number];
    return affected ?? 0;
  });
}
