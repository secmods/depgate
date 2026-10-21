import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG,
  catalogEntry,
  catalogKeys,
  eventKey,
  normalizeSelection,
  recommendedSelection,
  selectedKeys,
  selects,
} from './catalog.js';
import { buildEnvelope } from './envelope.js';
import { bindPublisher, flushLedger, recordEvent } from './record.js';
import { legacyToEvent, mapLegacyType, SYNC_TYPES } from './legacy.js';
import { computeSnapshot, publish, setSnapshotForTest, streamsFor, useProducerForTest } from './streams.js';
import { pendingCountsForTest, resetSummaryState } from './summary.js';
import { fakeEventDb } from '../../test-support/event-db.js';
import type { ResolvedDestination } from './destinations/config.js';

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'test-support') out.push(...sources(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('event catalog (§6.3)', () => {
  it('lists every key once', () => {
    const keys = catalogKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists every type a producer publishes, and every type the old ledger is renamed to', () => {
    const published = new Set<string>();
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8');
      // recordEvent({ type: 'X', … }) and the old-shape logAudit({ decision: 'X' }) call sites.
      for (const match of text.matchAll(/\btype: '([A-Z][A-Z_]+)'/g)) published.add(match[1]);
      for (const match of text.matchAll(/\bdecision: '([A-Z][A-Z_]+)'/g)) published.add(match[1]);
    }
    const mapped = new Set<string>();
    for (const type of published) {
      const next = mapLegacyType({ decision: type, packageName: 'x', conditionReasons: [] });
      if (next) mapped.add(next);
    }
    // Not events: policy rule values and the test event, which is never published.
    const notEvents = new Set(['BLOCK', 'HOLD', 'STREAM_TEST', 'JOB_SKIPPED', 'ASC', 'DESC']);
    const missing = [...mapped].filter((type) => !notEvents.has(type) && !catalogEntry(type) && !type.startsWith('JOB_'));
    expect(missing).toEqual([]);
  });

  it('a whole feature includes a type added to it later; a partly selected feature does not (§10.4)', () => {
    const whole = { features: ['policies'], events: [] };
    const partial = { features: [], events: ['POLICY_CREATED'] };
    expect(selects(whole, 'policies', 'POLICY_ARCHIVED')).toBe(true);
    expect(selects(partial, 'policies', 'POLICY_ARCHIVED')).toBe(false);
    expect(selects(partial, 'policies', 'POLICY_CREATED')).toBe(true);
  });

  it('Recommended is everything except ALLOW, BLOCK_MONITOR and completed job runs', () => {
    const keys = selectedKeys(recommendedSelection());
    expect(keys.has('ALLOW')).toBe(false);
    expect(keys.has('BLOCK_MONITOR')).toBe(false);
    expect([...keys].some((key) => key.startsWith('JOB_SUCCEEDED:'))).toBe(false);
    expect(keys.has('BLOCK_ENFORCE')).toBe(true);
    expect(keys.has('JOB_FAILED:malicious-feed-sync')).toBe(true);
    expect(keys.has('MALWARE_REQUESTED')).toBe(true);
  });

  it('job events are selected per job, and JOB_SKIPPED counts as completed', () => {
    expect(eventKey('JOB_FAILED', 'epss-sync')).toBe('JOB_FAILED:epss-sync');
    expect(eventKey('JOB_SKIPPED', 'epss-sync')).toBe('JOB_SUCCEEDED:epss-sync');
    expect(catalogEntry('JOB_FAILED', 'epss-sync')?.feature).toBe('vulnerability');
  });

  it('normalizes a stored selection to known features and keys', () => {
    expect(normalizeSelection({ features: ['policies', 'nope'], events: ['ALLOW', 'ALLOW', 'X'] })).toEqual({
      features: ['policies'],
      events: ['ALLOW'],
    });
  });

  it('features are in the order of the left navigation, named as the UI pages', () => {
    expect(CATALOG.map((feature) => feature.label)).toEqual([
      'Decision ledger',
      'Monitoring',
      'Policies',
      'Exceptions',
      'Waiver requests',
      'Malware packages',
      'Package check',
      'Vulnerability',
      'Namespace protection',
      'Sign in',
      'Access',
      'Settings',
    ]);
  });
});

describe('envelope (§6.1)', () => {
  it('fills category, feature and severity from the catalog and leaves empty sections out', () => {
    const envelope = buildEnvelope({
      type: 'BLOCK_ENFORCE',
      actor: { kind: 'ci_token', id: 't1', name: 'payments-api-build', ip: '192.168.97.1', userAgent: 'npm/10', authMethod: 'ci_token', metadata: { buildId: '8812' } },
      target: { kind: 'package', ecosystem: 'npm', name: 'event-stream', version: '3.3.6', repository: 'default' },
      policy: { id: 'malicious', name: 'Malicious packages list' },
      reasons: ['MAL-2025-46974'],
      details: { source: { repository: 'npm/default', type: 'public' }, cves: [] },
    });
    expect(envelope).toMatchObject({
      schema: 'depgate.event/1',
      category: 'decision',
      feature: 'decisions',
      severity: 'warning',
      summary: 'Blocked npm event-stream@3.3.6: Malicious packages list',
    });
    expect(envelope.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(envelope.details).toEqual({ source: { repository: 'npm/default', type: 'public' } });
    expect(Object.keys(envelope)).toEqual(['schema', 'id', 'time', 'category', 'type', 'feature', 'severity', 'summary', 'actor', 'target', 'policy', 'reasons', 'details', 'depgate']);
    const bare = buildEnvelope({ type: 'POLICY_DELETED', actor: { kind: 'system', name: 'DepGate' } });
    expect(Object.keys(bare)).not.toContain('target');
    expect(Object.keys(bare)).not.toContain('policy');
    expect(Object.keys(bare)).not.toContain('reasons');
  });

  it('job events take the feature of their job', () => {
    expect(buildEnvelope({ type: 'JOB_FAILED', job: 'namespace-collision-check' })).toMatchObject({ category: 'job', feature: 'namespace', severity: 'error' });
    expect(buildEnvelope({ type: 'JOB_SUCCEEDED', job: 'some-new-job' })).toMatchObject({ category: 'job', feature: 'settings', severity: 'info' });
  });

  it('splits the old metadata: authMethod to the actor, the remote to details.source, the rest to the token metadata', () => {
    const event = legacyToEvent({
      ecosystem: 'npm',
      packageName: 'x',
      resolvedVersion: '1.0.0',
      decision: 'BLOCK',
      requester: 'ci-build',
      metadata: { authMethod: 'ci_token', sourceRepository: 'npm/default', sourceType: 'public', buildId: '7', sourceTypeOfMine: 'mine' },
    })!;
    expect(event.actor).toMatchObject({ kind: 'ci_token', name: 'ci-build', authMethod: 'ci_token', metadata: { buildId: '7', sourceTypeOfMine: 'mine' } });
    expect(event.details).toEqual({ source: { repository: 'npm/default', type: 'public' } });
  });

  it('every renamed type of §6.2 is rewritten by the mapping', () => {
    const renames: Record<string, string> = {
      BLOCK: 'BLOCK_ENFORCE',
      LOGIN_SUCCEEDED: 'SIGNIN_SUCCEEDED',
      LOGIN_FAILED: 'SIGNIN_FAILED',
      MALICIOUS_ADDED: 'MALWARE_ADDED',
      MALICIOUS_UPDATED: 'MALWARE_UPDATED',
      MALICIOUS_DELETED: 'MALWARE_DELETED',
      MALICIOUS_OVERRIDE_ALLOW: 'MALWARE_OVERRIDE_ALLOW',
      MALICIOUS_OVERRIDE_BLOCK: 'MALWARE_OVERRIDE_BLOCK',
      MALICIOUS_OVERRIDE_TO_CUSTOM: 'MALWARE_OVERRIDE_TO_CUSTOM',
    };
    for (const [old, next] of Object.entries(renames)) expect(mapLegacyType({ decision: old, packageName: 'x' })).toBe(next);
    expect(mapLegacyType({ decision: 'CONFIG_UPDATED', packageName: 'jobs/webhooks', conditionReasons: ['Retried job deliver (12)'] })).toBe('JOB_RETRIED');
    expect(mapLegacyType({ decision: 'CONFIG_UPDATED', packageName: 'jobs/webhooks', conditionReasons: ['Discarded failed job deliver (12)'] })).toBe('JOB_DISCARDED');
    for (const sync of SYNC_TYPES) expect(mapLegacyType({ decision: sync, packageName: 'x' })).toBeNull();
  });
});

describe('recordEvent routing (§7)', () => {
  let events: ReturnType<typeof fakeEventDb>;

  beforeEach(() => {
    events = fakeEventDb();
    resetSummaryState();
    bindPublisher(null);
  });

  const pkg = (version = '1.0.0') => ({ kind: 'package', ecosystem: 'npm', name: 'lodash', version, repository: 'default' });

  it('stores ledger decisions, counts downloads, and stores ALLOW only for a malware-listed version (D1)', async () => {
    recordEvent(events.db, { type: 'BLOCK_ENFORCE', target: pkg() });
    recordEvent(events.db, { type: 'UPSTREAM_UNAVAILABLE', target: pkg() });
    recordEvent(events.db, { type: 'ALLOW', target: pkg() });
    recordEvent(events.db, { type: 'ALLOW', target: pkg('6.6.6'), malware: true });
    recordEvent(events.db, { type: 'BLOCK_MONITOR', target: pkg() });
    await events.flush();
    expect(events.ledger.map((row) => [row.decision, row.malware])).toEqual([
      ['BLOCK_ENFORCE', false],
      ['UPSTREAM_UNAVAILABLE', false],
      ['ALLOW', true],
    ]);
    const counts = [...pendingCountsForTest().counts.values()][0];
    expect(Object.fromEntries([...counts].map(([key, n]) => [JSON.parse(key)[2], n]))).toEqual({ BLOCK_ENFORCE: 1, ALLOW: 2, BLOCK_MONITOR: 1 });
  });

  it('MALWARE_REQUESTED and DEPENDENCY_CONFUSION_BLOCKED add nothing to the counts, usage or ledger', async () => {
    recordEvent(events.db, { type: 'MALWARE_REQUESTED', target: pkg() });
    recordEvent(events.db, { type: 'DEPENDENCY_CONFUSION_BLOCKED', target: pkg() });
    await events.flush();
    expect(events.ledger).toEqual([]);
    expect(events.audit).toEqual([]);
    expect(pendingCountsForTest().counts.size).toBe(0);
  });

  it('job events and BLOCK_MONITOR are published, never stored again', async () => {
    const published: string[] = [];
    bindPublisher((envelope) => void published.push(envelope.type));
    recordEvent(events.db, { type: 'JOB_FAILED', job: 'epss-sync', target: { kind: 'job', name: 'epss-sync' } });
    recordEvent(events.db, { type: 'BLOCK_MONITOR', target: pkg() });
    await events.flush();
    expect(events.ledger).toEqual([]);
    expect(events.audit).toEqual([]);
    expect(published).toEqual(['JOB_FAILED', 'BLOCK_MONITOR']);
  });

  it('PACKAGE_CHECKED goes to the Audit Log, never the ledger or the dashboard (D5)', async () => {
    recordEvent(events.db, { type: 'PACKAGE_CHECKED', target: pkg(), actor: { kind: 'user', name: 'dev@acme.test', userAgent: 'Mozilla' } });
    await events.flush();
    expect(events.audit.map((row) => [row.type, row.actorUserAgent])).toEqual([['PACKAGE_CHECKED', 'Mozilla']]);
    expect(events.ledger).toEqual([]);
    expect(pendingCountsForTest().counts.size).toBe(0);
  });

  it('batches ledger writes: one INSERT per 100 rows, the rest within a second (L5)', async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 250; i += 1) recordEvent(events.db, { type: 'BLOCK_ENFORCE', target: pkg() });
      await Promise.resolve();
      expect(events.inserts).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(1_100);
      await flushLedger(events.db);
      expect(events.ledger).toHaveLength(250);
      expect(events.inserts).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('publish (§7, §8.1)', () => {
  type Xadd = string[];
  let calls: Xadd[];
  const ok = { status: 'ready', xadd: vi.fn(async (...args: string[]) => {
    calls.push(args);
    return '1-0';
  }) };

  beforeEach(() => {
    calls = [];
    ok.xadd.mockClear();
    useProducerForTest(ok as never);
    setSnapshotForTest({ bulk: new Set(), jsonl: null });
  });

  afterEach(() => {
    useProducerForTest(null);
    bindPublisher(null);
  });

  it('ALLOW and BLOCK_MONITOR reach the bulk stream only when selected; every other type always reaches the main stream', () => {
    recordEvent(null, { type: 'ALLOW', target: { kind: 'package', ecosystem: 'npm', name: 'a' } });
    recordEvent(null, { type: 'BLOCK_MONITOR', target: { kind: 'package', ecosystem: 'npm', name: 'a' } });
    expect(calls).toEqual([]);
    recordEvent(null, { type: 'POLICY_UPDATED' });
    recordEvent(null, { type: 'BLOCK_ENFORCE', target: { kind: 'package', ecosystem: 'npm', name: 'a' } });
    expect(calls.map((args) => [args[0].endsWith('events'), args[args.indexOf('t') + 1]])).toEqual([
      [true, 'POLICY_UPDATED'],
      [true, 'BLOCK_ENFORCE'],
    ]);
    setSnapshotForTest({ bulk: new Set(['ALLOW']), jsonl: null });
    recordEvent(null, { type: 'ALLOW', target: { kind: 'package', ecosystem: 'npm', name: 'a' } });
    recordEvent(null, { type: 'BLOCK_MONITOR', target: { kind: 'package', ecosystem: 'npm', name: 'a' } });
    expect(calls).toHaveLength(3);
    expect(calls[2][0]).toMatch(/events:bulk$/);
    expect(calls[2].slice(1, 4)).toEqual(['MAXLEN', '~', '200000']);
  });

  it('a job event carries its per-job selection key in `t`', () => {
    recordEvent(null, { type: 'JOB_FAILED', job: 'epss-sync', target: { kind: 'job', name: 'epss-sync' } });
    expect(calls[0][calls[0].indexOf('t') + 1]).toBe('JOB_FAILED:epss-sync');
    expect(calls[0][calls[0].indexOf('f') + 1]).toBe('vulnerability');
  });

  it('the webhook payload rides on the main entry as `w`, unchanged apart from the actor (W7, W8)', () => {
    const payload = { event: 'package_blocked' as const, timestamp: 't', ecosystem: 'npm', packageName: 'a', version: '1', decision: 'BLOCK', policyId: 'p', policyName: 'P', reasons: ['r'] };
    recordEvent(null, {
      type: 'BLOCK_ENFORCE',
      actor: { kind: 'ci_token', name: 'build', ip: '10.0.0.1', userAgent: 'npm/10', metadata: { buildId: '9' }, authMethod: 'ci_token' },
      target: { kind: 'package', ecosystem: 'npm', name: 'a' },
      webhookPayload: payload,
    });
    const w = JSON.parse(calls[0][calls[0].indexOf('w') + 1]);
    expect(w).toEqual({ ...payload, actor: { name: 'build', ip: '10.0.0.1', userAgent: 'npm/10', metadata: { buildId: '9' } } });
  });

  it('with Redis disconnected the XADD is not attempted, and a webhook event is delivered inline (W6, R-D16)', async () => {
    const inline = vi.fn(async () => undefined);
    useProducerForTest({ status: 'reconnecting', xadd: ok.xadd } as never, {} as never, inline);
    recordEvent(null, { type: 'POLICY_UPDATED' });
    recordEvent(null, { type: 'BLOCK_ENFORCE', target: { kind: 'package', ecosystem: 'npm', name: 'a' }, webhookPayload: { event: 'package_blocked', timestamp: 't' } });
    expect(ok.xadd).not.toHaveBeenCalled();
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('a failing XADD falls back to inline delivery too', async () => {
    const inline = vi.fn(async () => undefined);
    useProducerForTest({ status: 'ready', xadd: vi.fn(async () => Promise.reject(new Error("Stream isn't writeable and enableOfflineQueue options is false"))) } as never, {} as never, inline);
    recordEvent(null, { type: 'BLOCK_ENFORCE', target: { kind: 'package', ecosystem: 'npm', name: 'a' }, webhookPayload: { event: 'package_blocked', timestamp: 't' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it('JSON lines writes the events its selection includes, with "log": "depgate.event"', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      setSnapshotForTest({ bulk: new Set(), jsonl: { features: [], events: ['ALLOW'] } });
      publish(buildEnvelope({ type: 'ALLOW', target: { kind: 'package', ecosystem: 'npm', name: 'a' } }), JSON.stringify(buildEnvelope({ type: 'ALLOW' })));
      publish(buildEnvelope({ type: 'POLICY_UPDATED' }), '{"schema":"depgate.event/1"}');
    } finally {
      spy.mockRestore();
    }
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ log: 'depgate.event', type: 'ALLOW' });
  });
});

describe('selection snapshot', () => {
  const dest = (over: Partial<ResolvedDestination>): ResolvedDestination => ({
    id: 'd',
    name: 'd',
    type: 'splunk',
    enabled: true,
    settings: {},
    secrets: {},
    selection: { features: [], events: [] },
    ...over,
  });

  it('bulk types come from enabled HTTP and Syslog destinations; JSON lines has its own selection', () => {
    const snapshot = computeSnapshot([
      dest({ selection: { features: ['monitoring'], events: [] } }),
      dest({ enabled: false, selection: { features: [], events: ['ALLOW'] } }),
      dest({ type: 'jsonl', selection: { features: [], events: ['ALLOW'] } }),
    ]);
    expect([...snapshot.bulk]).toEqual(['BLOCK_MONITOR']);
    expect(snapshot.jsonl).toEqual({ features: [], events: ['ALLOW'] });
  });

  it('a destination needs a group only on the streams its selection uses (R-D1, R-D4)', () => {
    expect(streamsFor({ features: ['monitoring'], events: [] })).toEqual(['bulk']);
    expect(streamsFor({ features: ['policies'], events: [] })).toEqual(['main']);
    expect(streamsFor({ features: ['decisions'], events: [] })).toEqual(['main', 'bulk']);
  });
});
