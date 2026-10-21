import { randomBytes } from 'node:crypto';

/** RFC 9562 UUID version 7: time-ordered, so receivers can sort events by ID. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** BullMQ refuses `:` in custom job IDs. */
export function webhookJobId(deliveryId: string): string {
  return `wh-${deliveryId}`;
}

export function runNowJobId(job: string): string {
  return `run-${job}`;
}

export function recheckJobId(policyId: string, token: string): string {
  return `recheck-${policyId}-${token}`;
}

/** Credentials in URLs and Authorization values never reach a log line or the Jobs page. */
export function scrubError(message: string, max = 500): string {
  return message
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@')
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer|basic|token)?\s*[^\s"',}]+/gi, '$1$2 ***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .slice(0, max);
}

/** The IDs a job's data carries, for its log lines. Never values that could hold a secret. */
export function jobIds(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (/Id$/.test(key) && (typeof value === 'string' || typeof value === 'number')) out[key] = String(value);
  }
  return out;
}
