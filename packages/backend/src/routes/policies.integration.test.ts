/**
 * Policy CRUD integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe.skipIf(!process.env.RUN_INTEGRATION)('Policy routes', () => {
  let app: FastifyInstance;
  let token: string;
  let policyId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const candidates = [
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ];
    for (const creds of candidates) {
      const res = await supertest(app.server).post('/api/auth/login').send(creds);
      if (res.status === 200) {
        token = res.body.token;
        break;
      }
    }
    if (!token) throw new Error('Could not obtain auth token');
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('POST /api/admin/policies rejects an unauthenticated invalid body before validation', async () => {
    const response = await supertest(app.server).post('/api/admin/policies').send({}).expect(401);
    expect(response.body.error).toBeTruthy();
    expect(response.body.code).not.toBe('FST_ERR_VALIDATION');
  });

  it('GET /api/admin/policies returns list', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/policies?limit=50')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.total).toBeGreaterThanOrEqual(response.body.items.length);
    expect(response.body.enabled + response.body.disabled).toBe(response.body.total);
  });

  it('GET /api/admin/policies pages with limit and offset', async () => {
    const response = await supertest(app.server)
      .get('/api/admin/policies?limit=1&offset=0')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.items.length).toBeLessThanOrEqual(1);
    expect(response.body.total).toBeGreaterThanOrEqual(response.body.items.length);
  });

  it('POST /api/admin/policies validates the version condition for its ecosystems', async () => {
    const bad = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Ruby range syntax',
        decision: 'BLOCK',
        conditions: { ecosystem: ['rubygems'], packageBlockList: ['rails'], versionRange: '~> 1.2' },
      })
      .expect(400);
    expect(bad.body.error).toMatch(/is not a version/);

    await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Reversed range',
        decision: 'BLOCK',
        conditions: { ecosystem: ['maven'], packageBlockList: ['x'], versionRange: '2.0 - 1.0-SNAPSHOT' },
      })
      .expect(400);

    const created = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block snapshots and release candidates',
        decision: 'BLOCK',
        isEnabled: false,
        conditions: {
          ecosystem: ['maven'],
          packageBlockList: ['com.example:*'],
          versionRange: '=1.0-SNAPSHOT || 2.0.0-RC1 - 2.0.0.Final',
        },
      })
      .expect(201);

    await supertest(app.server)
      .put(`/api/admin/policies/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ conditions: { ecosystem: ['maven'], packageBlockList: ['com.example:*'], versionRange: '[1.0,2.0)' } })
      .expect(400);

    await supertest(app.server)
      .delete(`/api/admin/policies/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect((res) => expect([200, 204]).toContain(res.status));
  });

  it('POST /api/admin/policies creates policy', async () => {
    const response = await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Block GPL packages',
        description: 'Block packages with GPL license',
        decision: 'BLOCK',
        conditions: { licenseDenyList: ['GPL-3.0', 'AGPL-*'] },
        priority: 10,
      })
      .expect(201);

    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe('Block GPL packages');
    expect(response.body.decision).toBe('BLOCK');
    policyId = response.body.id;
  });

  function createDisabled(name: string, conditions: Record<string, unknown>) {
    return supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, decision: 'BLOCK', isEnabled: false, priority: 50, conditions });
  }

  async function remove(id: string) {
    await supertest(app.server)
      .delete(`/api/admin/policies/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  }

  it('POST /api/admin/policies creates a Packages policy with names and versions', async () => {
    const response = await createDisabled('Packages rule', {
      packageBlockList: ['bad-pkg', '*-malware'],
      versionRange: '1.0.0 - 2.1.0 || 3.1.0 - 4.0.0',
    }).expect(201);

    const getRes = await supertest(app.server)
      .get(`/api/admin/policies/${response.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(getRes.body.conditions.packageBlockList).toEqual(['bad-pkg', '*-malware']);
    expect(getRes.body.conditions.versionRange).toBe('1.0.0 - 2.1.0 || 3.1.0 - 4.0.0');
    await remove(response.body.id);
  });

  it('POST /api/admin/policies keeps one rule per policy', async () => {
    const mixed = await createDisabled('Two rules', {
      packageBlockList: ['bad-pkg'],
      cveBlockList: ['CVE-2024-1234'],
      licenseDenyList: ['GPL'],
    }).expect(400);
    expect(mixed.body.error).toBe(
      'A policy has one rule, but this one has packages, vulnerability and license. Create a policy for each rule'
    );

    await createDisabled('No rule', { ecosystem: ['npm'] }).expect(400);
  });

  it('offers Allow only for the Packages rule', async () => {
    const send = (body: Record<string, unknown>) =>
      supertest(app.server).post('/api/admin/policies').set('Authorization', `Bearer ${token}`).send(body);

    const allowRelease = await send({
      name: 'Allow pre-releases',
      decision: 'ALLOW',
      isEnabled: false,
      conditions: { releaseTypes: ['prerelease'] },
    }).expect(400);
    expect(allowRelease.body.error).toMatch(/^Release type policies can block, not allow/);

    const allowPackages = await send({
      name: 'Allow acme',
      decision: 'ALLOW',
      isEnabled: false,
      conditions: { packageBlockList: ['@acme/*'] },
    }).expect(201);

    const blockAge = await send({
      name: 'Hold new versions',
      decision: 'BLOCK',
      isEnabled: false,
      conditions: { releaseAgeMaxHours: 24 },
    }).expect(201);

    // Switching an existing release age policy to Allow is refused too.
    await supertest(app.server)
      .put(`/api/admin/policies/${blockAge.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'ALLOW' })
      .expect(400);

    await remove(allowPackages.body.id);
    await remove(blockAge.body.id);
  });

  it('refuses a decision other than ALLOW or BLOCK', async () => {
    await supertest(app.server)
      .post('/api/admin/policies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hold new versions', decision: 'HOLD', isEnabled: false, conditions: { releaseAgeMaxHours: 24 } })
      .expect(400);
  });

  it('POST /api/admin/policies creates vulnerability, release age, license and release type policies', async () => {
    const created: string[] = [];
    for (const conditions of [
      { cveBlockList: ['CVE-2024-1234', 'CVE-2023-4567'], cvssMin: 7 },
      { releaseAgeMaxHours: 72 },
      { releaseAgeMinDays: 365 },
      { releaseAgeMaxHours: 72, releaseAgeMinDays: 365 },
      { licenseDenyList: ['GPL-3.0'] },
      { ecosystem: ['maven'], releaseTypes: ['prerelease', 'snapshot'] },
    ]) {
      const response = await createDisabled(`Rule ${Object.keys(conditions).join('+')}`, conditions).expect(201);
      expect(response.body.conditions).toEqual(conditions);
      created.push(response.body.id);
    }

    const wrongEcosystem = await createDisabled('Snapshots on npm', {
      ecosystem: ['npm'],
      releaseTypes: ['snapshot'],
    }).expect(400);
    expect(wrongEcosystem.body.error).toBe('snapshot applies only to Maven');

    for (const id of created) await remove(id);
  });

  it('POST /api/admin/policies saves a severity threshold as its CVSS minimum, and rejects a bad CVSS score', async () => {
    const legacy = await createDisabled('Legacy severity', { cveSeverityThreshold: 'HIGH', epssMin: 0.1 }).expect(201);
    expect(legacy.body.conditions).toEqual({ cvssMin: 7, epssMin: 0.1 });
    await remove(legacy.body.id);

    const tooPrecise = await createDisabled('CVSS 7.25', { cvssMin: 7.25 }).expect(400);
    expect(tooPrecise.body.error).toMatch(/one decimal/);
  });

  it('GET /api/admin/policies/:id returns policy', async () => {
    const response = await supertest(app.server)
      .get(`/api/admin/policies/${policyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.name).toBe('Block GPL packages');
  });

  it('PUT /api/admin/policies/:id updates policy', async () => {
    const response = await supertest(app.server)
      .put(`/api/admin/policies/${policyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: false })
      .expect(200);

    expect(response.body.isEnabled).toBe(false);
  });

  it('DELETE /api/admin/policies/:id removes policy', async () => {
    await supertest(app.server)
      .delete(`/api/admin/policies/${policyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await supertest(app.server)
      .get(`/api/admin/policies/${policyId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('GET /api/admin/policies returns 401 without auth', async () => {
    await supertest(app.server).get('/api/admin/policies').expect(401);
  });
});
