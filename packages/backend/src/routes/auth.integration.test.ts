/**
 * Auth integration tests. Requires PostgreSQL + Redis (RUN_INTEGRATION=1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';
import { GatewaySettings } from '../db/entities/GatewaySettings.js';

describe.skipIf(!process.env.RUN_INTEGRATION)('Auth routes', () => {
  let app: FastifyInstance;
  let validCreds: { email: string; password: string } | undefined;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (!app) return;
    await app.close();
  });

  it('POST /api/auth/login returns token for valid credentials', async () => {
    const candidates = [
      { email: 'testadmin@depgate.local', password: 'testpass123' },
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'npmpolicyadmin@depgate.local', password: 'npmpolicyadmin123' },
      { email: 'pypiadmin@depgate.local', password: 'pypiadmin123' },
      { email: 'goadmin@depgate.local', password: 'goadmin123' },
      { email: 'mavenadmin@depgate.local', password: 'mavenadmin123' },
    ];

    if (!validCreds) {
      for (const creds of candidates) {
        const probe = await supertest(app.server).post('/api/auth/login').send(creds);
        if (probe.status === 200 && probe.body.token) {
          validCreds = creds;
          break;
        }
      }
    }
    expect(validCreds, 'No valid admin credentials found for integration auth test').toBeDefined();

    const response = await supertest(app.server)
      .post('/api/auth/login')
      .send(validCreds!)
      .expect(200);

    expect(response.body.token).toBeDefined();
    expect(response.body.registryToken).toBeDefined();
    expect(response.body.user?.email).toBe(validCreds!.email);
    expect(response.body.user?.role).toBe('Security');

    const settings = app.db.getRepository(GatewaySettings);
    const previous = await settings.findOneByOrFail({ id: 'default' });
    await settings.update({ id: 'default' }, { sessionTokenDays: 30 });
    const issued = await supertest(app.server)
      .post('/api/auth/login')
      .send(validCreds!)
      .expect(200);
    const uiPayload = JSON.parse(Buffer.from(issued.body.token.split('.')[1], 'base64url').toString()) as {
      iat: number;
      exp: number;
      type: string;
    };
    const registryPayload = JSON.parse(Buffer.from(issued.body.registryToken.split('.')[1], 'base64url').toString()) as {
      iat: number;
      exp: number;
      type: string;
    };
    expect(uiPayload.type).toBe('user');
    expect(uiPayload.exp - uiPayload.iat).toBe(60 * 60);
    expect(registryPayload.type).toBe('registry');
    expect(registryPayload.exp - registryPayload.iat).toBe(30 * 24 * 60 * 60);
    await settings.update({ id: 'default' }, { sessionTokenDays: previous.sessionTokenDays });
  });

  it('POST /api/auth/login returns 401 for invalid credentials', async () => {
    await supertest(app.server)
      .post('/api/auth/login')
      .send({ email: 'testadmin@depgate.local', password: 'wrong' })
      .expect(401);
  });

  it('POST /api/auth/login returns 400 without body', async () => {
    await supertest(app.server)
      .post('/api/auth/login')
      .send({})
      .expect(400);
  });
});
