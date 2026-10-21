import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { User } from '../db/entities/User.js';
import { UserIdentity } from '../db/entities/UserIdentity.js';
import { planSsoSignIn } from './sso-signin.js';

/**
 * Account resolution (requirements_sso.md R11) around a concurrent first sign-in: the load test signs the
 * same person in from several browsers at once, so a link can appear between two lookups.
 */
describe('planSsoSignIn', () => {
  const user = { id: 'u1', email: 'ravi@hayageek.com', role: 'Security', disabledAt: null as Date | null };
  const account = { providerId: 'p1', subject: 'ravi@hayageek.com', email: 'ravi@hayageek.com' };

  /** The (provider, subject) lookup finds nothing; the (user, provider) lookup then finds `linkedSince`. */
  function db(linkedSince: { subject: string } | null, who = user): DataSource {
    let identityLookups = 0;
    const link = linkedSince ? { id: 'l1', userId: who.id, providerId: 'p1', ...linkedSince } : null;
    return {
      getRepository: (entity: unknown) =>
        entity === UserIdentity
          ? { findOne: async () => (identityLookups++ === 0 ? null : link), delete: async () => undefined }
          : entity === User
            ? { findOne: async () => who }
            : null,
    } as unknown as DataSource;
  }

  it('treats a link to the same subject made meanwhile as signed in before', async () => {
    const plan = await planSsoSignIn(db({ subject: account.subject }), account, true);
    expect(plan).toMatchObject({ kind: 'linked', user: { id: 'u1' } });
  });

  it('still refuses another subject linked to that email', async () => {
    const plan = await planSsoSignIn(db({ subject: 'someone-else' }), account, true);
    expect(plan).toMatchObject({ kind: 'deny', reason: 'subject_mismatch' });
  });

  it('still refuses a disabled user found that way', async () => {
    const plan = await planSsoSignIn(db({ subject: account.subject }, { ...user, disabledAt: new Date() }), account, true);
    expect(plan).toMatchObject({ kind: 'deny', reason: 'user_disabled' });
  });

  it('links an existing user on a first sign-in', async () => {
    expect(await planSsoSignIn(db(null), account, true)).toMatchObject({ kind: 'link', user: { id: 'u1' } });
  });
});
