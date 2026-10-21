import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { ROLE_SECURITY } from '../auth/roles.js';
import { ApiKey } from '../db/entities/ApiKey.js';
import { User } from '../db/entities/User.js';
import { DataSource } from 'typeorm';
import { config } from '../config.js';
import { dbSslOptions } from '../db/ssl.js';

const SALT_ROUNDS = 10;
export const API_KEY_PREFIX = 'dgk_';
/** Keys issued before the rename still authenticate until they are revoked or expire. */
const LEGACY_API_KEY_PREFIX = 'osk_';

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX) || token.startsWith(LEGACY_API_KEY_PREFIX);
}

/**
 * API keys are 256 random bits (see generateApiKey), so a plain SHA-256 keeps the stored hash from
 * revealing the key. A slow password hash would only make every registry request slower.
 */
export function hashApiKey(plainKey: string): string {
  return createHash('sha256').update(plainKey).digest('hex');
}

export function generateApiKey(): string {
  const bytes = randomBytes(32);
  const base64 = bytes.toString('base64url');
  return `${API_KEY_PREFIX}${base64}`;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function findApiKey(db: DataSource, plainKey: string): Promise<ApiKey | null> {
  const keyHash = hashApiKey(plainKey);
  return db.getRepository(ApiKey).findOne({
    where: { keyHash },
  });
}

const LAST_USED_MIN_INTERVAL_MS = 60_000;

/** Records that an API key was just used, at most once a minute per key, without delaying the request. */
export function touchApiKey(db: DataSource, apiKey: ApiKey, now: Date = new Date()): void {
  const last = apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).getTime() : 0;
  if (now.getTime() - last < LAST_USED_MIN_INTERVAL_MS) return;
  apiKey.lastUsedAt = now;
  void db
    .getRepository(ApiKey)
    .update({ id: apiKey.id }, { lastUsedAt: now })
    .catch(() => undefined);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

export async function findUserByEmail(db: DataSource, email: string): Promise<User | null> {
  return db.getRepository(User).findOne({
    where: { email: normalizeEmail(email) },
  });
}

export async function ensureDefaultAdmin(db: DataSource, email: string, password: string): Promise<User> {
  const repo = db.getRepository(User);
  const normalized = normalizeEmail(email);
  let admin = await repo.findOne({ where: { email: normalized } });
  if (admin) return admin;

  const passwordHash = await hashPassword(password);
  admin = repo.create({ email: normalized, passwordHash, role: ROLE_SECURITY });
  return repo.save(admin);
}

/**
 * Turn users.username into users.email. Runs before the data source initializes, because
 * schema sync would otherwise drop the old column. Existing logins that are not an email
 * become <name>@depgate.local. Safe to run on every startup.
 */
export async function migrateUsernameToEmail(): Promise<void> {
  const ds = new DataSource({
    type: 'postgres',
    host: config.db.host,
    port: config.db.port,
    username: config.db.user,
    password: config.db.password,
    database: config.db.database,
    ssl: dbSslOptions(),
    synchronize: false,
    entities: [],
  });
  await ds.initialize();
  try {
    const cols: Array<{ column_name: string }> = await ds.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users' AND column_name IN ('username', 'email')`
    );
    const names = new Set(cols.map((r) => r.column_name));
    if (!names.has('username') || names.has('email')) return;
    await ds.transaction(async (tx) => {
      await tx.query(`ALTER TABLE users RENAME COLUMN username TO email`);
      await tx.query(`ALTER TABLE users ALTER COLUMN email TYPE varchar(254)`);
      await tx.query(
        `UPDATE users SET email = lower(trim(email)) || CASE WHEN position('@' in email) = 0 THEN '@depgate.local' ELSE '' END`
      );
    });
  } finally {
    await ds.destroy();
  }
}

/** Rewrite roles from the Admin / Viewer split. Safe to run on every startup. */
export async function migrateLegacyRoles(db: DataSource): Promise<void> {
  await db.query(`UPDATE users SET role = 'Security' WHERE role = 'Admin'`);
  await db.query(`UPDATE users SET role = 'User' WHERE role = 'Viewer'`);
  await db.query(`UPDATE api_keys SET role = 'Security' WHERE role = 'Admin'`);
  await db.query(`UPDATE api_keys SET role = 'User' WHERE role = 'Viewer'`);
}
