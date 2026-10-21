import type { StreamDestination, StreamDestinationType } from '../../../db/entities/StreamDestination.js';
import { decryptSecret, encryptSecret } from '../../mail-settings.js';
import { normalizeSelection, type EventSelection } from '../catalog.js';

/** The seven destination types (requirements_event_streaming.md §9). `jsonl` is shown as Container output. */
export const DESTINATION_TYPES: StreamDestinationType[] = ['splunk', 'datadog', 'elastic', 'sumo', 'syslog', 'http', 'jsonl'];

export const DATADOG_SITES = ['datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com'];

type FieldSpec = { name: string; secret?: boolean; required?: boolean; max?: number; values?: string[] };

/** Settings and secrets per type. Secrets are write-only: stored encrypted, never returned. */
export const TYPE_FIELDS: Record<StreamDestinationType, FieldSpec[]> = {
  splunk: [
    { name: 'url', required: true, max: 512 },
    { name: 'token', secret: true, required: true, max: 512 },
    { name: 'index', max: 128 },
    { name: 'source', max: 128 },
    { name: 'sourcetype', max: 128 },
    { name: 'caCert', max: 20_000 },
  ],
  datadog: [
    { name: 'site', required: true, values: DATADOG_SITES },
    { name: 'apiKey', secret: true, required: true, max: 256 },
    { name: 'service', max: 128 },
    { name: 'tags', max: 512 },
  ],
  elastic: [
    { name: 'url', required: true, max: 512 },
    { name: 'authType', required: true, values: ['apikey', 'basic'] },
    { name: 'apiKey', secret: true, max: 512 },
    { name: 'username', max: 256 },
    { name: 'password', secret: true, max: 512 },
    { name: 'index', max: 256 },
    { name: 'caCert', max: 20_000 },
  ],
  sumo: [
    { name: 'url', secret: true, required: true, max: 1024 },
    { name: 'category', max: 256 },
  ],
  syslog: [
    { name: 'host', required: true, max: 255 },
    { name: 'port', required: true, max: 5 },
    { name: 'transport', required: true, values: ['tls', 'tcp'] },
    { name: 'format', required: true, values: ['json', 'cef'] },
    { name: 'facility', max: 16 },
    { name: 'appName', max: 48 },
    { name: 'caCert', max: 20_000 },
  ],
  // Headers are validated on their own (§9.7 H2–H3); secret header values are stored as `header:{name}`.
  http: [
    { name: 'url', required: true, max: 1024 },
    { name: 'method', values: ['POST', 'PUT'] },
    { name: 'format', values: ['ndjson', 'array'] },
    { name: 'gzip', values: ['on', 'off'] },
    { name: 'headers', max: 200_000 },
    { name: 'caCert', max: 20_000 },
  ],
  jsonl: [],
};

export type DestinationInput = {
  name?: unknown;
  type?: unknown;
  enabled?: unknown;
  settings?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  selection?: unknown;
};

/** A destination as the senders use it: secrets decrypted. Never serialized to the API. */
export type ResolvedDestination = {
  id: string;
  name: string;
  type: StreamDestinationType;
  enabled: boolean;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  selection: EventSelection;
};

/** One header of an HTTP destination as stored in `settings.headers`: a value, or `secret` with the value in the secrets. */
export type HeaderDef = { name: string; value?: string; secret?: boolean };

export const MAX_HEADERS = 20;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/;
/** Set by DepGate itself (§9.7 H2). */
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'connection', 'user-agent']);

export function headerSecretKey(name: string): string {
  return `header:${name.toLowerCase()}`;
}

/** The stored header list; an unreadable value counts as none. */
export function headerList(settings: Record<string, string>): HeaderDef[] {
  try {
    const parsed = JSON.parse(settings.headers || '[]');
    return Array.isArray(parsed) ? (parsed as HeaderDef[]) : [];
  } catch {
    return [];
  }
}

function headerValueError(name: string, value: string): string | null {
  if (value.length > 4096) return `The value of header ${name} is at most 4,096 characters`;
  if (/[\r\n]/.test(value)) return `The value of header ${name} cannot contain line breaks`;
  return null;
}

