/**
 * Cross-ecosystem policy simulation regression tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { randomUUID } from 'crypto';
import { buildApp } from '../app.js';
import { Policy } from '../db/entities/Policy.js';

const SUPPORTED_ECOSYSTEMS = [
  'npm',
  'pypi',
  'go',
  'maven',
  'nuget',
  'cargo',
  'composer',
  'rubygems',
] as const;

const SUITE_LOCK_KEY = 'integration:suite-lock:global-policy-config';

async function getAuthToken(app: FastifyInstance): Promise<string> {
  const candidates = [
    { email: 'admin@depgate.local', password: 'admin' },
    { email: 'testadmin@depgate.local', password: 'testpass123' },
    { email: 'v1gaadmin@depgate.local', password: 'v1gaadmin123' },
  ];

  for (const creds of candidates) {
    const res = await supertest(app.server).post('/api/auth/login').send(creds);
    if (res.status === 200 && res.body.token) return res.body.token;
  }
  throw new Error('Could not obtain auth token');
}

async function acquireSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const timeoutMs = 120000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await app.redis.set(SUITE_LOCK_KEY, owner, 'NX', 'PX', 300000);
    if (ok === 'OK') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for integration suite lock');
}

async function releaseSuiteLock(app: FastifyInstance, owner: string): Promise<void> {
  const current = await app.redis.get(SUITE_LOCK_KEY);
  if (current === owner) await app.redis.del(SUITE_LOCK_KEY);
}

describe.skipIf(!process.env.RUN_INTEGRATION)('Cross-ecosystem policy simulation GA regression', () => {
  let app: FastifyInstance;
  let token: string;
  let lockOwner = '';
  let previouslyEnabledPolicyIds: string[] = [];

  const auth = (req: supertest.Test): supertest.Test =>
    req.set('Authorization', `Bearer ${token}`);

  const packages = SUPPORTED_ECOSYSTEMS.map((ecosystem) => ({
    ecosystem,
    name: 'shared-ga-regression-package',
    version: '1.0.0',
  }));

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    lockOwner = `policy-sim-cross-ecosystem-${randomUUID()}`;
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
  }, 30000);

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
  }, 30000);

  it('simulates BLOCK consistently for every supported ecosystem', async () => {
    const res = await auth(supertest(app.server).post('/api/admin/policies/simulate'))
      .send({
        policy: {
          name: 'GA block all ecosystems',
          decision: 'BLOCK',
          conditions: {
            ecosystem: [...SUPPORTED_ECOSYSTEMS],
            packageBlockList: ['shared-ga-regression-package'],
          },
          priority: 0,
        },
        packages,
        useRecentAuditLog: false,
      })
      .expect(200);

    expect(res.body.summary).toMatchObject({
      total: SUPPORTED_ECOSYSTEMS.length,
      changed: SUPPORTED_ECOSYSTEMS.length,
      newlyBlocked: SUPPORTED_ECOSYSTEMS.length,
      newlyAllowed: 0,
    });

    for (const ecosystem of SUPPORTED_ECOSYSTEMS) {
      const entry = res.body.entries.find((e: { ecosystem: string }) => e.ecosystem === ecosystem);
      expect(entry, ecosystem).toBeDefined();
      expect(entry.baselineDecision, ecosystem).toBeNull();
      expect(entry.simulatedDecision, ecosystem).toBe('BLOCK');
      expect(entry.changed, ecosystem).toBe(true);
    }
  });

  it('keeps ecosystem-scoped simulation isolated across similarly named packages', async () => {
    const res = await auth(supertest(app.server).post('/api/admin/policies/simulate'))
      .send({
        policy: {
          name: 'GA npm-only block',
          decision: 'BLOCK',
          conditions: {
            ecosystem: ['npm'],
            packageBlockList: ['shared-ga-regression-package'],
          },
          priority: 0,
        },
        packages,
        useRecentAuditLog: false,
      })
      .expect(200);

    expect(res.body.summary).toMatchObject({
      total: SUPPORTED_ECOSYSTEMS.length,
      changed: 1,
      newlyBlocked: 1,
    });

    for (const entry of res.body.entries as Array<{ ecosystem: string; simulatedDecision: string | null }>) {
      expect(entry.simulatedDecision, entry.ecosystem).toBe(entry.ecosystem === 'npm' ? 'BLOCK' : null);
    }
  });

  it('toggle simulation reports impact across all supported ecosystems', async () => {
    const createRes = await auth(supertest(app.server).post('/api/admin/policies'))
      .send({
        name: 'GA toggle block all ecosystems',
        decision: 'BLOCK',
        conditions: {
          ecosystem: [...SUPPORTED_ECOSYSTEMS],
          packageBlockList: ['shared-ga-regression-package'],
        },
        priority: 0,
        isEnabled: false,
      })
      .expect(201);
    const policyId = createRes.body.id as string;

    try {
      const res = await auth(supertest(app.server).post(`/api/admin/policies/${policyId}/simulate`))
        .send({ packages, useRecentAuditLog: false })
        .expect(200);

      expect(res.body.simulatedAction).toBe('enable');
      expect(res.body.summary).toMatchObject({
        total: SUPPORTED_ECOSYSTEMS.length,
        changed: SUPPORTED_ECOSYSTEMS.length,
        newlyBlocked: SUPPORTED_ECOSYSTEMS.length,
        newlyAllowed: 0,
      });
      expect(
        (res.body.entries as Array<{ simulatedDecision: string }>).every(
          (entry) => entry.simulatedDecision === 'BLOCK'
        )
      ).toBe(true);
    } finally {
      await auth(supertest(app.server).delete(`/api/admin/policies/${policyId}`));
    }
  });
});
