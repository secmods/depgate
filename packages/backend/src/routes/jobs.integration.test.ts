/**
 * Background job queue (requirements_job_queue.md), against real Redis and PostgreSQL (RUN_INTEGRATION=1).
 * A local HTTP server plays the webhook receivers. A second BullMQ worker stands in for another replica.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEBHOOK_BACKOFF_MS = '50';
  process.env.WEBHOOK_MAX_ATTEMPTS = '3';
  process.env.WEBHOOK_DISABLE_AFTER_FAILURES = '3';
  process.env.EMAIL_BACKOFF_MS = '50';
  process.env.JOBS_LOCK_DURATION_MS = '1000';
  // This replica does not work on the monitor queue: the test's own workers do (replica stand-ins).
  process.env.WORKERS = 'webhooks,scheduled,email';
  process.env.QUEUE_PREFIX = `depgate-test-jobs-${Math.random().toString(36).slice(2, 8)}`;
});

import supertest from 'supertest';
import crypto from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import type { Worker } from 'bullmq';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { WebhookTarget } from '../db/entities/WebhookTarget.js';
import { WebhookDelivery } from '../db/entities/WebhookDelivery.js';
import { JobRun } from '../db/entities/JobRun.js';
import { auditRows } from '../test-support/event-rows.js';
import { User } from '../db/entities/User.js';
import { hashPassword } from '../services/auth.js';
import { setMailSender, type OutgoingMail } from '../services/mailer.js';
import { createWorker, enqueue, getQueue, jobsRedis, registerHandler, stopJobs } from '../services/jobs/queue.js';
import { acquireRunMutex } from '../services/jobs/mutex.js';
import { schedulerId } from '../services/jobs/scheduled.js';
import type * as WebhookService from '../services/webhook-service.js';

type Received = { path: string; headers: IncomingMessage['headers']; body: string };

async function poll<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 8000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!process.env.RUN_INTEGRATION)('Background job queue', () => {
  let app: FastifyInstance;
  let token = '';
  let userToken = '';
  let receiver: Server;
  let base = '';
  const received: Received[] = [];
  /** Per path: the statuses to answer, in order; the last one repeats. */
  const plan = new Map<string, number[]>();
  const created: string[] = [];
  const replicas: Worker[] = [];
  const replicaConnections: Redis[] = [];
  let actual: typeof WebhookService;
  const run = `qa-jobs-${Date.now()}`;

  const admin = (req: supertest.Test) => req.set('Authorization', `Bearer ${token}`);
  const replicaLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

  function replica(queue: 'monitor' | 'scheduled'): Worker {
    const connection = new Redis(config.jobs.redisUrl, { maxRetriesPerRequest: null });
    replicaConnections.push(connection);
    const worker = createWorker(queue, connection, config.jobs.prefix, replicaLog);
    replicas.push(worker);
    return worker;
  }

  async function webhook(path: string, statuses: number[], extra: Record<string, unknown> = {}): Promise<string> {
    plan.set(path, statuses);
    const res = await admin(supertest(app.server).post('/api/admin/webhooks')).send({
      url: `${base}${path}`,
      secret: 'qa-secret',
      events: ['package_blocked'],
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    created.push(res.body.id);
    return res.body.id;
  }

  async function event(packageName: string): Promise<void> {
    await actual.deliverWebhooks(app.db, {
      event: 'package_blocked',
      timestamp: new Date().toISOString(),
      ecosystem: 'npm',
      packageName,
      version: '1.0.0',
    });
  }

  const deliveries = (targetId: string) =>
    app.db.getRepository(WebhookDelivery).find({ where: { targetId }, order: { createdAt: 'ASC' } });
  const hits = (path: string) => received.filter((r) => r.path === path);

  beforeAll(async () => {
    actual = await vi.importActual<typeof WebhookService>('../services/webhook-service.js');
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const path = req.url ?? '/';
        received.push({ path, headers: req.headers, body });
        const statuses = plan.get(path) ?? [200];
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"secret":"receiver-body-is-never-stored"}');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    app = await buildApp();
    await app.ready();
    token = (await supertest(app.server).post('/api/auth/login').send({ email: 'admin@depgate.local', password: 'admin' })).body.token;
    expect(token).toBeTruthy();
    const email = `${run}-user@example.com`;
    const user = await app.db.getRepository(User).save(
      app.db.getRepository(User).create({ email, passwordHash: await hashPassword('qa-user-pass-1'), role: 'User' } as Partial<User>)
    );
    created.push(`user:${user.id}`);
    userToken = (await supertest(app.server).post('/api/auth/login').send({ email, password: 'qa-user-pass-1' })).body.token;
  }, 60000);

  afterAll(async () => {
    setMailSender(null);
    for (const worker of replicas) await worker.close(true).catch(() => undefined);
    for (const connection of replicaConnections) connection.disconnect();
    if (app) {
      for (const id of created) {
        if (id.startsWith('user:')) await app.db.getRepository(User).delete({ id: id.slice(5) });
        else await app.db.getRepository(WebhookTarget).delete({ id });
      }
      await app.close();
    }
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }, 60000);

  describe('webhooks', () => {
    it('retries a failing receiver and delivers on the third attempt, with one event ID and a valid signature', async () => {
      const id = await webhook('/flaky', [503, 503, 200]);
      await event(`${run}-flaky`);
      const row = await poll(async () => (await deliveries(id)).find((d) => d.status === 'delivered'), 'delivered row');
      expect(row.attempts).toBe(3);
      expect((await deliveries(id))).toHaveLength(1);
      const calls = hits('/flaky');
      expect(calls).toHaveLength(3);
      expect(new Set(calls.map((c) => c.headers['x-depgate-event-id']))).toEqual(new Set([row.eventId]));
      expect(calls.map((c) => c.headers['x-depgate-delivery-attempt'])).toEqual(['1', '2', '3']);
      for (const call of calls) {
        const expected = crypto.createHmac('sha256', 'qa-secret').update(call.body).digest('hex');
        expect(call.headers['x-depgate-signature']).toBe(`sha256=${expected}`);
        expect(JSON.parse(call.body)).toMatchObject({ id: row.eventId, event: 'package_blocked', packageName: `${run}-flaky` });
      }
      // Completed jobs leave nothing in Redis.
      expect(await getQueue('webhooks')!.getJob(`wh-${row.id}`)).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('receiver-body-is-never-stored');
    });

    it('a 4xx is final after one attempt, and the failed job is listed on the Jobs page', async () => {
      const id = await webhook('/reject-once', [400]);
      await event(`${run}-reject`);
      const row = await poll(async () => (await deliveries(id)).find((d) => d.status === 'failed'), 'failed row');
      expect(row).toMatchObject({ attempts: 1, lastStatusCode: 400, lastError: 'HTTP 400' });
      await sleep(300);
      expect(hits('/reject-once')).toHaveLength(1);
      const failed = await admin(supertest(app.server).get('/api/admin/jobs/failed?queue=webhooks')).expect(200);
      expect(failed.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: `wh-${row.id}`, job: 'deliver', error: 'HTTP 400', ids: expect.objectContaining({ deliveryId: row.id }) })]));
    });

    it('stops retrying once the webhook is deleted', async () => {
      const id = await webhook('/down', [503]);
      await event(`${run}-down`);
      await poll(async () => hits('/down').length >= 1, 'first attempt');
      await app.db.getRepository(WebhookTarget).delete({ id });
      await sleep(600);
      expect(hits('/down')).toHaveLength(1);
    });

    it('is disabled after 3 failed deliveries in a row, audited; later events are skipped and can be redelivered', async () => {
      const id = await webhook('/broken', [400]);
      for (let i = 1; i <= 3; i += 1) {
        await event(`${run}-broken-${i}`);
        await poll(async () => (await deliveries(id)).filter((d) => d.status === 'failed').length >= i, `failure ${i}`);
      }
      const target = await poll(async () => {
        const row = await app.db.getRepository(WebhookTarget).findOneBy({ id });
        return row && !row.isEnabled ? row : null;
      }, 'auto-disable');
      expect(target.disabledReason).toBe('Disabled after 3 consecutive failed deliveries; last error: HTTP 400');
      const audit = await poll(
        () => auditRows(app.db, { type: 'WEBHOOK_UPDATED', targetName: `${base}/broken` }, 1).then((rows) => rows[0]),
        'audit row'
      );
      expect(audit.reasons?.[0]).toContain('Disabled after 3 consecutive failed deliveries');
      expect(audit.actorKind).toBe('system');
      const list = await admin(supertest(app.server).get('/api/admin/webhooks')).expect(200);
      expect(list.body.find((w: { id: string }) => w.id === id)).toMatchObject({ disabledAutomatically: true, consecutiveFailures: 3 });

      await event(`${run}-while-disabled`);
      const skipped = await poll(async () => (await deliveries(id)).find((d) => d.status === 'skipped'), 'skipped row');
      expect(skipped.lastError).toBe('Webhook disabled');
      expect(hits('/broken')).toHaveLength(3);

      plan.set('/broken', [200]);
      await admin(supertest(app.server).post(`/api/admin/webhooks/${id}/redeliver-skipped`)).expect(409);
      const on = await admin(supertest(app.server).put(`/api/admin/webhooks/${id}`)).send({ isEnabled: true }).expect(200);
      expect(on.body).toMatchObject({ isEnabled: true, consecutiveFailures: 0, disabledAutomatically: false });
      const again = await admin(supertest(app.server).post(`/api/admin/webhooks/${id}/redeliver-skipped`)).expect(202);
      expect(again.body.queued).toBe(1);
      const redelivered = await poll(
        async () => (await deliveries(id)).find((d) => d.status === 'delivered' && d.eventId === skipped.eventId),
        'redelivered skipped event'
      );
      expect(hits('/broken').at(-1)?.headers['x-depgate-event-id']).toBe(redelivered.eventId);
      // A second click does not send it again.
      expect((await admin(supertest(app.server).post(`/api/admin/webhooks/${id}/redeliver-skipped`)).expect(202)).body.queued).toBe(0);
    });

    it('a delivered event resets the failure count', async () => {
      const id = await webhook('/sometimes', [400, 400, 200, 400, 400]);
      for (let i = 1; i <= 5; i += 1) {
        await event(`${run}-sometimes-${i}`);
        await poll(async () => (await deliveries(id)).filter((d) => d.status !== 'pending').length >= i, `delivery ${i}`);
      }
      const target = await app.db.getRepository(WebhookTarget).findOneByOrFail({ id });
      expect(target.isEnabled).toBe(true);
      expect(target.consecutiveFailures).toBe(2);
    });

    it.each(['policy_violation', 'integrity_violation'])('%s is not stored, not offered, and never sent', async (removed) => {
      const res = await admin(supertest(app.server).post('/api/admin/webhooks')).send({
        url: `${base}/legacy-${removed}`,
        events: ['package_blocked', removed],
      });
      expect(res.status).toBe(201);
      created.push(res.body.id);
      expect(res.body.events).toEqual(['package_blocked']);
      expect(res.body.deprecations[0]).toContain(`${removed} is no longer sent`);
      // A webhook saved before the removal still stores it: it is shown as deprecated and never receives it.
      await app.db.getRepository(WebhookTarget).update({ id: res.body.id }, { events: [removed] });
      const list = await admin(supertest(app.server).get('/api/admin/webhooks')).expect(200);
      expect(list.body.find((w: { id: string }) => w.id === res.body.id)).toMatchObject({ events: [], deprecatedEvents: [removed] });
      await actual.deliverWebhooks(app.db, { event: removed as never, timestamp: new Date().toISOString() });
      await sleep(200);
      expect(await deliveries(res.body.id)).toHaveLength(0);
      expect(hits(`/legacy-${removed}`)).toHaveLength(0);
    });

    it('lists deliveries, redelivers with the same event ID, and sends an uncounted test event', async () => {
      const id = await webhook('/history', [200]);
      await event(`${run}-history`);
      const first = await poll(async () => (await deliveries(id)).find((d) => d.status === 'delivered'), 'delivery');
      const list = await admin(supertest(app.server).get(`/api/admin/webhooks/${id}/deliveries?status=delivered`)).expect(200);
      expect(list.body.items[0]).toMatchObject({ id: first.id, eventId: first.eventId, status: 'delivered', attempts: 1 });
      expect(list.body.items[0].payload).toMatchObject({ packageName: `${run}-history` });
      const again = await admin(supertest(app.server).post(`/api/admin/webhooks/${id}/deliveries/${first.id}/redeliver`)).expect(202);
      expect(again.body.eventId).toBe(first.eventId);
      await poll(async () => (await deliveries(id)).filter((d) => d.status === 'delivered').length === 2, 'redelivery');
      expect(hits('/history').map((h) => h.headers['x-depgate-event-id'])).toEqual([first.eventId, first.eventId]);

      plan.set('/history', [503]);
      const test = await admin(supertest(app.server).post(`/api/admin/webhooks/${id}/test`)).expect(200);
      expect(test.body).toMatchObject({ ok: false, statusCode: 503 });
      expect((await app.db.getRepository(WebhookTarget).findOneByOrFail({ id })).consecutiveFailures).toBe(0);
      expect(await deliveries(id)).toHaveLength(2);
    });
  });

  describe('scheduled jobs', () => {
    it('a schedule runs once per tick across two replicas', async () => {
      replica('scheduled');
      const queue = getQueue('scheduled')!;
      const started = new Date();
      const every = 300;
      await queue.upsertJobScheduler(schedulerId('monitor-retention-purge'), { every, startDate: Date.now() + every }, {
        name: 'monitor-retention-purge',
        data: { trigger: 'scheduled' },
      });
      await sleep(1700);
      await queue.removeJobScheduler(schedulerId('monitor-retention-purge'));
      await sleep(300);
      const runs = await app.db
        .getRepository(JobRun)
        .createQueryBuilder('r')
        .where('r.job = :job AND r.started_at >= :started', { job: 'monitor-retention-purge', started })
        .getMany();
      const succeeded = runs.filter((r) => r.status === 'succeeded');
      expect(succeeded.length).toBeGreaterThanOrEqual(3);
      expect(succeeded.length).toBeLessThanOrEqual(6);
      expect(runs.filter((r) => r.status === 'skipped')).toHaveLength(0);
      expect(succeeded[0].result).toMatchObject({ webhookDeliveries: expect.any(Number), jobRuns: expect.any(Number) });
    });

    it('"run now" answers 409 while a run is active, and a scheduled run during it is recorded as skipped', async () => {
      const mutex = await acquireRunMutex(jobsRedis()!, `${config.jobs.prefix}:mutex:namespace-collision-check`);
      expect(mutex).not.toBeNull();
      try {
        await admin(supertest(app.server).post('/api/admin/namespaces/collisions/run')).expect(409);
        await admin(supertest(app.server).post('/api/admin/jobs/scheduled/namespace-collision-check/run')).expect(409);
        const started = new Date();
        await enqueue('scheduled', 'namespace-collision-check', { trigger: 'scheduled' });
        const skipped = await poll(
          () =>
            app.db
              .getRepository(JobRun)
              .createQueryBuilder('r')
              .where('r.job = :job AND r.started_at >= :started AND r.status = :status', { job: 'namespace-collision-check', started, status: 'skipped' })
              .getOne(),
          'skipped run'
        );
        expect(skipped.result).toEqual({ skipped: 'Another run is in progress' });
      } finally {
        await mutex!.release();
      }
      const queued = await admin(supertest(app.server).post('/api/admin/namespaces/collisions/run')).expect(202);
      const outcome = await poll(async () => {
        const res = await admin(supertest(app.server).get(`/api/admin/namespaces/collisions/run/${queued.body.jobId}`)).expect(200);
        return res.body.status === 'succeeded' ? res.body : null;
      }, 'run result');
      expect(outcome).toHaveProperty('checked');
    });

    it('Settings → Jobs lists the queues and the five schedules; a User gets 403', async () => {
      const res = await admin(supertest(app.server).get('/api/admin/jobs')).expect(200);
      expect(res.body.available).toBe(true);
      expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(['webhooks', 'scheduled', 'email', 'monitor']);
      expect(res.body.schedules.map((s: { job: string }) => s.job)).toEqual([
        'namespace-collision-check',
        'malicious-feed-sync',
        'monitor-retention-purge',
        'epss-sync',
        'event-retention-purge',
      ]);
      expect(res.body.schedules[2].runs.length).toBeGreaterThan(0);
      await supertest(app.server).get('/api/admin/jobs').set('Authorization', `Bearer ${userToken}`).expect(403);
      await supertest(app.server).get('/api/admin/jobs/failed').set('Authorization', `Bearer ${userToken}`).expect(403);
      await supertest(app.server).get('/api/admin/jobs').expect(401);
    });

    it('retries and discards a failed job from the Jobs page', async () => {
      const failed = (await admin(supertest(app.server).get('/api/admin/jobs/failed?queue=webhooks')).expect(200)).body.items;
      expect(failed.length).toBeGreaterThan(0);
      const [first] = failed;
      await admin(supertest(app.server).post(`/api/admin/jobs/webhooks/${first.id}/retry`)).expect(202);
      // It runs again: it fails again (receiver still refuses) or completes and is removed (its webhook is gone).
      await poll(async () => {
        const job = await getQueue('webhooks')!.getJob(first.id);
        return !job || (await job.getState()) === 'failed';
      }, 'retried job to finish');
      const still = (await admin(supertest(app.server).get('/api/admin/jobs/failed?queue=webhooks')).expect(200)).body.items;
      expect(still.length).toBeGreaterThan(0);
      await admin(supertest(app.server).delete(`/api/admin/jobs/webhooks/${still[0].id}`)).expect(204);
      expect(await getQueue('webhooks')!.getJob(still[0].id)).toBeUndefined();
      await admin(supertest(app.server).post(`/api/admin/jobs/webhooks/${still[0].id}/retry`)).expect(404);
    });
  });

  describe('replicas and restarts', () => {
    it('a job whose replica dies mid-run is finished by another replica', async () => {
      let started = 0;
      let finished = 0;
      registerHandler('monitor', 'qa-slow', async () => {
        started += 1;
        if (started === 1) {
          await sleep(10_000);
          return 'too late';
        }
        finished += 1;
        return 'done';
      });
      const doomed = replica('monitor');
      const id = await enqueue('monitor', 'qa-slow', { qaId: run }, { jobId: `qa-slow-${run}` });
      expect(id).toBeTruthy();
      await poll(async () => started === 1, 'first replica to start the job');
      await doomed.close(true);
      replica('monitor');
      await poll(async () => finished === 1, 'second replica to finish the stalled job', 15000);
      expect(started).toBe(2);
    }, 30000);

    it('a Monitoring recheck runs on the queue and clears its flag when done', async () => {
      const { startRecheck, listMonitorPolicies } = await import('../services/monitor-service.js');
      const { Policy } = await import('../db/entities/Policy.js');
      const policy = await app.db.getRepository(Policy).save(
        app.db.getRepository(Policy).create({
          name: `${run}-recheck`,
          decision: 'BLOCK',
          mode: 'monitor',
          modeChangedAt: new Date(),
          isEnabled: false,
          priority: 9999,
          conditions: { ecosystem: ['npm'], packageBlockList: [`${run}-nothing`] },
        })
      );
      try {
        await startRecheck({ db: app.db, redis: app.redis, log: app.log }, policy);
        await poll(async () => (await app.redis.get(`monitor:recheck:${policy.id}`)) === null, 'recheck to finish');
        const [summary] = (await listMonitorPolicies(app.db, app.redis, 'monitoring')).filter((p) => p.id === policy.id);
        expect(summary).toMatchObject({ rechecking: false, recheckFailed: false });
      } finally {
        await app.db.getRepository(Policy).delete({ id: policy.id });
      }
    });
  });

  describe('email', () => {
    it('a reset email is retried after a transient SMTP failure; an invitation failure is never retried', async () => {
      const sent: OutgoingMail[] = [];
      let failures = 1;
      setMailSender(async (mail) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('421 try again later');
        }
        sent.push(mail);
      });
      const user = await app.db.getRepository(User).findOneByOrFail({ email: `${run}-user@example.com` });
      await supertest(app.server).post('/api/auth/forgot-password').send({ email: user.email }).expect(200);
      const mail = await poll(async () => sent.find((m) => m.to === user.email), 'retried reset email');
      expect(mail.subject).toContain('Reset');

      setMailSender(async () => {
        throw new Error('smtp down');
      });
      const invite = await admin(supertest(app.server).post('/api/admin/users')).send({ email: `${run}-invitee@example.com`, role: 'User' });
      expect(invite.status).toBe(201);
      created.push(`user:${invite.body.id}`);
      expect(invite.body.emailSent).toBe(false);
      expect(invite.body.inviteUrl).toContain('/set-password?token=');
      setMailSender(async (m) => void sent.push(m));
      await sleep(500);
      expect(sent.find((m) => m.to === `${run}-invitee@example.com`)).toBeUndefined();
    });
  });

  describe('queue unavailable', () => {
    it('webhooks fall back to one in-process attempt, and downloads are unaffected', async () => {
      const id = await webhook('/fallback', [200]);
      await stopJobs(1000);
      await event(`${run}-fallback`);
      const row = (await deliveries(id))[0];
      expect(row).toMatchObject({ status: 'delivered', attempts: 1 });
      expect(hits('/fallback')).toHaveLength(1);
      const ready = await supertest(app.server).get('/readyz').expect(200);
      expect(ready.body).toMatchObject({ status: 'degraded', queues: 'unavailable' });
    });
  });
});
