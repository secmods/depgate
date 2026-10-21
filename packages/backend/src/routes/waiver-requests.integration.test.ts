/**
 * Waiver request API integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { User } from '../db/entities/User.js';
import { WaiverRequest } from '../db/entities/WaiverRequest.js';
import { Exception } from '../db/entities/Exception.js';
import { hashPassword } from '../services/auth.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Waiver request routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let viewerToken: string;
  let viewerId: string;
  const viewerName = `waiver-viewer-${Date.now()}@depgate.local`;
  const packageName = `waiver-pkg-${Date.now()}`;

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
        adminToken = res.body.token;
        break;
      }
    }
    if (!adminToken) throw new Error('Could not obtain auth token');

    const passwordHash = await hashPassword('waiver-viewer-pass');
    const viewer = await app.db.getRepository(User).save(
      app.db.getRepository(User).create({
        email: viewerName,
        passwordHash,
        role: 'User',
      })
    );
    viewerId = viewer.id;
    const viewerLogin = await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: viewerName, password: 'waiver-viewer-pass' })
      .expect(200);
    viewerToken = viewerLogin.body.token;
  });

  afterAll(async () => {
    if (!app) return;
    await app.db.getRepository(WaiverRequest).delete({ packageName });
    await app.db.getRepository(Exception).delete({ packageName });
    if (viewerId) await app.db.getRepository(User).delete({ id: viewerId });
    await app.close();
  });

  function future(days: number): string {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  it('Viewer can request a waiver and see only their own', async () => {
    const created = await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName,
        ecosystem: 'npm',
        version: '1.2.3',
        expiresAt: future(14),
        reason: 'Release needs this package',
      })
      .expect(201);

    expect(created.body.status).toBe('pending');
    expect(created.body.requestedBy).toBe(viewerName);
    expect(created.body.approvedExpiresAt).toBeNull();

    const mine = await supertest(app.server)
      .get('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    expect(mine.body.items.some((row: { id: string }) => row.id === created.body.id)).toBe(true);

    await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        packageName,
        ecosystem: 'npm',
        version: '1.2.3',
        expiresAt: future(7),
        reason: 'Admins file exceptions directly',
      })
      .expect(403);
  });

  it('rejects a duplicate pending request and a past expiry', async () => {
    await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName,
        ecosystem: 'npm',
        version: '1.2.3',
        expiresAt: future(3),
        reason: 'Duplicate',
      })
      .expect(409);

    await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: `${packageName}-past`,
        ecosystem: 'npm',
        version: '1.0.0',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        reason: 'Too late',
      })
      .expect(400);
  });

  it('accepts named versions and rejects range syntax typed as a version', async () => {
    const named = `${packageName}-named`;
    for (const [ecosystem, version] of [['rubygems', '~> 1.2'], ['maven', '[1.0,2.0)'], ['pypi', '>=1.0,<2.0']]) {
      const res = await supertest(app.server)
        .post('/api/waiver-requests')
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ packageName: named, ecosystem, version, expiresAt: future(3), reason: 'Range syntax' })
        .expect(400);
      expect(res.body.error).toMatch(/is not a version/);
    }

    const created = await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: named,
        ecosystem: 'maven',
        version: '1.0-SNAPSHOT || 2.0.0-rc.1 - 2.0.0',
        expiresAt: future(3),
        reason: 'Named versions',
      })
      .expect(201);
    expect(created.body.version).toBe('1.0-SNAPSHOT || 2.0.0-rc.1 - 2.0.0');
    await app.db.getRepository(WaiverRequest).delete({ packageName: named });
  });

  it('Admin approves with a different expiry and the exception uses that date', async () => {
    const list = await supertest(app.server)
      .get('/api/waiver-requests?status=pending')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const pending = list.body.items.find((row: { packageName: string }) => row.packageName === packageName);
    expect(pending).toBeTruthy();

    const approvedExpiry = future(3);
    const approved = await supertest(app.server)
      .post(`/api/waiver-requests/${pending.id}/approve`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ expiresAt: approvedExpiry, reviewNote: 'Three days is enough' })
      .expect(403);

    expect(approved.body.error).toBe('Insufficient permissions');

    const ok = await supertest(app.server)
      .post(`/api/waiver-requests/${pending.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expiresAt: approvedExpiry, reviewNote: 'Three days is enough' })
      .expect(200);

    expect(ok.body.status).toBe('approved');
    expect(new Date(ok.body.approvedExpiresAt).getTime()).toBe(new Date(approvedExpiry).getTime());
    expect(new Date(ok.body.requestedExpiresAt).getTime()).not.toBe(new Date(approvedExpiry).getTime());

    const exceptions = await supertest(app.server)
      .get(`/api/admin/exceptions?package=${encodeURIComponent(packageName)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const created = exceptions.body.items.find((row: { id: string }) => row.id === ok.body.exceptionId);
    expect(created).toBeTruthy();
    expect(new Date(created.expiresAt).getTime()).toBe(new Date(approvedExpiry).getTime());
    expect(created.reason).toContain('Release needs this package');
    expect(created.reason).toContain('Approver note: Three days is enough');

    const viewerView = await supertest(app.server)
      .get('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(200);
    const own = viewerView.body.items.find((row: { id: string }) => row.id === pending.id);
    expect(own.status).toBe('approved');
    expect(own.approvedExpiresAt).toBe(ok.body.approvedExpiresAt);
  });

  it('Admin can reject a pending request without creating an exception', async () => {
    const created = await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName,
        ecosystem: 'pypi',
        version: '9.9.9',
        expiresAt: future(10),
        reason: 'Trying another ecosystem',
      })
      .expect(201);

    const rejected = await supertest(app.server)
      .post(`/api/waiver-requests/${created.body.id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reviewNote: 'Use the patched release instead' })
      .expect(200);

    expect(rejected.body.status).toBe('rejected');
    expect(rejected.body.reviewNote).toBe('Use the patched release instead');
    expect(rejected.body.exceptionId).toBeNull();
  });

  it('lets the owner edit or delete a request until it is approved', async () => {
    const created = await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: `${packageName}-own`,
        ecosystem: 'npm',
        version: '1.0.0',
        expiresAt: future(8),
        reason: 'First draft',
      })
      .expect(201);

    const edited = await supertest(app.server)
      .patch(`/api/waiver-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: `${packageName}-own`,
        ecosystem: 'npm',
        version: '2.0.0',
        expiresAt: future(12),
        reason: 'Updated reason',
      })
      .expect(200);
    expect(edited.body.reason).toBe('Updated reason');
    expect(edited.body.version).toBe('2.0.0');
    expect(edited.body.status).toBe('pending');

    await supertest(app.server)
      .patch(`/api/waiver-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        packageName: `${packageName}-own`,
        ecosystem: 'npm',
        version: '2.0.0',
        expiresAt: future(12),
        reason: 'Security cannot edit',
      })
      .expect(403);

    await supertest(app.server)
      .delete(`/api/waiver-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(204);

    const approved = await supertest(app.server)
      .post('/api/waiver-requests')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: `${packageName}-locked`,
        ecosystem: 'go',
        version: '1.0.0',
        expiresAt: future(6),
        reason: 'Needs approval',
      })
      .expect(201);
    await supertest(app.server)
      .post(`/api/waiver-requests/${approved.body.id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expiresAt: future(4) })
      .expect(200);

    await supertest(app.server)
      .patch(`/api/waiver-requests/${approved.body.id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({
        packageName: `${packageName}-locked`,
        ecosystem: 'go',
        version: '1.0.0',
        expiresAt: future(9),
        reason: 'Too late',
      })
      .expect(409);
    await supertest(app.server)
      .delete(`/api/waiver-requests/${approved.body.id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(409);

    await app.db.getRepository(WaiverRequest).delete({ packageName: `${packageName}-own` });
    await app.db.getRepository(WaiverRequest).delete({ packageName: `${packageName}-locked` });
    await app.db.getRepository(Exception).delete({ packageName: `${packageName}-locked` });
  });
});
