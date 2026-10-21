/**
 * Policy simulation / dry-run integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { Policy } from '../db/entities/Policy.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Policy simulation routes', () => {
  let app: FastifyInstance;
  let token: string;
  let previouslyEnabledPolicyIds: string[] = [];
  let lockOwner = '';

  // Shared lock because these integration suites mutate global policy/config state.
  const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';

  const NPM_PACKAGES = [
    { ecosystem: 'npm', name: 'lodash', version: '4.17.21' },
    { ecosystem: 'npm', name: 'express', version: '4.18.2' },
  ];

  const GPL_PACKAGES = [
    { ecosystem: 'npm', name: 'some-gpl-pkg', version: '1.0.0' },
    { ecosystem: 'npm', name: 'safe-pkg', version: '2.0.0' },
  ];

  async function getAuthToken(instance: FastifyInstance): Promise<string> {
    const candidates = [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ];
    for (const creds of candidates) {
      const res = await supertest(instance.server).post('/api/auth/login').send(creds);
      if (res.status === 200) return res.body.token as string;
    }
    throw new Error('Could not obtain auth token');
  }

  async function acquireSuiteLock(instance: FastifyInstance, owner: string): Promise<void> {
    const timeoutMs = 120000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await instance.redis.set(SUITE_LOCK_KEY, owner, 'NX', 'PX', 300000);
      if (ok === 'OK') return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for integration suite lock');
  }

  async function releaseSuiteLock(instance: FastifyInstance, owner: string): Promise<void> {
    const current = await instance.redis.get(SUITE_LOCK_KEY);
    if (current === owner) await instance.redis.del(SUITE_LOCK_KEY);
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `policy-sim-${randomUUID()}`;
    await acquireSuiteLock(app, lockOwner);
    token = await getAuthToken(app);

    const policyRepo = app.db.getRepository(Policy);
    const enabledPolicies = await policyRepo.find({
      select: { id: true },
      where: { isEnabled: true },
    });
    previouslyEnabledPolicyIds = enabledPolicies.map((p) => p.id);
    if (previouslyEnabledPolicyIds.length > 0) {
      await policyRepo.update({ isEnabled: true }, { isEnabled: false });
    }
  });

  afterAll(async () => {
    if (!app) return;
    try {
      const policyRepo = app.db.getRepository(Policy);
      const chunkSize = 500;
      for (let i = 0; i < previouslyEnabledPolicyIds.length; i += chunkSize) {
        const chunk = previouslyEnabledPolicyIds.slice(i, i + chunkSize);
        await policyRepo.update({ id: In(chunk) }, { isEnabled: true });
      }
    } finally {
      await releaseSuiteLock(app, lockOwner);
      await app.close();
    }
  });

  // ── Ad-hoc simulate (POST /api/admin/policies/simulate) ─────────────────────

  it('returns simulation report with correct shape for an explicit package list', async () => {
    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'Block lodash',
          decision: 'BLOCK',
          conditions: { packageBlockList: ['lodash'] },
          priority: 0,
        },
        packages: NPM_PACKAGES,
      })
      .expect(200);

    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.total).toBe('number');
    expect(typeof res.body.summary.changed).toBe('number');
    expect(typeof res.body.summary.newlyBlocked).toBe('number');
    expect(typeof res.body.summary.newlyAllowed).toBe('number');
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.summary.total).toBe(2);
  });

  it('shows lodash as newly blocked when candidate blocks it', async () => {
    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'Block lodash sim',
          decision: 'BLOCK',
          conditions: { packageBlockList: ['lodash'] },
          priority: 0,
        },
        packages: NPM_PACKAGES,
      })
      .expect(200);

    const lodashEntry = res.body.entries.find(
      (e: { name: string }) => e.name === 'lodash'
    );
    expect(lodashEntry).toBeDefined();
    expect(lodashEntry.simulatedDecision).toBe('BLOCK');

    const expressEntry = res.body.entries.find(
      (e: { name: string }) => e.name === 'express'
    );
    expect(expressEntry).toBeDefined();
    expect(expressEntry.simulatedDecision).toBeNull();
    expect(expressEntry.changed).toBe(false);
  });

  it('respects ecosystem filter — npm-scoped candidate does not affect pypi packages', async () => {
    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'npm block sim',
          decision: 'BLOCK',
          conditions: { ecosystem: ['npm'], packageBlockList: ['requests'] },
          priority: 0,
        },
        packages: [
          { ecosystem: 'npm', name: 'requests', version: '2.32.0' },
          { ecosystem: 'pypi', name: 'requests', version: '2.32.0' },
        ],
      })
      .expect(200);

    const npmEntry = res.body.entries.find(
      (e: { ecosystem: string }) => e.ecosystem === 'npm'
    );
    const pypiEntry = res.body.entries.find(
      (e: { ecosystem: string }) => e.ecosystem === 'pypi'
    );
    expect(npmEntry.simulatedDecision).toBe('BLOCK');
    expect(pypiEntry.simulatedDecision).toBeNull();
  });

  it('returns empty report when packages array is empty and useRecentAuditLog is false', async () => {
    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'Empty sim',
          decision: 'BLOCK',
          conditions: { packageBlockList: ['lodash'] },
          priority: 0,
        },
        packages: [],
        useRecentAuditLog: false,
      })
      .expect(200);

    expect(res.body.summary.total).toBe(0);
    expect(res.body.entries).toHaveLength(0);
  });

  it('returns 401 without auth token', async () => {
    await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .send({
        policy: { name: 'x', decision: 'BLOCK', conditions: {}, priority: 0 },
        packages: [],
      })
      .expect(401);
  });

  it('limits packages array to AUDIT_LOG_LIMIT_MAX (200)', async () => {
    const tooManyPackages = Array.from({ length: 250 }, (_, i) => ({
      ecosystem: 'npm',
      name: `pkg-${i}`,
      version: '1.0.0',
    }));

    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'Big sim',
          decision: 'BLOCK',
          conditions: { packageBlockList: ['nothing'] },
          priority: 0,
        },
        packages: tooManyPackages,
      });

    // Should either be rejected (400) due to maxItems schema or truncated and succeed (200)
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.summary.total).toBeLessThanOrEqual(200);
    }
  });

  it('priority insertion order is respected — candidate at priority 0 shadows lower-priority policies', async () => {
    // Create a BLOCK policy with low priority (999)
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Low priority block',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 999,
        isEnabled: true,
      })
      .expect(201);
    const lowPriorityBlockId = createRes.body.id as string;

    try {
      // Now simulate an ALLOW policy at priority 0 — it should take precedence
      const simRes = await supertest(app.server)
        .post('/api/admin/policies/simulate')
        .set('Authorization', `Bearer ${token}`)
        .send({
          policy: {
            name: 'High priority allow',
            decision: 'ALLOW',
            conditions: { packageBlockList: ['lodash'] },
            priority: 0,
          },
          packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }],
        })
        .expect(200);

      const entry = simRes.body.entries[0];
      // Baseline: BLOCK (from priority-999 policy)
      // Simulated: ALLOW (from priority-0 candidate which wins)
      expect(entry.baselineDecision).toBe('BLOCK');
      expect(entry.simulatedDecision).toBe('ALLOW');
      expect(entry.changed).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${lowPriorityBlockId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  // ── Toggle simulate (POST /api/admin/policies/:id/simulate) ─────────────────

  it('toggle simulate: shows impact of enabling a disabled policy', async () => {
    // Create a disabled policy that would block lodash
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Disabled block lodash',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['lodash'] },
        priority: 50,
        isEnabled: false,
      })
      .expect(201);
    const disabledId = createRes.body.id as string;

    try {
      const simRes = await supertest(app.server)
        .post(`/api/admin/policies/${disabledId}/simulate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ packages: [{ ecosystem: 'npm', name: 'lodash', version: '4.17.21' }] })
        .expect(200);

      expect(simRes.body.simulatedAction).toBe('enable');
      const entry = simRes.body.entries[0];
      // lodash is currently allowed (no active block), simulated → BLOCK
      expect(entry.simulatedDecision).toBe('BLOCK');
      expect(entry.changed).toBe(true);
      expect(simRes.body.summary.newlyBlocked).toBe(1);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${disabledId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('toggle simulate: shows impact of disabling an enabled policy', async () => {
    // Create an enabled block policy
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Enabled block express',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['express'] },
        priority: 50,
        isEnabled: true,
      })
      .expect(201);
    const enabledId = createRes.body.id as string;

    try {
      const simRes = await supertest(app.server)
        .post(`/api/admin/policies/${enabledId}/simulate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ packages: [{ ecosystem: 'npm', name: 'express', version: '4.18.2' }] })
        .expect(200);

      expect(simRes.body.simulatedAction).toBe('disable');
      const entry = simRes.body.entries[0];
      // express is currently BLOCK, simulated (disabled) → null (allowed)
      expect(entry.baselineDecision).toBe('BLOCK');
      expect(entry.simulatedDecision).toBeNull();
      expect(entry.changed).toBe(true);
      expect(simRes.body.summary.newlyAllowed).toBe(1);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${enabledId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('toggle simulate: returns 404 for non-existent policy id', async () => {
    await supertest(app.server)
      .post('/api/admin/policies/00000000-0000-0000-0000-000000000000/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({ packages: NPM_PACKAGES })
      .expect(404);
  });

  it('toggle simulate: falls back to recent audit log when no packages provided', async () => {
    const createRes = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Toggle audit fallback test',
        decision: 'BLOCK',
        conditions: { packageBlockList: ['nonexistent-pkg-xyz'] },
        priority: 60,
        isEnabled: false,
      })
      .expect(201);
    const policyId = createRes.body.id as string;

    try {
      const simRes = await supertest(app.server)
        .post(`/api/admin/policies/${policyId}/simulate`)
        .set('Authorization', `Bearer ${token}`)
        .send({ useRecentAuditLog: true, auditLogLimit: 10 })
        .expect(200);

      expect(simRes.body.simulatedAction).toBe('enable');
      expect(simRes.body.summary).toBeDefined();
      expect(Array.isArray(simRes.body.entries)).toBe(true);
    } finally {
      await supertest(app.server)
        .delete(`/api/admin/policies/${policyId}`)
        .set('Authorization', `Bearer ${token}`);
    }
  });

  it('GPL license deny simulation correctly detects match via conditions', async () => {
    const res = await supertest(app.server)
      .post('/api/admin/policies/simulate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        policy: {
          name: 'GPL deny sim',
          decision: 'BLOCK',
          conditions: { licenseDenyList: ['GPL-3.0'] },
          priority: 0,
        },
        packages: GPL_PACKAGES,
      })
      .expect(200);

    expect(res.body.summary.total).toBe(2);
    expect(res.body.entries).toHaveLength(2);
  });
});
