import os from 'node:os';
import { createRequire } from 'node:module';
import { config } from '../../config.js';
import { uuidv7 } from '../jobs/ids.js';
import type { EventActor } from '../request-context.js';
import { catalogEntry, jobFeature, type EventCategory, type Severity } from './catalog.js';

/**
 * The one event format (requirements_event_streaming.md §6.1), used by the three event pages, the API and
 * every streaming destination. Empty sections are left out, never sent as null.
 */

export const EVENT_SCHEMA = 'depgate.event/1';

export type EventTarget = {
  kind: string;
  id?: string | null;
  name?: string | null;
  ecosystem?: string | null;
  version?: string | null;
  repository?: string | null;
};

export type EventEnvelope = {
  schema: typeof EVENT_SCHEMA;
  id: string;
  time: string;
  category: EventCategory;
  type: string;
  feature: string;
  severity: Severity;
  summary: string;
  actor?: EventActor;
  target?: EventTarget;
  policy?: { id: string | null; name: string | null };
  reasons?: string[];
  details?: Record<string, unknown>;
  depgate: { version: string; instance: string; host: string };
};

/** What a producer hands to recordEvent. */
export type EventInput = {
  type: string;
  /** The scheduled job of a JOB_* event. */
  job?: string;
  summary?: string;
  actor?: EventActor;
  target?: EventTarget;
  policy?: { id?: string | null; name?: string | null } | null;
  reasons?: string[] | null;
  details?: Record<string, unknown> | null;
  /** Given by the migration and by tests; otherwise now. */
  time?: Date;
  id?: string;
};

function readVersion(): string {
  try {
    const require = createRequire(__filename);
    return (require('../../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultInstance(): string {
  for (const url of [config.auth.publicUrlEnv, config.gateway.baseUrl]) {
    try {
      if (url) return new URL(url).host;
    } catch {
      /* next */
    }
  }
  return os.hostname();
}

const DEPGATE = Object.freeze({
  version: readVersion(),
  instance: config.events.instanceName || defaultInstance(),
  host: os.hostname(),
});

export function depgateInfo(): EventEnvelope['depgate'] {
  return DEPGATE;
}

/** Drops null, undefined, empty strings, empty arrays and empty objects, one level deep. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || item === '') continue;
    if (Array.isArray(item) && item.length === 0) continue;
    if (typeof item === 'object' && !Array.isArray(item) && !(item instanceof Date) && Object.keys(item).length === 0) continue;
    out[key] = item;
  }
  return out as Partial<T>;
}

function section<T extends Record<string, unknown>>(value: T | null | undefined): T | undefined {
  if (!value) return undefined;
  const out = compact(value);
  return Object.keys(out).length ? (out as T) : undefined;
}

/** `npm event-stream@3.3.6` */
export function packageLabel(target: EventTarget | undefined): string {
  if (!target) return '';
  const name = target.name ?? '';
  const version = target.version ? `@${target.version}` : '';
  return [target.ecosystem, `${name}${version}`].filter(Boolean).join(' ');
}

/** A line a human can read without the other fields, when the producer gave none. */
export function defaultSummary(input: EventInput): string {
  const pkg = packageLabel(input.target);
  const first = input.reasons?.[0];
  switch (input.type) {
    case 'BLOCK_ENFORCE':
      return `Blocked ${pkg}${input.policy?.name ? `: ${input.policy.name}` : ''}`;
    case 'BLOCK_MONITOR':
      return `Would block ${pkg}${input.policy?.name ? `: ${input.policy.name}` : ''} (Monitor)`;
    case 'ALLOW':
      return `Allowed ${pkg}`;
    case 'UPSTREAM_UNAVAILABLE':
      return `Upstream ${input.target?.name ?? ''} unavailable`.replace(/\s+/g, ' ');
    case 'MALWARE_REQUESTED':
      return `Malware requested: ${pkg}`;
    case 'DEPENDENCY_CONFUSION_BLOCKED':
      return `Dependency confusion blocked: ${pkg}`;
    case 'PACKAGE_CHECKED':
      return `Checked ${pkg}`;
    case 'JOB_FAILED':
      return `Job ${input.job ?? input.target?.name ?? ''} failed${first ? `: ${first}` : ''}`;
    case 'JOB_SUCCEEDED':
      return `Job ${input.job ?? input.target?.name ?? ''} completed`;
    case 'JOB_SKIPPED':
      return `Job ${input.job ?? input.target?.name ?? ''} skipped`;
    default:
      return (first ?? input.type).slice(0, 500);
  }
}

/** Builds the envelope once; recordEvent serializes it once (L2). */
export function buildEnvelope(input: EventInput): EventEnvelope {
  const isJob = input.type === 'JOB_FAILED' || input.type === 'JOB_SUCCEEDED' || input.type === 'JOB_SKIPPED';
  const entry = catalogEntry(input.type, input.job);
  const category: EventCategory = isJob ? 'job' : (entry?.event.category ?? 'audit');
  const feature = isJob && input.job ? jobFeature(input.job) : (entry?.feature ?? 'settings');
  const severity: Severity = isJob ? (input.type === 'JOB_FAILED' ? 'error' : 'info') : (entry?.event.severity ?? 'notice');
  const actor = section(input.actor ?? undefined);
  if (actor?.metadata && Object.keys(actor.metadata).length === 0) delete actor.metadata;
  const policy = input.policy && (input.policy.id || input.policy.name)
    ? { id: input.policy.id ?? null, name: input.policy.name ?? null }
    : undefined;
  const envelope: EventEnvelope = {
    schema: EVENT_SCHEMA,
    id: input.id ?? uuidv7(input.time?.getTime()),
    time: (input.time ?? new Date()).toISOString(),
    category,
    type: input.type,
    feature,
    severity,
    summary: (input.summary || defaultSummary(input)).slice(0, 500),
    depgate: DEPGATE,
  };
  if (actor) envelope.actor = actor as EventActor;
  const target = section(input.target ?? undefined);
  if (target) envelope.target = target as EventTarget;
  if (policy) envelope.policy = policy;
  if (input.reasons?.length) envelope.reasons = input.reasons;
  const details = section(input.details ?? undefined);
  if (details) envelope.details = details;
  // Key order of §6.1, with depgate last.
  const { depgate, ...rest } = envelope;
  return { ...rest, depgate } as EventEnvelope;
}
