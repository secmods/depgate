import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { config } from '../config.js';
import { MailSettings } from '../db/entities/MailSettings.js';

export interface MailServer {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

const ID = 'default';

function key(): Buffer {
  return createHash('sha256').update(`depgate-mail:${config.auth.jwtSecret}`).digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${body.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  const [version, iv, tag, body] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || !body) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // The JWT secret changed since the password was saved; the admin must enter it again.
    return '';
  }
}

export async function loadMailSettings(db: DataSource): Promise<MailSettings | null> {
  return db.getRepository(MailSettings).findOne({ where: { id: ID } });
}

export async function saveMailSettings(
  db: DataSource,
  input: { host: string; port: number; secure: boolean; user: string; fromAddress: string; password?: string }
): Promise<MailSettings> {
  const repo = db.getRepository(MailSettings);
  const row = (await repo.findOne({ where: { id: ID } })) ?? repo.create({ id: ID, passwordEnc: '' });
  row.host = input.host;
  row.port = input.port;
  row.secure = input.secure;
  row.user = input.user;
  row.fromAddress = input.fromAddress;
  if (input.password !== undefined) row.passwordEnc = encryptSecret(input.password);
  return repo.save(row);
}

/** Settings saved in the UI win; the SMTP_* environment variables are the fallback. Null when neither names a host. */
export async function effectiveMailServer(db: DataSource | undefined): Promise<MailServer | null> {
  const row = db ? await loadMailSettings(db) : null;
  if (row?.host) {
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      user: row.user,
      password: decryptSecret(row.passwordEnc),
      from: row.fromAddress || config.mail.from,
    };
  }
  if (config.mail.host) {
    return { ...config.mail, password: config.mail.password };
  }
  return null;
}
