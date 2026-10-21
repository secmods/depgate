import { DataSource } from 'typeorm';
import { config } from '../config.js';
import { MailSettings } from '../db/entities/MailSettings.js';

const ID = 'default';

/** Reduces input to an http(s) origin, or null when it is not one. */
export function parseOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Where links in emails point. Never read from the request that asks for the email, because anyone can
 * forge that. It comes from UI_URL, or from the browser address of a signed-in Security admin.
 */
export async function resolvePublicUrl(db: DataSource): Promise<string> {
  if (config.auth.publicUrlEnv) return config.auth.publicUrlEnv;
  const row = await db.getRepository(MailSettings).findOne({ where: { id: ID } });
  return row?.publicUrl || config.auth.publicUrlDefault;
}

export type PublicUrlSource = 'setting' | 'learned' | 'default';

/** The public address and where it came from: UI_URL, a Security admin's browser, or the built-in default. */
export async function publicUrlInfo(db: DataSource): Promise<{ url: string; source: PublicUrlSource }> {
  if (config.auth.publicUrlEnv) return { url: config.auth.publicUrlEnv, source: 'setting' };
  const row = await db.getRepository(MailSettings).findOne({ where: { id: ID } });
  if (row?.publicUrl) return { url: row.publicUrl, source: 'learned' };
  return { url: config.auth.publicUrlDefault, source: 'default' };
}

/** Called after a Security admin signs in or adds a user. The latest admin address wins. */
export async function learnPublicUrl(db: DataSource, originHeader: string | undefined): Promise<void> {
  const origin = parseOrigin(originHeader);
  if (!origin) return;
  const repo = db.getRepository(MailSettings);
  const row = (await repo.findOne({ where: { id: ID } })) ?? repo.create({ id: ID, passwordEnc: '', publicUrl: '' });
  if (row.publicUrl === origin) return;
  row.publicUrl = origin;
  await repo.save(row);
}
