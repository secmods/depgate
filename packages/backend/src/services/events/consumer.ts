import os from 'node:os';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import { config } from '../../config.js';
import { scrubError } from '../jobs/ids.js';
import { selects, type EventSelection } from './catalog.js';
import type { ResolvedDestination } from './destinations/config.js';
import type { StreamEvent } from './destinations/formatters.js';
import { createSender, type Sender, type SendOutcome } from './destinations/senders.js';
import { streamBatchSeconds, streamDroppedTotal, streamLagSeconds, streamSentTotal } from './metrics.js';
import { noteDropped, noteError, notePaused, noteSent, setLag } from './status.js';
import { loadDestinations, streamKey, streamsFor, type Log } from './streams.js';
import { dgKey, flushSummaries } from './summary.js';

/**
 * Stream consumers (requirements_event_streaming.md §8.1–§8.3). Every worker replica is a consumer in every
 * destination's group, so Redis hands each entry to one of them: no duplicates, no leases, and throughput
 * grows with each replica. Reads are non-blocking on one shared connection (R-D17); a second connection
 * carries acknowledgements, claims and status.
 */

export const BATCH_EVENTS = 500;
export const BATCH_BYTES = 1_000_000;
export const BATCH_WAIT_MS = 2_000;
const POLL_MS = 500;
const CLAIM_IDLE_MS = 60_000;
const CLAIM_REFRESH_MS = 30_000;
const AUTOCLAIM_EVERY_MS = 30_000;
const AUTH_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const CONSUMER_IDLE_DELETE_MS = 3_600_000;
const MONITOR_MS = 30_000;
const REFRESH_MS = 3_000;
const FLUSH_MS = 30_000;
const SCHEMA_PREFIX = '{"schema":"depgate.event/1"';

export const WEBHOOK_GROUP = 'webhooks';

