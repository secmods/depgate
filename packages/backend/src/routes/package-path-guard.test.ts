import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';

describe('package path guard', () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = await buildApp({ docsOnly: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app.close();
  });

  it.each([
    '/npm/lodash/-/..%2F..%2Fevil-pkg%2F-%2Fevil-pkg-1.0.0.tgz',
    '/npm/default/lodash/-/..%2F..%2Fevil-pkg%2F-%2Fevil-pkg-1.0.0.tgz',
    '/npm/lodash/-/x%2Fevil-pkg-1.0.0.tgz',
    '/npm/@scope/name/-/..%2F..%2F..%2Fevil-pkg%2F-%2Fevil-pkg-1.0.0.tgz',
    '/npm/..%2Fevil-pkg',
    '/npm/@a%2F..%2F..%2Fevil-pkg',
    '/go/github.com/good/x/..%2F..%2F..%2Fevil/x/@v/v1.0.0.zip',
    '/go/github.com/good/x/%252e%252e/evil/@v/v1.0.0.zip',
    '/go/evil.com/mal/@v/v1.0.0.zip%3F/@v/v9.0.0.zip',
    '/maven/com/good/lib/1.0/..%2F..%2F..%2F..%2Fevil/lib/1.0/lib-1.0.jar',
    '/nuget/v3-flatcontainer/%252e%252e/x/y',
    '/pypi/simple/x%2F..%2Fevil/',
    '/cargo/api/v1/crates/..%2Fevil/1.0.0/download',
    '/composer/p2/%252e%252e/evil.json',
    '/rubygems/info/%252e%252e',
    '/go/github.com/good/x/.%09./evil/@v/v1.0.0.zip',
  ])('rejects %s before policy or upstream', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid package path' });
  });

  // inject() resolves `..` and `%2e%2e` itself; a raw socket sends them as a client can.
  it.each([
    '/maven/com/good/lib/1.0/../../../../evil/lib/1.0/lib-1.0.jar',
    '/go/github.com/good/x/%2e%2e/%2e%2e/evil/x/@v/v1.0.0.zip',
    '/rubygems/info/..',
  ])('rejects %s sent unnormalized', async (path) => {
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(400);
  });

  it.each([
    '/npm/lodash',
    '/npm/@types%2fnode',
    '/npm/@types/node',
    '/npm/@angular%2fcore/-/core-12.0.0.tgz',
    '/npm/@angular/core/-/core-12.0.0.tgz',
    '/npm/lodash/-/lodash-4.17.21.tgz',
    '/go/github.com/sirupsen/logrus/@v/v1.9.3.zip',
    '/maven/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar',
    '/pypi/simple/requests/',
    '/pypi/files/abc.def/requests-2.0.0.tar.gz',
  ])('lets %s through to authentication', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).not.toBe(400);
  });
});
