import type { DataSource } from 'typeorm';
import { DecisionLedgerEntry } from '../../db/entities/DecisionLedgerEntry.js';
import { AuditEvent } from '../../db/entities/AuditEvent.js';
import { ledgerRowsLostTotal } from '../jobs/metrics.js';
import { currentActor, currentRepository, type EventActor } from '../request-context.js';
import { buildEnvelope, type EventEnvelope, type EventInput } from './envelope.js';
import { auditRowsLostTotal, eventsPublishedTotal } from './metrics.js';
import { countDecision, noteUsage } from './summary.js';
import type { WebhookPayload } from '../webhook-service.js';

/**
 * The one entry point for every event (requirements_event_streaming.md §7):
 *
 *   BLOCK_ENFORCE / UPSTREAM_UNAVAILABLE / ALLOW of malware → ledger write buffer
 *   ALLOW / BLOCK_ENFORCE / BLOCK_MONITOR                                         → in-memory counts
 *   ALLOW / BLOCK_ENFORCE with a version                                          → usage LRU
 *   audit                                                                         → insert audit_events
 *   job, BLOCK_MONITOR, MALWARE_REQUESTED, DEPENDENCY_CONFUSION_BLOCKED           → nothing stored
 *   every event                                                                   → publish
 *
 * Nothing here is awaited by the caller: the download never waits for an event.
 */

export type RecordInput = EventInput & {
  /** The version is on the malware list (ledger `malware` column). An allowed one is then stored (§8.5). */
  malware?: boolean;
  /** Today's webhook payload, sent unchanged to subscribed webhooks (W8). */
  webhookPayload?: WebhookPayload;
};

/** Ledger decisions: stored row by row. */
export const LEDGER_TYPES = new Set(['BLOCK_ENFORCE', 'UPSTREAM_UNAVAILABLE']);
const COUNTED_TYPES = new Set(['ALLOW', 'BLOCK_ENFORCE', 'BLOCK_MONITOR']);
const USAGE_TYPES = new Set(['ALLOW', 'BLOCK_ENFORCE']);
/** Publish-only companions of a download event: storing or counting them would count the download twice. */
const COMPANION_TYPES = new Set(['MALWARE_REQUESTED', 'DEPENDENCY_CONFUSION_BLOCKED']);
export const PACKAGE_ECOSYSTEMS = new Set(['npm', 'pypi', 'maven', 'go', 'nuget', 'cargo', 'composer', 'rubygems']);

type Publisher = (envelope: EventEnvelope, json: string, webhookPayload?: WebhookPayload) => void;

let publisher: Publisher | null = null;

/** Set by the streaming runtime (Redis streams, JSON lines, webhooks). */
export function bindPublisher(fn: Publisher | null): void {
  publisher = fn;
}

/** The bound publisher, so a test can observe events and still pass them on. */
export function currentPublisher(): Publisher | null {
  return publisher;
}

/** Fills the actor from the request in flight when the producer gave none. Call before the first await. */
export function withActor(input: RecordInput): RecordInput {
  if (input.actor) return input;
  return { ...input, actor: currentActor() ?? { kind: 'system', name: 'DepGate' } };
}

export function recordEvent(db: DataSource | null | undefined, input: RecordInput): EventEnvelope {
  const envelope = buildEnvelope(withActor(input));
  eventsPublishedTotal.inc({ category: envelope.category, type: envelope.type });
  const target = envelope.target;
  const ecosystem = target?.ecosystem ?? null;

  if (db && (LEDGER_TYPES.has(envelope.type) || (envelope.type === 'ALLOW' && input.malware))) {
    queueLedgerRow(db, ledgerRow(envelope, input.malware === true));
  }
  if (!COMPANION_TYPES.has(envelope.type) && ecosystem && PACKAGE_ECOSYSTEMS.has(ecosystem) && target?.name) {
    if (COUNTED_TYPES.has(envelope.type)) {
      countDecision(ecosystem, target.repository ?? null, target.name, envelope.type, Date.parse(envelope.time));
    }
    if (USAGE_TYPES.has(envelope.type) && target.version) {
      const source = envelope.details?.source as { repository?: string; type?: string } | undefined;
      noteUsage({
        ecosystem,
        packageName: target.name,
        version: target.version,
        repository: target.repository ?? null,
        sourceRepository: source?.repository ?? null,
        sourceType: source?.type ?? null,
        decision: envelope.type as 'ALLOW' | 'BLOCK_ENFORCE',
      });
    }
  }
  if (db && envelope.category === 'audit') insertAuditEvent(db, envelope);

  const json = JSON.stringify(envelope);
  // As deliverWebhooks always did: a payload without a repository gets the request's (W8).
  let webhookPayload = input.webhookPayload;
  if (webhookPayload && webhookPayload.repository === undefined) {
    const repository = currentRepository();
    if (repository !== undefined) webhookPayload = { ...webhookPayload, repository };
  }
  try {
    publisher?.(envelope, json, webhookPayload);
  } catch {
    /* publish never throws into a request */
  }
  return envelope;
}