export function groupName(destinationId: string): string {
  return `dest:${destinationId}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

function isNoGroup(err: unknown): boolean {
  return String((err as Error)?.message ?? err).includes('NOGROUP');
}

/**
 * Creates a group at `$` with ENTRIESREAD set to the stream's entries-added, atomically, so its read counter is
 * valid from the start and losses can be computed (a group made on an empty stream would otherwise have none).
 * Returns false when the group already exists.
 */
const CREATE_GROUP = `
local ok = pcall(redis.call, 'XGROUP', 'CREATE', KEYS[1], ARGV[1], '$', 'MKSTREAM')
if not ok then return 0 end
local info = redis.call('XINFO', 'STREAM', KEYS[1])
local added = 0
for i = 1, #info, 2 do if info[i] == 'entries-added' then added = info[i + 1] end end
redis.call('XGROUP', 'SETID', KEYS[1], ARGV[1], '$', 'ENTRIESREAD', added)
return 1
`;

export async function createGroup(redis: Redis, key: string, group: string): Promise<boolean> {
  return Number(await redis.eval(CREATE_GROUP, 1, key, group)) === 1;
}

/**
 * Creates the destination's groups on the streams its selection needs (new events only, `$`) and removes the
 * others. Called when a destination is saved, before the selection broadcast (§8.2), and at worker start.
 */
export async function ensureGroups(redis: Redis, dest: Pick<ResolvedDestination, 'id' | 'type' | 'enabled' | 'selection'>): Promise<void> {
  const wanted = dest.enabled && dest.type !== 'jsonl' ? streamsFor(dest.selection) : [];
  for (const stream of ['main', 'bulk'] as const) {
    const key = streamKey(stream);
    if (wanted.includes(stream)) {
      await createGroup(redis, key, groupName(dest.id));
    } else {
      await redis.xgroup('DESTROY', key, groupName(dest.id)).catch(() => undefined);
    }
  }
}

export async function destroyGroups(redis: Redis, destinationId: string): Promise<void> {
  for (const stream of ['main', 'bulk'] as const) {
    await redis.xgroup('DESTROY', streamKey(stream), groupName(destinationId)).catch(() => undefined);
  }
}

export async function ensureWebhookGroup(redis: Redis): Promise<void> {
  await createGroup(redis, streamKey('main'), WEBHOOK_GROUP);
}

type RawEntry = [string, string[]] | null;

export function fieldsOf(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  return out;
}

function pairs(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = raw[i + 1];
  return out;
}

/** `1697…-3` → [ms, seq] for ordering. */
export function compareIds(a: string, b: string): number {
  const [am, as] = a.split('-').map((part) => BigInt(part || '0'));
  const [bm, bs] = b.split('-').map((part) => BigInt(part || '0'));
  if (am !== bm) return am < bm ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return 0;
}

function idMs(id: string): number {
  return Number(id.split('-')[0]);
}

/** Whether a destination's selection includes an entry, by its `t` and `f` fields only (R-D2). */
export function entrySelected(selection: EventSelection, fields: Record<string, string>): boolean {
  return selects(selection, fields.f ?? '', fields.t ?? '');
}

/**
 * Reads for a group, first counting entries the stream trimmed before the group read them (R-D12). Atomic, so
 * a slow consumer can never jump a gap uncounted and two replicas never count the same gap: when the group's
 * last-delivered ID is older than the stream's first entry, the trimmed-unread entries are
 * `entries-added − length − entries-read`, and the group is moved to just before the first entry with
 * ENTRIESREAD set, so the same gap counts once. ARGV[3] = 0 checks without reading (the 30-second check).
 */
const GAP_READ = `
local key, group, consumer, count = KEYS[1], ARGV[1], ARGV[2], tonumber(ARGV[3])
local function fields(arr)
  local out = {}
  for i = 1, #arr, 2 do out[arr[i]] = arr[i + 1] end
  return out
end
local function parse(id)
  local dash = string.find(id, '-', 1, true)
  return tonumber(string.sub(id, 1, dash - 1)), tonumber(string.sub(id, dash + 1))
end
local function older(a, b)
  local am, as = parse(a)
  local bm, bs = parse(b)
  if am ~= bm then return am < bm end
  return as < bs
end
local lost = -1
local ok, stream = pcall(redis.call, 'XINFO', 'STREAM', key)
if ok then
  local info = fields(stream)
  local first = info['first-entry']
  local length = tonumber(info['length'])
  local added = tonumber(info['entries-added'])
  if first and length > 0 then
    local firstId = first[1]
    for _, raw in ipairs(redis.call('XINFO', 'GROUPS', key)) do
      local g = fields(raw)
      if g['name'] == group then
        local last = g['last-delivered-id']
        if older(last, firstId) then
          local read = g['entries-read']
          if read then lost = math.max(added - length - tonumber(read), 0) else lost = 0 end
          local fm, fs = parse(firstId)
          local before = (fs > 0) and (string.format('%d', fm) .. '-' .. string.format('%d', fs - 1)) or (string.format('%d', fm - 1) .. '-18446744073709551615')
          redis.call('XGROUP', 'SETID', key, group, before, 'ENTRIESREAD', added - length)
        end
      end
    end
  end
end
if count > 0 then
  return { lost, redis.call('XREADGROUP', 'GROUP', group, consumer, 'COUNT', count, 'STREAMS', key, '>') }
end
return { lost, false }
`;

/** Runs GAP_READ. Returns the lost count (0 when none) and the read entries. */
export async function gapRead(redis: Redis, key: string, group: string, consumer: string, count: number): Promise<{ lost: number; entries: RawEntry[] }> {
  const reply = (await redis.eval(GAP_READ, 1, key, group, consumer, String(count))) as [number, Array<[string, RawEntry[]]> | null | false];
  const lost = Math.max(Number(reply?.[0] ?? 0), 0);
  const streams = reply?.[1];
  return { lost, entries: streams ? (streams[0]?.[1] ?? []) : [] };
}

type Batch = { events: StreamEvent[]; bytes: number; firstAt: number };

/** One destination on one stream. At most one batch in flight per loop, so two per destination per replica (L4). */
class DestinationLoop {
  stopped = false;
  private batch: Batch = { events: [], bytes: 0, firstAt: 0 };
  private lastAutoclaim = 0;
  private autoclaimCursor = '0-0';
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: EventWorker,
    readonly dest: ResolvedDestination,
    readonly stream: 'main' | 'bulk',
    private readonly sender: Sender
  ) {}

  get key(): string {
    return streamKey(this.stream);
  }

  get group(): string {
    return groupName(this.dest.id);
  }

  start(): void {
    this.done = this.run().catch((err) => this.worker.log.warn({ err: scrubError(String(err?.message ?? err)), destination: this.dest.name }, 'Stream consumer stopped'));
  }

  private accept(entries: RawEntry[], toAck: string[]): void {
    for (const entry of entries) {
      if (!entry) continue;
      const [id, raw] = entry;
      const fields = fieldsOf(raw);
      if (!fields.e || !entrySelected(this.dest.selection, fields)) {
        toAck.push(id);
        continue;
      }
      if (!fields.e.startsWith(SCHEMA_PREFIX)) {
        // A newer replica in a rolling deploy wrote a schema this one cannot format.
        toAck.push(id);
        streamDroppedTotal.inc({ destination: this.dest.name, reason: 'unknown_type' });
        void noteDropped(this.worker.control, this.dest.id, 'unknown_type', 1).catch(() => undefined);
        continue;
      }
      if (this.batch.events.length === 0) this.batch.firstAt = Date.now();
      this.batch.events.push({ entryId: id, key: fields.t, feature: fields.f, json: fields.e });
      this.batch.bytes += fields.e.length;
    }
  }

  private full(): boolean {
    return this.batch.events.length >= BATCH_EVENTS || this.batch.bytes >= BATCH_BYTES;
  }

  private async read(): Promise<number> {
    const room = BATCH_EVENTS - this.batch.events.length;
    if (room <= 0) return 0;
    const toAck: string[] = [];
    let read = 0;
    const now = Date.now();
    if (now - this.lastAutoclaim >= AUTOCLAIM_EVERY_MS) {
      this.lastAutoclaim = now;
      // Entries a crashed consumer read but never acknowledged (R-D11). Trimmed ones come back as deleted IDs.
      const reply = (await this.worker.control.call('XAUTOCLAIM', this.key, this.group, this.worker.consumer, String(CLAIM_IDLE_MS), this.autoclaimCursor, 'COUNT', String(room))) as [string, RawEntry[], string[]?];
      this.autoclaimCursor = reply?.[0] ?? '0-0';
      const claimed = reply?.[1] ?? [];
      read += claimed.length;
      this.accept(claimed, toAck);
      const deleted = reply?.[2] ?? [];
      if (deleted.length) await this.worker.control.xack(this.key, this.group, ...deleted);
    }
    const left = BATCH_EVENTS - this.batch.events.length;
    if (left > 0) {
      const { lost, entries } = await gapRead(this.worker.reader, this.key, this.group, this.worker.consumer, left);
      if (lost > 0) await this.worker.noteLoss(this.dest, this.stream, lost);
      read += entries.length;
      this.accept(entries, toAck);
    }
    if (toAck.length) await this.worker.control.xack(this.key, this.group, ...toAck);
    return read;
  }

  private async run(): Promise<void> {
    while (!this.stopped && !this.worker.stopping) {
      try {
        const pausedUntil = await notePaused(this.worker.control, this.dest.id);
        if (pausedUntil && pausedUntil > Date.now() && this.batch.events.length > 0) {
          await this.holdUntil(pausedUntil);
          continue;
        }
        const read = await this.read();
        const ready = this.full() || (this.batch.events.length > 0 && Date.now() - this.batch.firstAt >= BATCH_WAIT_MS);
        if (!ready) {
          // A full read means more is waiting: read again at once.
          if (read < BATCH_EVENTS) await sleep(POLL_MS);
          continue;
        }
        await this.deliver();
      } catch (err) {
        if (isNoGroup(err)) await ensureGroups(this.worker.control, this.dest).catch(() => undefined);
        else this.worker.log.warn({ err: scrubError(String((err as Error)?.message ?? err)), destination: this.dest.name }, 'Stream consumer error');
        await sleep(1_000);
      }
    }
  }

  /** Resets the idle time of the held entries so XAUTOCLAIM never gives them to another consumer (R-D8). */
  private async refreshClaim(): Promise<void> {
    const ids = this.batch.events.map((event) => event.entryId);
    if (ids.length === 0) return;
    await this.worker.control.call('XCLAIM', this.key, this.group, this.worker.consumer, '0', ...ids, 'JUSTID').catch(() => undefined);
  }

  private async holdUntil(until: number): Promise<void> {
    while (!this.stopped && !this.worker.stopping && Date.now() < until) {
      await this.refreshClaim();
      await sleep(Math.min(CLAIM_REFRESH_MS, Math.max(until - Date.now(), 0)));
    }
  }

  private async ack(events: StreamEvent[]): Promise<void> {
    const ids = events.map((event) => event.entryId).filter(Boolean);
    if (ids.length) await this.worker.control.xack(this.key, this.group, ...ids);
  }

  private async deliver(): Promise<void> {
    let backoff = 1_000;
    while (!this.stopped && !this.worker.stopping && this.batch.events.length > 0) {
      const events = this.batch.events;
      const end = streamBatchSeconds.startTimer({ destination: this.dest.name });
      let outcome: SendOutcome;
      try {
        outcome = await this.sender.send(events);
      } catch (err) {
        outcome = { kind: 'retry', status: null, error: scrubError(String((err as Error)?.message ?? err)) };
      }
      end();
      const control = this.worker.control;
      if (outcome.kind === 'ok') {
        const retry = new Set((outcome.retry ?? []).map((event) => event.entryId));
        const accepted = events.filter((event) => !retry.has(event.entryId));
        await this.ack(accepted);
        const rejected = outcome.rejected ?? 0;
        const sent = accepted.length - rejected;
        streamSentTotal.inc({ destination: this.dest.name }, sent);
        await noteSent(control, this.dest.id, sent).catch(() => undefined);
        if (rejected) {
          streamDroppedTotal.inc({ destination: this.dest.name, reason: 'rejected' }, rejected);
          await noteDropped(control, this.dest.id, 'rejected', rejected).catch(() => undefined);
          await noteError(control, this.dest.id, 'healthy', outcome.error ?? 'Rejected by the destination').catch(() => undefined);
        }
        const kept = events.filter((event) => retry.has(event.entryId));
        this.batch = { events: kept, bytes: kept.reduce((n, event) => n + event.json.length, 0), firstAt: kept.length ? Date.now() : 0 };
        if (kept.length === 0) return;
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      if (outcome.kind === 'reject') {
        // DepGate builds every event, so a rejected batch is a bug to fix, not a reason to block the stream (R-D9).
        await this.ack(events);
        streamDroppedTotal.inc({ destination: this.dest.name, reason: 'rejected' }, events.length);
        await noteDropped(control, this.dest.id, 'rejected', events.length).catch(() => undefined);
        await noteError(control, this.dest.id, 'healthy', outcome.error).catch(() => undefined);
        this.batch = { events: [], bytes: 0, firstAt: 0 };
        return;
      }
      if (outcome.kind === 'auth') {
        // Every consumer pauses the destination; events keep buffering; retried every 5 minutes (R-D10).
        const until = Date.now() + AUTH_RETRY_MS;
        await noteError(control, this.dest.id, 'auth_failed', outcome.error, until).catch(() => undefined);
        await this.holdUntil(until);
        continue;
      }
      await noteError(control, this.dest.id, 'retrying', outcome.error).catch(() => undefined);
      await this.wait(outcome.retryAfterMs ?? backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  /** Backoff that keeps the claim fresh. */
  private async wait(ms: number): Promise<void> {
    await this.holdUntil(Date.now() + Math.min(Math.max(ms, 0), MAX_BACKOFF_MS));
  }
}

export type WebhookBatchHandler = (items: Array<{ eventId: string; payload: Record<string, unknown> }>) => Promise<void>;

/** The `webhooks` group on the main stream (W1, W5). */
class WebhookLoop {
  stopped = false;
  private lastAutoclaim = 0;
  done: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: EventWorker,
    private readonly handle: WebhookBatchHandler
  ) {}

  start(): void {
    this.done = this.run();
  }

  private async run(): Promise<void> {
    const key = streamKey('main');
    await ensureWebhookGroup(this.worker.control).catch(() => undefined);
    while (!this.stopped && !this.worker.stopping) {
      try {
        let entries: RawEntry[] = [];
        if (Date.now() - this.lastAutoclaim >= AUTOCLAIM_EVERY_MS) {
          this.lastAutoclaim = Date.now();
          const reply = (await this.worker.control.call('XAUTOCLAIM', key, WEBHOOK_GROUP, this.worker.consumer, String(CLAIM_IDLE_MS), '0-0', 'COUNT', '100')) as [string, RawEntry[], string[]?];
          entries = reply?.[1] ?? [];
          if (reply?.[2]?.length) await this.worker.control.xack(key, WEBHOOK_GROUP, ...reply[2]);
        }
        const reply = (await this.worker.reader.xreadgroup('GROUP', WEBHOOK_GROUP, this.worker.consumer, 'COUNT', 100, 'STREAMS', key, '>')) as Array<[string, RawEntry[]]> | null;
        entries = [...entries, ...(reply?.[0]?.[1] ?? [])];
        if (entries.length === 0) {
          await sleep(POLL_MS);
          continue;
        }
        const items: Array<{ eventId: string; payload: Record<string, unknown> }> = [];
        const ids: string[] = [];
        for (const entry of entries) {
          if (!entry) continue;
          ids.push(entry[0]);
          const fields = fieldsOf(entry[1]);
          if (!fields.w) continue;
          try {
            const eventId = fields.e?.match(/"id":"([^"]+)"/)?.[1] ?? '';
            items.push({ eventId, payload: JSON.parse(fields.w) });
          } catch {
            /* not a payload we can send */
          }
        }
        if (items.length) await this.handle(items);
        if (ids.length) await this.worker.control.xack(key, WEBHOOK_GROUP, ...ids);
        if (entries.length < 100) await sleep(POLL_MS);
      } catch (err) {
        if (isNoGroup(err)) await ensureWebhookGroup(this.worker.control).catch(() => undefined);
        else this.worker.log.warn({ err: scrubError(String((err as Error)?.message ?? err)) }, 'Webhook stream consumer error');
        await sleep(1_000);
      }
    }
  }
}

/** One worker replica's consumers, summary flush and stream monitor. */
export class EventWorker {
  readonly consumer = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  readonly reader: Redis;
  readonly control: Redis;
  stopping = false;
  private loops = new Map<string, { loop: DestinationLoop; signature: string; sender: Sender }>();
  private webhookLoop: WebhookLoop | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: DataSource,
    readonly log: Log,
    private readonly opts: { destinations: boolean; webhooks: WebhookBatchHandler | null; url?: string }
  ) {
    const url = opts.url ?? config.jobs.redisUrl;
    const options = { protocol: 2 as const, maxRetriesPerRequest: 2, retryStrategy: (times: number) => Math.min(times * 200, 5_000) };
    this.reader = new Redis(url, options);
    this.control = new Redis(url, options);
    this.reader.on('error', () => undefined);
    this.control.on('error', () => undefined);
  }

  async start(): Promise<void> {
    if (this.opts.destinations) {
      await this.refresh();
      this.every(REFRESH_MS, () => this.refresh());
      this.every(MONITOR_MS, () => this.checkStreams());
      this.every(FLUSH_MS, () => this.flush());
    }
    if (this.opts.webhooks) {
      this.webhookLoop = new WebhookLoop(this, this.opts.webhooks);
      this.webhookLoop.start();
    }
  }

  private every(ms: number, fn: () => Promise<void>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopping) return;
      running = true;
      fn()
        .catch((err) => this.log.warn({ err: scrubError(String((err as Error)?.message ?? err)) }, 'Event worker task failed'))
        .finally(() => {
          running = false;
        });
    }, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private async flush(): Promise<void> {
    await flushSummaries(this.db, this.control);
  }

  /** Starts, restarts and stops loops to match the saved destinations. */
  async refresh(): Promise<void> {
    const destinations = (await loadDestinations(this.db)).filter((dest) => dest.enabled && dest.type !== 'jsonl');
    const wanted = new Map<string, { dest: ResolvedDestination; stream: 'main' | 'bulk'; signature: string }>();
    for (const dest of destinations) {
      const signature = JSON.stringify([dest.name, dest.settings, dest.secrets, dest.selection]);
      for (const stream of streamsFor(dest.selection)) wanted.set(`${dest.id}:${stream}`, { dest, stream, signature });
    }
    for (const [id, current] of this.loops) {
      const next = wanted.get(id);
      if (next && next.signature === current.signature) continue;
      current.loop.stopped = true;
      this.loops.delete(id);
      if (![...this.loops.values()].some((other) => other.loop.dest.id === current.loop.dest.id)) current.sender.close();
    }
    for (const [id, next] of wanted) {
      if (this.loops.has(id)) continue;
      await ensureGroups(this.control, next.dest).catch(() => undefined);
      const shared = [...this.loops.values()].find((other) => other.loop.dest.id === next.dest.id && other.signature === next.signature);
      const sender = shared?.sender ?? createSender(next.dest);
      if (!sender) continue;
      const loop = new DestinationLoop(this, next.dest, next.stream, sender);
      this.loops.set(id, { loop, signature: next.signature, sender });
      loop.start();
    }
  }

  /** Every 30 s, by one replica: lost-event counting (R-D12), lag, and removal of dead consumers (R-D11). */
  async checkStreams(opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force) {
      const lock = await this.control.set(dgKey('events:monitor'), this.consumer, 'PX', MONITOR_MS - 5_000, 'NX');
      if (lock !== 'OK') return;
    }
    const destinations = (await loadDestinations(this.db)).filter((dest) => dest.enabled && dest.type !== 'jsonl');
    const lag = new Map<string, number>();
    for (const stream of ['main', 'bulk'] as const) {
      const key = streamKey(stream);
      let groups: Array<Record<string, unknown>>;
      try {
        groups = ((await this.control.call('XINFO', 'GROUPS', key)) as unknown[]).map(pairs);
      } catch {
        continue;
      }
      for (const group of groups) {
        const name = String(group['name']);
        const last = String(group['last-delivered-id'] ?? '0-0');
        const dest = name.startsWith('dest:') ? destinations.find((row) => groupName(row.id) === name) : undefined;
        if (dest) {
          // Nobody may be reading this group (destination down, consumers paused or gone): count its gap here.
          const { lost } = await gapRead(this.control, key, name, this.consumer, 0);
          if (lost > 0) await this.noteLoss(dest, stream, lost);
        }
        if (dest) {
          let oldest: number | null = null;
          const pending = (await this.control.call('XPENDING', key, name).catch(() => null)) as [number, string | null, string | null, unknown] | null;
          if (pending && Number(pending[0]) > 0 && pending[1]) oldest = idMs(pending[1]);
          else if (Number(group['lag'] ?? 0) > 0 || group['lag'] === null) {
            const next = (await this.control.xrange(key, `(${last}`, '+', 'COUNT', 1).catch(() => [])) as Array<[string, string[]]>;
            if (next[0]) oldest = idMs(next[0][0]);
          }
          const seconds = oldest === null ? 0 : Math.max((Date.now() - oldest) / 1000, 0);
          lag.set(dest.id, Math.max(lag.get(dest.id) ?? 0, seconds));
        }
        const consumers = ((await this.control.call('XINFO', 'CONSUMERS', key, name).catch(() => [])) as unknown[]).map(pairs);
        for (const consumer of consumers) {
          if (Number(consumer['pending'] ?? 0) === 0 && Number(consumer['idle'] ?? 0) > CONSUMER_IDLE_DELETE_MS) {
            await this.control.call('XGROUP', 'DELCONSUMER', key, name, String(consumer['name'])).catch(() => undefined);
          }
        }
      }
    }
    for (const dest of destinations) {
      const seconds = lag.get(dest.id) ?? 0;
      streamLagSeconds.set({ destination: dest.name }, seconds);
      await setLag(this.control, dest.id, seconds).catch(() => undefined);
    }
  }

  /** Lost events of a destination: counted, shown on its row, and logged (D10: never silent). */
  async noteLoss(dest: ResolvedDestination, stream: 'main' | 'bulk', lost: number): Promise<void> {
    streamDroppedTotal.inc({ destination: dest.name, reason: 'buffer_full' }, lost);
    await noteDropped(this.control, dest.id, 'buffer_full', lost).catch(() => undefined);
    this.log.warn({ destination: dest.name, stream, lost }, 'Events lost: the stream buffer was full while the destination was behind');
  }

  async stop(graceMs = 10_000): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const loops = [...this.loops.values()];
    for (const { loop } of loops) loop.stopped = true;
    if (this.webhookLoop) this.webhookLoop.stopped = true;
    const all = Promise.all([...loops.map(({ loop }) => loop.done), this.webhookLoop?.done ?? Promise.resolve()]);
    await Promise.race([all, sleep(graceMs)]);
    for (const { sender } of loops) sender.close();
    this.loops.clear();
    // A last flush, so counts taken from Redis by this replica are not left in a flush key for a minute.
    if (this.opts.destinations) await flushSummaries(this.db, this.control).catch(() => undefined);
    this.reader.disconnect();
    this.control.disconnect();
  }
}

/** `events` in WORKERS (or `all`): stream consumers, summary flush, retention purge (L6). */
export function eventsWorkerEnabled(setting = config.jobs.workers): boolean {
  const text = setting.trim().toLowerCase();
  if (text === '' || text === 'all') return true;
  if (text === 'none') return false;
  return text.split(',').map((part) => part.trim()).includes('events');
}

export function webhooksWorkerEnabled(setting = config.jobs.workers): boolean {
  const text = setting.trim().toLowerCase();
  if (text === '' || text === 'all') return true;
  if (text === 'none') return false;
  return text.split(',').map((part) => part.trim()).includes('webhooks');
}
