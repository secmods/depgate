import { DataSource } from 'typeorm';
import { AuthSettings } from '../db/entities/AuthSettings.js';

const ID = 'default';

export interface SigninSettings {
  allowedDomains: string[];
  allowUnlistedSso: boolean;
}

/** Allowed sign-in domains and whether unlisted people may sign in with SSO. Created with the defaults on first read. */
export async function loadSigninSettings(db: DataSource): Promise<SigninSettings> {
  const repo = db.getRepository(AuthSettings);
  let row = await repo.findOne({ where: { id: ID } });
  if (!row) {
    try {
      row = await repo.save(repo.create({ id: ID, allowedDomains: [], allowUnlistedSso: true }));
    } catch (err) {
      row = await repo.findOne({ where: { id: ID } });
      if (!row) throw err;
    }
  }
  return { allowedDomains: row.allowedDomains ?? [], allowUnlistedSso: row.allowUnlistedSso };
}

export async function saveSigninSettings(db: DataSource, input: SigninSettings): Promise<SigninSettings> {
  await loadSigninSettings(db);
  await db.getRepository(AuthSettings).update({ id: ID }, { allowedDomains: input.allowedDomains, allowUnlistedSso: input.allowUnlistedSso });
  return loadSigninSettings(db);
}
