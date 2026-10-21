/** A CI token may last up to one day. Anything longer is rejected. */
const MAX_EXPIRES_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const METADATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED_METADATA_KEYS = new Set(['role', 'sub', 'exp', 'type', 'iat', 'nbf', 'jti', 'name']);
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _./:@-]{0,127}$/;

export function parseExpiresIn(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const ms = amount * UNIT_MS[match[2]];
  if (ms > MAX_EXPIRES_MS) return null;
  return ms;
}

export function parseCiTokenName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return NAME_PATTERN.test(name) ? name : null;
}

export function parseMetadata(value: unknown): { metadata: Record<string, string> } | { error: string } {
  if (value == null) return { metadata: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'metadata must be a map of strings' };
  }
  const entries = Object.entries(value);
  if (entries.length > 20) return { error: 'metadata accepts at most 20 pairs' };
  const metadata: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!METADATA_KEY.test(key) || RESERVED_METADATA_KEYS.has(key)) {
      return { error: `invalid metadata key: ${key}` };
    }
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) {
      return { error: `invalid metadata value for ${key}` };
    }
    metadata[key] = raw;
  }
  return { metadata };
}