/** Checks the header list (H2) and moves secret values into `secrets` (H3). Returns an error, or the list to store. */
function validateHeaders(raw: string | undefined, inputSecrets: Record<string, unknown> | undefined, secrets: Record<string, string>): string | HeaderDef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return 'headers must be a JSON list of {name, value, secret}';
  }
  if (!Array.isArray(parsed)) return 'headers must be a JSON list of {name, value, secret}';
  if (parsed.length > MAX_HEADERS) return `At most ${MAX_HEADERS} headers`;
  const seen = new Set<string>();
  const headers: HeaderDef[] = [];
  for (const item of parsed as Array<Record<string, unknown>>) {
    const name = String(item?.name ?? '').trim();
    if (!HEADER_NAME.test(name)) return name ? `${name} is not a valid header name` : 'Enter a name for every header';
    const lower = name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) return `DepGate sets ${name} itself`;
    if (seen.has(lower)) return `Header ${name} is listed twice`;
    seen.add(lower);
    if (item.secret === true) {
      const key = headerSecretKey(name);
      const sent = inputSecrets?.[key];
      if (sent !== undefined && sent !== null) {
        const value = String(sent).trim();
        if (value) secrets[key] = value;
        else delete secrets[key];
      }
      if (!secrets[key]) return `Enter the value of header ${name}`;
      const error = headerValueError(name, secrets[key]);
      if (error) return error;
      headers.push({ name, secret: true });
    } else {
      const value = String(item.value ?? '').trim();
      if (!value) return `Enter the value of header ${name}`;
      const error = headerValueError(name, value);
      if (error) return error;
      headers.push({ name, value });
    }
  }
  // A header removed from the list, or no longer secret, loses its stored value.
  for (const key of Object.keys(secrets)) {
    if (key.startsWith('header:') && !headers.some((header) => header.secret && headerSecretKey(header.name) === key)) delete secrets[key];
  }
  return headers;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validates a create or update. On update, `existing` holds the stored secrets: a secret left out keeps its
 * value, an empty string clears it. Returns an error message, or the values to store.
 */
export function validateDestination(
  input: DestinationInput,
  existing?: Pick<ResolvedDestination, 'type' | 'secrets' | 'settings'>
): string | { name: string; type: StreamDestinationType; enabled: boolean; settings: Record<string, string>; secrets: Record<string, string>; selection: EventSelection } {
  const type = (input.type ?? existing?.type) as StreamDestinationType;
  if (!DESTINATION_TYPES.includes(type)) return `type must be one of ${DESTINATION_TYPES.join(', ')}`;
  if (existing && existing.type !== type) return 'The type of a destination cannot be changed';
  const name = String(input.name ?? '').trim();
  if (!name) return 'Enter a name';
  if (name.length > 128) return 'The name is at most 128 characters';
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = { ...(existing?.secrets ?? {}) };
  for (const field of TYPE_FIELDS[type]) {
    const source = field.secret ? input.secrets : input.settings;
    const raw = source?.[field.name];
    if (field.secret) {
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      if (value) secrets[field.name] = value;
      else delete secrets[field.name];
      if (field.max && value.length > field.max) return `${field.name} is too long`;
      continue;
    }
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!value) continue;
    if (field.max && value.length > field.max) return `${field.name} is too long`;
    if (field.values && !field.values.includes(value)) return `${field.name} must be one of ${field.values.join(', ')}`;
    settings[field.name] = value;
  }
  for (const field of TYPE_FIELDS[type]) {
    if (!field.required) continue;
    if (field.secret ? !secrets[field.name] : !settings[field.name]) return `Enter ${label(field.name)}`;
  }
  if (settings.url && !isUrl(settings.url)) return 'Enter an http:// or https:// URL';
  if (type === 'sumo' && secrets.url && !isUrl(secrets.url)) return 'Enter the HTTP Source URL';
  if (type === 'elastic') {
    if (settings.authType === 'apikey' && !secrets.apiKey) return 'Enter the API key';
    if (settings.authType === 'basic' && (!settings.username || !secrets.password)) return 'Enter the username and password';
  }
  if (type === 'syslog') {
    const port = Number(settings.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Enter a port between 1 and 65535';
  }
  if (type === 'http') {
    settings.method ||= 'POST';
    settings.format ||= 'ndjson';
    settings.gzip ||= 'on';
    const headers = validateHeaders(settings.headers, input.secrets, secrets);
    if (typeof headers === 'string') return headers;
    if (headers.length) settings.headers = JSON.stringify(headers);
    else delete settings.headers;
  }
  if (settings.caCert && !/-----BEGIN CERTIFICATE-----/.test(settings.caCert)) return 'The CA certificate must be PEM';
  return {
    name,
    type,
    enabled: input.enabled === undefined ? true : input.enabled === true,
    settings,
    secrets,
    selection: normalizeSelection(input.selection),
  };
}

