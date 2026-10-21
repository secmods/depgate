/**
 * Registry 401s carry a Basic challenge; API 401s do not.
 * Run:
 *   RUN_INTEGRATION=1 vitest run src/plugins/auth-challenge.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '../app.js';
import { FastifyInstance } from 'fastify';

describe.skipIf(!process.env.RUN_INTEGRATION)('registry auth challenge', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    '/maven/default/org/apache/commons/commons-lang3/maven-metadata.xml',
    '/nuget/default/v3/index.json',
    '/rubygems/default/specs.4.8.gz',
    '/go/default/github.com/pkg/errors/@v/list',
  ])('%s without credentials asks for Basic auth', async (path) => {
    const res = await supertest(app.server).get(path).expect(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="DepGate"');
  });

  it('a registry request with a bad token is challenged too', async () => {
    const res = await supertest(app.server)
      .get('/maven/default/org/apache/commons/commons-lang3/maven-metadata.xml')
      .auth('_', 'not-a-token')
      .expect(401);
    expect(res.headers['www-authenticate']).toBe('Basic realm="DepGate"');
  });

  it('API routes are not challenged, so browsers show no sign-in dialog', async () => {
    const res = await supertest(app.server).get('/api/admin/policies').expect(401);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });
});