function nullIfEmpty<T extends Record<string, unknown>>(value: T | null | undefined): T | null {
  return value && Object.keys(value).length > 0 ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ledgerRow(envelope: EventEnvelope, malware: boolean): DecisionLedgerEntry {
  const actor: EventActor | undefined = envelope.actor;
  const row = new DecisionLedgerEntry();
  row.id = envelope.id;
  row.createdAt = new Date(envelope.time);
  row.decision = envelope.type;
  row.malware = malware;
  row.ecosystem = (envelope.target?.ecosystem ?? '').slice(0, 32);
  row.packageName = (envelope.target?.name ?? '').slice(0, 512);
  row.resolvedVersion = envelope.target?.version?.slice(0, 128) ?? null;
  row.repository = envelope.target?.repository?.slice(0, 128) ?? null;
  row.policyId = envelope.policy?.id && UUID.test(envelope.policy.id) ? envelope.policy.id : null;
  row.policyName = envelope.policy?.name?.slice(0, 256) ?? null;
  row.conditionReasons = envelope.reasons ?? null;
  row.requester = actor?.name?.slice(0, 256) ?? null;
  row.requesterIp = actor?.ip?.slice(0, 64) ?? null;
  row.userAgent = actor?.userAgent ?? null;
  row.actorKind = actor?.kind ?? null;
  row.actorId = actor?.id?.slice(0, 64) ?? null;
  row.authMethod = actor?.authMethod?.slice(0, 16) ?? null;
  row.actorMetadata = nullIfEmpty(actor?.metadata ?? null);
  row.details = nullIfEmpty(envelope.details ?? null);
  return row;
}

export function auditRow(envelope: EventEnvelope): AuditEvent {
  const actor = envelope.actor;
  const target = envelope.target;
  const row = new AuditEvent();
  row.id = envelope.id;
  row.createdAt = new Date(envelope.time);
  row.type = envelope.type.slice(0, 48);
  row.actorKind = actor?.kind ?? 'system';
  row.actorId = actor?.id?.slice(0, 64) ?? null;
  row.actorName = actor?.name?.slice(0, 256) ?? null;
  row.actorIp = actor?.ip?.slice(0, 64) ?? null;
  row.actorUserAgent = actor?.userAgent ?? null;
  row.actorAuthMethod = actor?.authMethod?.slice(0, 16) ?? null;
  row.actorMetadata = nullIfEmpty(actor?.metadata ?? null);
  row.targetKind = target?.kind?.slice(0, 32) ?? null;
  row.targetId = target?.id?.slice(0, 128) ?? null;
  row.targetName = target?.name?.slice(0, 512) ?? null;
  row.targetEcosystem = target?.ecosystem?.slice(0, 32) ?? null;
  row.targetVersion = target?.version?.slice(0, 128) ?? null;
  row.targetRepository = target?.repository?.slice(0, 128) ?? null;
  row.summary = envelope.summary.slice(0, 500);
  row.reasons = envelope.reasons ?? null;
  row.details = nullIfEmpty(envelope.details ?? null);
  return row;
}

function logLost(kind: string, err: unknown, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: `${kind} row lost`,
      reason: err instanceof Error ? err.message : String(err),
      ...fields,
    })
  );
}

function insertAuditEvent(db: DataSource, envelope: EventEnvelope): void {
  const lost = (err: unknown) => {
    auditRowsLostTotal.inc({ type: envelope.type });
    logLost('Audit Log', err, { type: envelope.type, id: envelope.id });
  };
  try {
    void db.getRepository(AuditEvent).insert(auditRow(envelope) as never).catch(lost);
  } catch (err) {
    lost(err);
  }
}

/* ---------- Batched ledger writes (L5): one multi-row INSERT every 1 s or at 100 rows. ---------- */

const LEDGER_BATCH = 100;
const LEDGER_FLUSH_MS = 1_000;

type LedgerBuffer = { rows: DecisionLedgerEntry[]; timer: NodeJS.Timeout | null; writing: Promise<void> };

const buffers = new Map<DataSource, LedgerBuffer>();

function bufferFor(db: DataSource): LedgerBuffer {
  let buffer = buffers.get(db);
  if (!buffer) {
    buffer = { rows: [], timer: null, writing: Promise.resolve() };
    buffers.set(db, buffer);
  }
  return buffer;
}

function queueLedgerRow(db: DataSource, row: DecisionLedgerEntry): void {
  const buffer = bufferFor(db);
  buffer.rows.push(row);
  if (buffer.rows.length >= LEDGER_BATCH) {
    void flushLedger(db);
    return;
  }
  if (!buffer.timer) {
    buffer.timer = setTimeout(() => void flushLedger(db), LEDGER_FLUSH_MS);
    buffer.timer.unref?.();
  }
}

/** Writes what is buffered. Called by the timer, at 100 rows, and on shutdown (SIGTERM). */
export function flushLedger(db: DataSource): Promise<void> {
  const buffer = bufferFor(db);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = null;
  const rows = buffer.rows.splice(0, buffer.rows.length);
  if (rows.length === 0) return buffer.writing;
  buffer.writing = buffer.writing.then(async () => {
    for (let i = 0; i < rows.length; i += LEDGER_BATCH) {
      const chunk = rows.slice(i, i + LEDGER_BATCH);
      try {
        await db.createQueryBuilder().insert().into(DecisionLedgerEntry).values(chunk as never[]).orIgnore().execute();
      } catch (err) {
        for (const row of chunk) ledgerRowsLostTotal.inc({ decision: row.decision });
        logLost('Decision Ledger', err, { rows: chunk.length, decision: chunk[0]?.decision });
      }
    }
  });
  return buffer.writing;
}

/** Flushes every buffer. */
export async function flushAllLedgers(): Promise<void> {
  await Promise.all([...buffers.keys()].map((db) => flushLedger(db)));
}

export function pendingLedgerRows(db: DataSource): number {
  return buffers.get(db)?.rows.length ?? 0;
}
