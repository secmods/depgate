import type { DataSource } from 'typeorm';
import { encodeAuth } from './upstream-provider.js';

/** Serializes replicas that start together. Any constant unique to this job. */
const LOCK_KEY = 74_201_541;

const TABLES = ['upstream_registries', 'package_repositories'] as const;

/**
 * Remote credentials used to be stored as base64 JSON (requirements_v2.md A-11). Encrypts every such
 * value in place, so no readable credential is left in the database. A value that is not base64 JSON
 * cannot be a credential DepGate wrote; it is cleared, and the admin enters the credential again.
 * Idempotent: encrypted values start with `v1:`, which base64 never does.
 */
export async function ensureUpstreamAuthEncrypted(db: DataSource): Promise<{ encrypted: number; cleared: number }> {
  let encrypted = 0;
  let cleared = 0;
  await db.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    for (const table of TABLES) {
      const [exists] = (await manager.query('SELECT to_regclass($1) AS name', [`public.${table}`])) as { name: string | null }[];
      if (!exists?.name) continue;
      const rows = (await manager.query(
        `SELECT id, auth_encrypted FROM ${table} WHERE auth_encrypted IS NOT NULL AND auth_encrypted <> '' AND auth_encrypted NOT LIKE 'v1:%'`
      )) as { id: string; auth_encrypted: string }[];
      for (const row of rows) {
        const payload = decodeLegacy(row.auth_encrypted);
        if (payload) {
          await manager.query(`UPDATE ${table} SET auth_encrypted = $2 WHERE id = $1`, [row.id, encodeAuth(payload)]);
          encrypted++;
        } else {
          await manager.query(`UPDATE ${table} SET auth_encrypted = NULL, auth_type = NULL WHERE id = $1`, [row.id]);
          cleared++;
        }
      }
    }
  });
  return { encrypted, cleared };
}

function decodeLegacy(stored: string): Record<string, string> | null {
  try {
    const value = JSON.parse(Buffer.from(stored, 'base64').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    return entries.every(([, v]) => typeof v === 'string') ? (Object.fromEntries(entries) as Record<string, string>) : null;
  } catch {
    return null;
  }
}
