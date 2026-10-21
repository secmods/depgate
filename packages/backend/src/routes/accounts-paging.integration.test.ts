/**
 * Paging and search of Access → Users and Service accounts. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { FastifyInstance } from 'fastify';
import { Like } from 'typeorm';
import { buildApp } from '../app.js';
import { ApiKey } from '../db/entities/ApiKey.js';
import { User } from '../db/entities/User.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Users and service accounts: paging and search', () => {
  let app: FastifyInstance;
  let admin: string;
  const tag = `paging${Date.now()}`;
  const emails = ['c', 'a', 'b'].map((letter) => `${tag}-${letter}@example.com`);

  const api = () => supertest(app.server);
  const auth = () => ({ Authorization: `Bearer ${admin}` });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    for (const creds of [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'admin@depgate.local', password: 'admin' },
    ]) {
      const res = await api().post('/api/auth/login').send(creds);
      if (res.status === 200) {
        admin = res.body.token;
        break;
      }
    }
    if (!admin) throw new Error('Could not obtain auth token');
    for (const email of emails) {
      await api().post('/api/admin/users').set(auth()).send({ email, role: 'User', sendInvite: false }).expect(201);
    }
    for (const name of [`${tag}-one`, `${tag}-two`, `${tag}-three`, `${tag}_under`]) {
      await api().post('/api/admin/service-accounts').set(auth()).send({ name }).expect(201);
    }
  });

  afterAll(async () => {
    if (!app) return;
    await app.db.getRepository(User).delete({ email: Like(`${tag}-%`) });
    await app.db.getRepository(ApiKey).delete({ name: Like(`${tag}%`) });
    await app.close();
  });

  it('pages users by email and reports the total', async () => {
    const first = await api().get('/api/admin/users').query({ search: tag, limit: '2', offset: '0' }).set(auth()).expect(200);
    expect(first.body.total).toBe(3);
    expect(first.body.items.map((u: { email: string }) => u.email)).toEqual([emails[1], emails[2]]);
    const second = await api().get('/api/admin/users').query({ search: tag, limit: '2', offset: '2' }).set(auth()).expect(200);
    expect(second.body.items.map((u: { email: string }) => u.email)).toEqual([emails[0]]);
    expect(second.body.items[0]).toMatchObject({ status: 'invited', invitePending: false, signInMethods: [] });
  });

  it('searches case-insensitively and treats % and _ as text', async () => {
    const upper = await api().get('/api/admin/users').query({ search: `${tag}-A@` }).set(auth()).expect(200);
    expect(upper.body.items.map((u: { email: string }) => u.email)).toEqual([emails[1]]);
    const wildcard = await api().get('/api/admin/users').query({ search: '%' }).set(auth()).expect(200);
    expect(wildcard.body.total).toBe(0);
    const underscore = await api().get('/api/admin/service-accounts').query({ search: `${tag}_` }).set(auth()).expect(200);
    expect(underscore.body.items.map((k: { name: string }) => k.name)).toEqual([`${tag}_under`]);
  });

  it('pages service accounts newest first', async () => {
    const res = await api().get('/api/admin/service-accounts').query({ search: tag, limit: '3' }).set(auth()).expect(200);
    expect(res.body.total).toBe(4);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].name).toBe(`${tag}_under`);
    expect(res.body.items[0]).not.toHaveProperty('keyHash');
  });

  it('keeps limit and offset in range', async () => {
    const res = await api().get('/api/admin/users').query({ limit: '100000', offset: '-5' }).set(auth()).expect(200);
    expect(res.body.items.length).toBeLessThanOrEqual(200);
    const fallback = await api().get('/api/admin/users').query({ limit: 'abc' }).set(auth()).expect(200);
    expect(fallback.body.items.length).toBeLessThanOrEqual(50);
  });

  it('filters users by type, role and status', async () => {
    const [c, a, b] = emails;
    const users = app.db.getRepository(User);
    await users.update({ email: a }, { source: 'sso', lastLoginAt: new Date() });
    await users.update({ email: b }, { role: 'Security', passwordHash: 'x' });
    await users.update({ email: c }, { disabledAt: new Date() });

    const list = async (filters: Record<string, string>) => {
      const res = await api().get('/api/admin/users').query({ search: tag, ...filters }).set(auth()).expect(200);
      expect(res.body.total).toBe(res.body.items.length);
      return res.body.items.map((u: { email: string }) => u.email);
    };
    expect(await list({ source: 'sso' })).toEqual([a]);
    expect(await list({ source: 'local' })).toEqual([b, c]);
    expect(await list({ role: 'Security' })).toEqual([b]);
    expect(await list({ role: 'User' })).toEqual([a, c]);
    expect(await list({ status: 'active' })).toEqual([a, b]);
    expect(await list({ status: 'disabled' })).toEqual([c]);
    expect(await list({ status: 'invited' })).toEqual([]);
    expect(await list({ source: 'local', status: 'active' })).toEqual([b]);

    await users.update({ email: c }, { disabledAt: null });
    expect(await list({ status: 'invited' })).toEqual([c]);

    await api().get('/api/admin/users').query({ source: 'ldap' }).set(auth()).expect(400);
    await api().get('/api/admin/users').query({ role: 'ServiceAccount' }).set(auth()).expect(400);
  });
});
