import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { GatewaySettings } from '../db/entities/GatewaySettings.js';
import { bumpReference, readReference } from './reference-cache.js';
import { cleanSaved, type SavedLimits } from './artifact-cache/settings.js';

const SETTINGS_ID = 'default';
const REDIS_KEY_SESSION_TOKEN_DAYS = 'gateway:sessionTokenDays';

/** Registry snippet lifetime for User and Security. The browser session is separate. A CI token lasts at most 1 day. */
export const DEFAULT_SESSION_TOKEN_DAYS = 30;
export const MIN_SESSION_TOKEN_DAYS = 1;
export const MAX_SESSION_TOKEN_DAYS = 365;

export function normalizeSessionTokenDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < MIN_SESSION_TOKEN_DAYS || value > MAX_SESSION_TOKEN_DAYS) return null;
  return value;
}

async function settingsRow(db: DataSource): Promise<GatewaySettings> {
  const repo = db.getRepository(GatewaySettings);
  const found = await repo.findOne({ where: { id: SETTINGS_ID } });
  if (found) return found;
  const created = repo.create({
    id: SETTINGS_ID,
    sessionTokenDays: DEFAULT_SESSION_TOKEN_DAYS,
  });
  try {
    return await repo.save(created);
  } catch (err) {
    const again = await repo.findOne({ where: { id: SETTINGS_ID } });
    if (again) return again;
    throw err;
  }
}

export async function ensureGatewaySettings(db: DataSource): Promise<GatewaySettings> {
  return settingsRow(db);
}

/** Copy security controls saved in Redis into Postgres, then drop those keys. */
export async function adoptRedisGatewayControls(db: DataSource, redis: Redis): Promise<void> {
  const days = await redis.get(REDIS_KEY_SESSION_TOKEN_DAYS);
  if (days === null) {
    await settingsRow(db);
    return;
  }
  await settingsRow(db);
  const patch: Partial<GatewaySettings> = {};
  if (days !== null) {
    const parsed = normalizeSessionTokenDays(Number(days));
    if (parsed !== null) patch.sessionTokenDays = parsed;
  }
  if (Object.keys(patch).length) {
    await db.getRepository(GatewaySettings).update({ id: SETTINGS_ID }, patch);
  }
  await redis.del(REDIS_KEY_SESSION_TOKEN_DAYS);
}

async function cachedSettings(db: DataSource): Promise<GatewaySettings> {
  return readReference('gateway', () => settingsRow(db));
}

export async function getSessionTokenDays(db: DataSource): Promise<number> {
  const days = (await cachedSettings(db)).sessionTokenDays;
  return normalizeSessionTokenDays(days) ?? DEFAULT_SESSION_TOKEN_DAYS;
}

export async function setSessionTokenDays(db: DataSource, days: number): Promise<void> {
  await settingsRow(db);
  await db.getRepository(GatewaySettings).update({ id: SETTINGS_ID }, { sessionTokenDays: days });
  await bumpReference('gateway');
}

export async function getNamespaceCollisionCheck(db: DataSource): Promise<boolean> {
  return (await cachedSettings(db)).namespaceCollisionCheck === true;
}

/** Artifact cache settings saved in Settings. Null and missing fields follow the ARTIFACT_CACHE_* environment variables. */
export type ArtifactCacheSettings = { enabled: boolean | null; limits: SavedLimits };

/** `verify` reads the generation from Redis, so a change made on another replica is seen at once. */
export async function getArtifactCacheSettings(db: DataSource, opts?: { verify?: boolean }): Promise<ArtifactCacheSettings> {
  const row = await readReference('gateway', () => settingsRow(db), opts);
  return {
    enabled: typeof row.artifactCacheEnabled === 'boolean' ? row.artifactCacheEnabled : null,
    limits: cleanSaved(row.artifactCacheLimits),
  };
}

export async function setArtifactCacheSettings(db: DataSource, settings: ArtifactCacheSettings): Promise<void> {
  await settingsRow(db);
  await db.getRepository(GatewaySettings).update(
    { id: SETTINGS_ID },
    { artifactCacheEnabled: settings.enabled, artifactCacheLimits: Object.keys(settings.limits).length ? settings.limits : null }
  );
  await bumpReference('gateway');
}

export async function setNamespaceCollisionCheck(db: DataSource, enabled: boolean): Promise<void> {
  await settingsRow(db);
  await db.getRepository(GatewaySettings).update({ id: SETTINGS_ID }, { namespaceCollisionCheck: enabled });
  await bumpReference('gateway');
}
