/**
 * Event split and Log Streaming (requirements_event_streaming.md §15, integration). Requires PostgreSQL 15+
 * and Redis 7 (RUN_INTEGRATION=1). Every test tags its data with a unique repository or package name, so it
 * runs against a database that already holds other rows.
 */
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { flushLedger, recordEvent } from '../services/events/record.js';
import { flushOne, upsertCounts, upsertUsage, dgKey } from '../services/events/summary.js';
import { migrateBatch, runEventMigration } from '../services/events/migration.js';
import { EventWorker } from '../services/events/consumer.js';
import { streamKey } from '../services/events/streams.js';
import { deliverStreamBatch } from '../services/webhook-delivery.js';

const tag = randomBytes(3).toString('hex');

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!process.env.RUN_INTEGRATION)('events: ledger, audit log, summaries, streaming', () => {
  let app: FastifyInstance;
  let token: string;
  let receiver: Server;
  let received: Array<{ path: string; body: string; auth?: string }> = [];
  let port = 0;

  const api = () => supertest(app.server);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const creds of [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ]) {
      const res = await api().post('/api/auth/login').send(creds);
      if (res.status === 200) {
        token = res.body.token;
        break;
      }
    }
    if (!token) throw new Error('Could not obtain auth token');
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        let body = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body);
        received.push({ path: req.url ?? '', body: body.toString('utf8'), auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"text":"Success","code":0}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    port = (receiver.address() as { port: number }).port;
  });

  afterAll(async () => {
    receiver?.close();
    if (app) await app.close();
  });

  it('the Decision Ledger API returns the event envelope; the old path returns the old shape', async () => {
    const repository = `it-${tag}`;
    const envelope = recordEvent(app.db, {
      type: 'BLOCK_ENFORCE',
      actor: { kind: 'ci_token', id: 't', name: `build-${tag}`, ip: '10.1.2.3', authMethod: 'ci_token', metadata: { buildId: `b-${tag}` } },
      target: { kind: 'package', ecosystem: 'npm', name: `left-pad-${tag}`, version: '1.3.0', repository },
      policy: { id: null, name: 'Block GPL' },
      reasons: ['GPL-3.0'],
      details: { source: { repository: 'npm/default', type: 'public' } },
    });
    await flushLedger(app.db);
    const res = await api().get(`/api/admin/decision-ledger?repository=${repository}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ id: envelope.id, decision: 'BLOCK_ENFORCE', build: `b-${tag}`, actor: { metadata: { buildId: `b-${tag}` } } });
    expect(res.body.items[0].event).toMatchObject({ id: envelope.id, type: 'BLOCK_ENFORCE', target: { repository }, details: { source: { type: 'public' } } });
    const meta = await api().get(`/api/admin/decision-ledger?meta=buildId=b-${tag}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(meta.body.total).toBe(1);
    const old = await api().get(`/api/admin/audit-logs?repository=${repository}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(old.headers.deprecation).toBe('true');
    expect(old.body.items[0]).toMatchObject({ decision: 'BLOCK', metadata: { buildId: `b-${tag}`, sourceRepository: 'npm/default', sourceType: 'public' } });
    await api().get('/api/admin/decision-ledger').expect(401);
  });

  it('a Package Check is one PACKAGE_CHECKED audit event with user agent and IP, and nothing else (criterion 4)', async () => {
    const pkg = `qa-missing-${tag}`;
    await api()
      .post('/api/package-check')
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', `it-agent-${tag}`)
      .send({ ecosystem: 'npm', package: pkg });
    const audit = await until(
      () => api().get(`/api/admin/audit-events?type=PACKAGE_CHECKED&target=${pkg}`).set('Authorization', `Bearer ${token}`),
      (res) => res.body.total >= 1
    );
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]).toMatchObject({ type: 'PACKAGE_CHECKED', feature: 'package_check', actor: { userAgent: `it-agent-${tag}` } });
    expect(audit.body.items[0].actor.ip).toBeTruthy();
    const ledger = await api().get(`/api/admin/decision-ledger?package=${pkg}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(ledger.body.total).toBe(0);
  });

  it('the Audit Log filters by feature, and the catalog lists the features in navigation order', async () => {
    const catalog = await api().get('/api/admin/events/catalog').set('Authorization', `Bearer ${token}`).expect(200);
    expect(catalog.body.features[0].feature).toBe('decisions');
    expect(catalog.body.presets.recommended.features).toContain('policies');
    const res = await api().get('/api/admin/audit-events?feature=package_check&limit=5').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.items.every((item: { type: string }) => item.type === 'PACKAGE_CHECKED')).toBe(true);
    const jobs = await api().get('/api/admin/job-runs?limit=5').set('Authorization', `Bearer ${token}`).expect(200);
    expect(jobs.body.jobs).toContain('event-retention-purge');
  });

  it('summary upserts with a NULL repository or source update one row, never insert a second', async () => {
    const hour = new Date(Date.UTC(2020, 0, 1, Number.parseInt(tag.slice(0, 2), 16) % 24));
    const eco = 'npm';
    const name = `null-${tag}`;
    await upsertCounts(app.db, 'pkgcounts', hour, [{ key: [eco, name, 'ALLOW'], n: 2 }]);
    await upsertCounts(app.db, 'pkgcounts', hour, [{ key: [eco, name, 'ALLOW'], n: 3 }]);
    const repoKey = `null-${tag}`;
    await upsertCounts(app.db, 'counts', hour, [{ key: [repoKey, null, 'ALLOW'], n: 1 }]);
    await upsertCounts(app.db, 'counts', hour, [{ key: [repoKey, null, 'ALLOW'], n: 1 }]);
    const usage = { ecosystem: 'npm', packageName: name, version: '1.0.0', repository: null, sourceRepository: null, sourceType: null, decision: 'ALLOW' as const };
    await upsertUsage(app.db, [usage]);
    await upsertUsage(app.db, [usage]);
    expect(await app.db.query(`SELECT count FROM package_counts_hourly WHERE package_name = $1`, [name])).toEqual([{ count: '5' }]);
    expect(await app.db.query(`SELECT count FROM decision_counts_hourly WHERE ecosystem = $1`, [repoKey])).toEqual([{ count: '2' }]);
    expect(await app.db.query(`SELECT count(*)::int AS n FROM package_usage WHERE package_name = $1`, [name])).toEqual([{ n: 1 }]);
    await app.db.query(`DELETE FROM decision_counts_hourly WHERE ecosystem = $1`, [repoKey]);
  });

  it('a flush key is counted once, even when a worker died after the commit (summary_flushes)', async () => {
    const redis = new Redis(config.redis.url);
    try {
      const eco = `fl${tag}`;
      const flushKey = `${dgKey('counts:flush:')}2020-01-01T00:${randomUUID()}`;
      await redis.hset(flushKey, JSON.stringify([eco, null, 'ALLOW']), '7');
      expect(await flushOne(app.db, redis, 'counts', flushKey)).toBe(1);
      // The same key again, as if the DEL after the commit never happened.
      await redis.hset(flushKey, JSON.stringify([eco, null, 'ALLOW']), '7');
      expect(await flushOne(app.db, redis, 'counts', flushKey)).toBe('skipped');
      expect(await redis.exists(flushKey)).toBe(0);
      expect(await app.db.query(`SELECT count FROM decision_counts_hourly WHERE ecosystem = $1`, [eco])).toEqual([{ count: '7' }]);
      await app.db.query(`DELETE FROM decision_counts_hourly WHERE ecosystem = $1`, [eco]);
    } finally {
      redis.disconnect();
    }
  });

  it('migration: copies blocks and admin rows, counts allows, renames types; a restart resumes without counting twice', async () => {
    // Rows newer than every earlier row, so they are after the cursor.
    const base = Date.now() + 1000;
    const repository = `mig-${tag}`;
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const rows = [
      [ids[0], 'npm', `a-${tag}`, '1.0.0', repository, 'ALLOW', null, null],
      [ids[1], 'npm', `a-${tag}`, '1.0.0', repository, 'ALLOW', null, null],
      [ids[2], 'npm', `b-${tag}`, '2.0.0', repository, 'BLOCK', 'Block GPL', { buildId: '1', sourceRepository: 'npm/acme', sourceType: 'internal' }],
      [ids[3], 'auth', `user-${tag}@acme.test`, null, null, 'LOGIN_FAILED', null, { method: 'password' }],
      [ids[4], 'malicious', 'malicious-feed', null, null, 'MALICIOUS_SYNC', null, null],
    ] as const;
    for (const [i, row] of rows.entries()) {
      await app.db.query(
        `INSERT INTO audit_logs (id, ecosystem, package_name, resolved_version, repository, decision, policy_name, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7] ? JSON.stringify(row[7]) : null, new Date(base + i)]
      );
    }
    // A batch of 2, then the rest: the cursor carries over and nothing is counted twice.
    await runEventMigration(app.db, undefined, { budgetMs: 60_000 });
    await migrateBatch(app.db, new Date(), 2);
    await runEventMigration(app.db, undefined, { budgetMs: 60_000 });
    const ledger = await app.db.query(`SELECT id, decision, auth_method, actor_metadata, details FROM decision_ledger WHERE id = ANY($1::uuid[])`, [ids]);
    expect(ledger).toEqual([{ id: ids[2], decision: 'BLOCK_ENFORCE', auth_method: null, actor_metadata: { buildId: '1' }, details: { source: { repository: 'npm/acme', type: 'internal' } } }]);
    const audit = await app.db.query(`SELECT id, type, target_kind, target_name FROM audit_events WHERE id = ANY($1::uuid[])`, [ids]);
    expect(audit).toEqual([{ id: ids[3], type: 'SIGNIN_FAILED', target_kind: 'user', target_name: `user-${tag}@acme.test` }]);
    const counts = await app.db.query(`SELECT decision, SUM(count)::int AS n FROM decision_counts_hourly WHERE repository = $1 GROUP BY 1 ORDER BY 1`, [repository]);
    expect(counts).toEqual([{ decision: 'ALLOW', n: 2 }, { decision: 'BLOCK_ENFORCE', n: 1 }]);
    const usage = await app.db.query(`SELECT package_name, source_type FROM package_usage WHERE repository = $1 ORDER BY 1`, [repository]);
    expect(usage).toEqual([{ package_name: `a-${tag}`, source_type: null }, { package_name: `b-${tag}`, source_type: 'internal' }]);
    await app.db.query(`DELETE FROM audit_logs WHERE id = ANY($1::uuid[])`, [ids]);
  });

  it('streams to a Splunk destination: test event, then every selected event once, never once per worker replica', async () => {
    received = [];
    const res = await api()
      .post('/api/admin/stream-destinations')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'splunk', name: `Splunk ${tag}`, settings: { url: `http://127.0.0.1:${port}` }, secrets: { token: 'hec-secret' }, selection: { features: [], events: ['POLICY_UPDATED'] } })
      .expect(201);
    expect(JSON.stringify(res.body)).not.toContain('hec-secret');
    const id = res.body.id as string;
    const test = await api().post(`/api/admin/stream-destinations/${id}/test`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(test.body).toMatchObject({ ok: true, status: 200 });
    expect(received[0].auth).toBe('Splunk hec-secret');
    received = [];

    // A second worker replica on the same group: Redis hands each entry to one of them.
    const second = new EventWorker(app.db, app.log, { destinations: true, webhooks: null });
    await second.start();
    try {
      const sent = Array.from({ length: 40 }, (_, i) => recordEvent(app.db, { type: 'POLICY_UPDATED', target: { kind: 'policy', name: `p-${tag}-${i}` } }).id);
      recordEvent(app.db, { type: 'POLICY_CREATED', target: { kind: 'policy', name: `not-selected-${tag}` } });
      const ids = () =>
        received
          .flatMap((request) => request.body.split('\n'))
          .filter(Boolean)
          .map((line) => JSON.parse(line).event)
          .filter((event) => event.target?.name?.includes(tag));
      const got = await until(async () => ids(), (list) => list.length >= 40, 30_000);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(got.map((event) => event.id).sort()).toEqual([...sent].sort());
      expect(ids().filter((event) => event.type !== 'POLICY_UPDATED')).toEqual([]);
      const status = await api().get(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(status.body.health).toMatchObject({ status: 'healthy' });
      expect(status.body.health.sent24h).toBeGreaterThanOrEqual(40);
    } finally {
      await second.stop(2_000);
      await api().delete(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).expect(204);
    }
    const audit = await api().get(`/api/admin/audit-events?feature=settings&target=Splunk ${tag}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(audit.body.items.map((item: { type: string }) => item.type).sort()).toEqual(['STREAM_DESTINATION_CREATED', 'STREAM_DESTINATION_DELETED']);
    expect(JSON.stringify(audit.body)).not.toContain('hec-secret');
  });

  it('counts events the stream trimmed before a slow destination read them, and shows the loss (R-D12)', async () => {
    const res = await api()
      .post('/api/admin/stream-destinations')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'splunk', name: `Slow ${tag}`, enabled: false, settings: { url: 'http://127.0.0.1:9' }, secrets: { token: 't' }, selection: { features: [], events: ['ALLOW'] } })
      .expect(201);
    const id = res.body.id as string;
    const redis = new Redis(config.redis.url);
    // A worker that only checks the streams: the group is never read, as during a long outage.
    const checker = new EventWorker(app.db, app.log, { destinations: false, webhooks: null });
    try {
      await api().put(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).send({ enabled: true }).expect(200);
      // The running app's consumer would read the group; stop it by pausing the destination for the test.
      await redis.hset(`${dgKey(`events:dest:${id}`)}`, 'pausedUntil', new Date(Date.now() + 60_000).toISOString());
      const key = streamKey('bulk');
      const pipeline = redis.pipeline();
      for (let i = 0; i < 3000; i += 1) pipeline.xadd(key, 'MAXLEN', '1000', '*', 't', 'ALLOW', 'f', 'decisions', 'e', '{}');
      await pipeline.exec();
      await checker.checkStreams({ force: true });
      const status = await api().get(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(status.body.health.dropped24h.buffer_full).toBeGreaterThanOrEqual(1900);
      expect(status.body.health.lastLoss.count).toBeGreaterThanOrEqual(1900);
      // The gap is counted once.
      await checker.checkStreams({ force: true });
      const again = await api().get(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(again.body.health.dropped24h.buffer_full).toBe(status.body.health.dropped24h.buffer_full);
    } finally {
      await checker.stop(1_000);
      redis.disconnect();
      await api().delete(`/api/admin/stream-destinations/${id}`).set('Authorization', `Bearer ${token}`).expect(204);
    }
  });

  it('webhooks from the stream: identical blocks are coalesced into one delivery plus one follow-up (W3)', async () => {
    received = [];
    const previous = config.events.webhookCoalesceSeconds;
    (config.events as { webhookCoalesceSeconds: number }).webhookCoalesceSeconds = 2;
    const hook = await api()
      .post('/api/admin/webhooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: `http://127.0.0.1:${port}/hook-${tag}`, events: ['package_blocked'] })
      .expect(201);
    try {
      const payload = { event: 'package_blocked', timestamp: new Date().toISOString(), ecosystem: 'npm', packageName: `burst-${tag}`, version: '1.0.0', decision: 'BLOCK', policyId: 'p', policyName: 'P', reasons: ['r'] };
      for (let i = 0; i < 5; i += 1) await deliverStreamBatch(app.db, [{ eventId: randomUUID(), payload }]);
      const hooks = () => received.filter((request) => request.path === `/hook-${tag}`).map((request) => JSON.parse(request.body));
      expect(hooks()).toHaveLength(1);
      expect(hooks()[0].occurrences).toBeUndefined();
      const after = await until(async () => hooks(), (list) => list.length >= 2, 15_000);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ event: 'package_blocked', packageName: `burst-${tag}`, occurrences: 5 });
      expect(after[1].firstSeen).toBeTruthy();
      expect(after[1].lastSeen).toBeTruthy();
    } finally {
      (config.events as { webhookCoalesceSeconds: number }).webhookCoalesceSeconds = previous;
      await api().delete(`/api/admin/webhooks/${hook.body.id}`).set('Authorization', `Bearer ${token}`);
    }
  });

  it('the events status reports retention and the copy of older entries', async () => {
    const res = await api().get('/api/admin/events/status').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.retention).toEqual({ ledgerDays: config.events.ledgerRetentionDays, auditDays: config.events.auditRetentionDays });
  });
});
