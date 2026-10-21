import type { CacheLimits } from './store.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY_MS = 86_400_000;

/** Limits as people set them, in Settings or the environment. A field left out of a saved set follows the environment. */
export type LimitValues = {
  maxSizeGb: number | null;
  maxFiles: number;
  maxAgeDays: number;
  maxIdleDays: number;
  maxFileMb: number;
};

export const LIMIT_FIELDS = ['maxSizeGb', 'maxFiles', 'maxAgeDays', 'maxIdleDays', 'maxFileMb'] as const;
export type LimitField = (typeof LIMIT_FIELDS)[number];

export type SavedLimits = { [K in LimitField]?: number };

/** JSON schema of a limits patch: a number sets the field, null goes back to the environment. */
export const LIMITS_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxSizeGb: { type: 'number', exclusiveMinimum: 0, maximum: 1_000_000, nullable: true },
    maxFiles: { type: 'integer', minimum: 1, maximum: 1_000_000_000, nullable: true },
    maxAgeDays: { type: 'integer', minimum: 0, maximum: 3650, nullable: true },
    maxIdleDays: { type: 'integer', minimum: 0, maximum: 3650, nullable: true },
    maxFileMb: { type: 'integer', minimum: 1, maximum: 1_048_576, nullable: true },
  },
} as const;

export function toValues(limits: CacheLimits): LimitValues {
  return {
    maxSizeGb: limits.maxSizeBytes > 0 ? Math.round((limits.maxSizeBytes / GB) * 100) / 100 : null,
    maxFiles: limits.maxFiles,
    maxAgeDays: limits.maxAgeMs / DAY_MS,
    maxIdleDays: limits.maxIdleMs / DAY_MS,
    maxFileMb: Math.round(limits.maxFileBytes / MB),
  };
}

/** The environment's limits with the saved fields on top. */
export function effectiveLimits(environment: CacheLimits, saved: SavedLimits): CacheLimits {
  return {
    maxSizeBytes: saved.maxSizeGb != null ? Math.floor(saved.maxSizeGb * GB) : environment.maxSizeBytes,
    maxFiles: saved.maxFiles ?? environment.maxFiles,
    maxAgeMs: saved.maxAgeDays != null ? saved.maxAgeDays * DAY_MS : environment.maxAgeMs,
    maxIdleMs: saved.maxIdleDays != null ? saved.maxIdleDays * DAY_MS : environment.maxIdleMs,
    maxFileBytes: saved.maxFileMb != null ? saved.maxFileMb * MB : environment.maxFileBytes,
  };
}

/** Saved limits read back from the database, keeping only valid numbers. */
export function cleanSaved(raw: unknown): SavedLimits {
  const out: SavedLimits = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const field of LIMIT_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[field] = value;
  }
  return out;
}

/** `saved` with a patch applied: a number sets a field, null removes it. */
export function applyPatch(saved: SavedLimits, patch: Partial<Record<LimitField, number | null>>): SavedLimits {
  const next: SavedLimits = { ...saved };
  for (const field of LIMIT_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null || value === undefined) delete next[field];
    else next[field] = value;
  }
  return next;
}

/** "size per pod 20 GB, expire when unused 14 days" for the fields that changed. */
export function describeChanges(before: LimitValues, after: LimitValues): string[] {
  const label: Record<LimitField, (v: number | null) => string> = {
    maxSizeGb: (v) => `size per pod ${v === null ? 'not set' : `${v} GB`}`,
    maxFiles: (v) => `files per pod ${v}`,
    maxAgeDays: (v) => `expire after storing ${v ? `${v} days` : 'never'}`,
    maxIdleDays: (v) => `expire when unused ${v ? `${v} days` : 'never'}`,
    maxFileMb: (v) => `largest file ${v} MB`,
  };
  return LIMIT_FIELDS.filter((field) => before[field] !== after[field]).map((field) => label[field](after[field]));
}
