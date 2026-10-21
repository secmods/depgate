/**
 * npm registry auth integration tests.
 * Registry auth is always enabled for package downloads.
 * Run:
 *   RUN_INTEGRATION=1 vitest run src/routes/npm-registry-auth.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { FastifyInstance } from 'fastify';
import { Policy } from '../db/entities/Policy.js';
import { In } from 'typeorm';

describe.skipIf(!process.env.RUN_INTEGRATION)('npm registry auth', () => {
  let app: FastifyInstance;
  let token: string | undefined;
  let previouslyEnabledPolicyIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const adminUser = config.auth.defaultAdminEmail;
    const adminPass = config.auth.defaultAdminPassword;
    const candidates = [
      { email: adminUser, password: adminPass },
      { email: 'admin@depgate.local', password: 'admin' },
      { email: 'testadmin@depgate.local', password: 'testpass123' },
    ];
    for (const creds of candidates) {
      const loginRes = await supertest(app.server).post('/api/auth/login').send(creds);
      if (loginRes.status === 200 && loginRes.body.token) {
        token = loginRes.body.token;
        break;
      }
    }


    // Keep this suite focused on auth semantics; disable active policies temporarily.
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
    const policyRepo = app.db.getRepository(Policy);
    const chunkSize = 500;
    for (let i = 0; i < previouslyEnabledPolicyIds.length; i += chunkSize) {
      const chunk = previouslyEnabledPolicyIds.slice(i, i + chunkSize);
      await policyRepo.update({ id: In(chunk) }, { isEnabled: true });
    }
    await app.close();
  }, 30000);

  describe('Packages require token', () => {
    it('GET /npm/lodash returns 401 without Authorization header', async () => {
      await supertest(app.server)
        .get('/npm/lodash')
        .expect(401);
    });

    it('GET /npm/lodash/-/lodash-4.17.5.tgz returns 401 without Authorization header', async () => {
      await supertest(app.server)
        .get('/npm/lodash/-/lodash-4.17.5.tgz')
        .expect(401);
    });

    it('GET /npm/lodash returns packument with valid token', async () => {
      expect(token, 'Admin token required - ensure setup/login succeeded').toBeDefined();
      const response = await supertest(app.server)
        .get('/npm/lodash')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.versions).toBeDefined();
      expect(Object.keys(response.body.versions as object).length).toBeGreaterThan(0);
    });

    it('GET /npm/lodash/-/lodash-4.17.5.tgz downloads tarball with valid token', async () => {
      expect(token, 'Admin token required - ensure setup/login succeeded').toBeDefined();
      const response = await supertest(app.server)
        .get('/npm/lodash/-/lodash-4.17.5.tgz')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/application\/gzip|application\/octet-stream/);
      const size = Buffer.isBuffer(response.body) ? response.body.length : 0;
      expect(size).toBeGreaterThan(1000);
    });
  });
});