function label(field: string): string {
  return (
    { url: 'the URL', token: 'the HEC token', site: 'the site', apiKey: 'the API key', authType: 'the authentication', host: 'the host', port: 'the port', transport: 'the transport', format: 'the format' } as Record<string, string>
  )[field] ?? field;
}

export function encryptSecrets(secrets: Record<string, string>): string | null {
  return Object.keys(secrets).length ? encryptSecret(JSON.stringify(secrets)) : null;
}

export function decryptSecrets(stored: string | null): Record<string, string> {
  if (!stored) return {};
  try {
    return JSON.parse(decryptSecret(stored)) as Record<string, string>;
  } catch {
    return {};
  }
}

export function resolveDestination(row: StreamDestination): ResolvedDestination {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    settings: (row.settings ?? {}) as Record<string, string>,
    secrets: decryptSecrets(row.secretsEnc),
    selection: normalizeSelection(row.selection),
  };
}

/** The API view: settings, and which secrets are set, never their values (§9). */
export function publicView(row: StreamDestination): Record<string, unknown> {
  const secrets = decryptSecrets(row.secretsEnc);
  const secretFields = TYPE_FIELDS[row.type]?.filter((field) => field.secret).map((field) => field.name) ?? [];
  if (row.type === 'http') secretFields.push(...headerList((row.settings ?? {}) as Record<string, string>).filter((h) => h.secret).map((h) => headerSecretKey(h.name)));
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    settings: row.settings ?? {},
    secrets: Object.fromEntries(secretFields.map((name) => [name, { set: Boolean(secrets[name]) }])),
    selection: normalizeSelection(row.selection),
    createdAt: row.createdAt?.toISOString?.() ?? null,
    updatedAt: row.updatedAt?.toISOString?.() ?? null,
  };
}

/** What changed, for the audit event. Secrets appear only as "changed", never with a value. */
export function describeChanges(before: ResolvedDestination | null, after: ResolvedDestination): string[] {
  if (!before) return [`Created ${after.type} destination ${after.name}`];
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`Renamed from ${before.name}`);
  if (before.enabled !== after.enabled) changes.push(after.enabled ? 'Enabled' : 'Disabled');
  for (const key of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (key === 'headers') {
      if ((before.settings[key] ?? '') !== (after.settings[key] ?? '')) {
        const list = headerList(after.settings).map((h) => (h.secret ? `${h.name} (secret)` : `${h.name}: ${h.value}`));
        changes.push(`headers: ${list.length ? list.join(', ') : '(none)'}`);
      }
      continue;
    }
    if (key === 'caCert') {
      if ((before.settings[key] ?? '') !== (after.settings[key] ?? '')) changes.push('CA certificate changed');
      continue;
    }
    if ((before.settings[key] ?? '') !== (after.settings[key] ?? '')) changes.push(`${key}: ${after.settings[key] ?? '(none)'}`);
  }
  for (const key of new Set([...Object.keys(before.secrets), ...Object.keys(after.secrets)])) {
    if (before.secrets[key] !== after.secrets[key]) changes.push(`${key} changed`);
  }
  if (JSON.stringify(before.selection) !== JSON.stringify(after.selection)) changes.push('Event selection changed');
  return changes.length ? changes : ['No changes'];
}
