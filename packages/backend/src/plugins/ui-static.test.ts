import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import uiStatic, { appShell, isUiNavigation } from './ui-static.js';

const HTML = 'text/html,application/xhtml+xml';

describe('isUiNavigation', () => {
  it('serves the app shell for browser navigation to UI routes', () => {
    expect(isUiNavigation('GET', '/policies/12/edit', HTML)).toBe(true);
    expect(isUiNavigation('GET', '/set-password?token=x', HTML)).toBe(true);
  });

  it('never answers API, registry or ops paths with HTML', () => {
    for (const url of ['/api/nope', '/npm/missing', '/pypi/default/simple/x/', '/rubygems', '/metrics', '/healthz?x=1']) {
      expect(isUiNavigation('GET', url, HTML)).toBe(false);
    }
  });

  it('leaves package clients and non-GET requests alone', () => {
    expect(isUiNavigation('GET', '/policies', 'application/json')).toBe(false);
    expect(isUiNavigation('GET', '/policies', undefined)).toBe(false);
    expect(isUiNavigation('POST', '/policies', HTML)).toBe(false);
  });

  it('does not treat a UI route that only starts like an ecosystem as one', () => {
    expect(isUiNavigation('GET', '/npmish', HTML)).toBe(true);
  });
});

describe('appShell', () => {
  it('adds DOCS_URL as a meta tag, escaped', () => {
    expect(appShell('<html><head></head></html>', 'https://docs.example.com/?a=1&b="2"')).toBe(
      '<html><head>  <meta name="depgate-docs-url" content="https://docs.example.com/?a=1&amp;b=&quot;2&quot;">\n</head></html>'
    );
  });

  it('leaves the shell alone without DOCS_URL', () => {
    expect(appShell('<html><head></head></html>', '')).toBe('<html><head></head></html>');
  });
});

describe('ui-static plugin', () => {
  let dir: string;
  let app: FastifyInstance;
  const original = config.uiDir;
  const originalDocsUrl = config.ui.docsUrl;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgate-ui-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head>shell</html>');
    fs.writeFileSync(path.join(dir, 'main-ABCDEFGH.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'favicon.ico'), 'x');
    (config as { uiDir: string }).uiDir = dir;
    (config.ui as { docsUrl: string }).docsUrl = 'https://docs.example.com/';

    app = Fastify();
    app.get('/api/ping', async () => ({ ok: true }));
    await app.register(uiStatic);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    (config as { uiDir: string }).uiDir = original;
    (config.ui as { docsUrl: string }).docsUrl = originalDocsUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html at the root without long caching', async () => {
    const r = await app.inject({ url: '/', headers: { accept: HTML } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('shell');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.headers['content-type']).toContain('text/html');
  });

  it('puts DOCS_URL in the shell at /, /index.html and deep links', async () => {
    for (const url of ['/', '/index.html', '/monitoring/42']) {
      const r = await app.inject({ url, headers: { accept: HTML } });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('<meta name="depgate-docs-url" content="https://docs.example.com/">');
    }
  });

  it('caches hashed bundles for a year', async () => {
    const r = await app.inject({ url: '/main-ABCDEFGH.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers a deep link with the app shell', async () => {
    const r = await app.inject({ url: '/monitoring/42', headers: { accept: HTML } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('shell');
  });

  it('keeps API routes and JSON 404s', async () => {
    expect((await app.inject({ url: '/api/ping', headers: { accept: HTML } })).json()).toEqual({ ok: true });
    const missing = await app.inject({ url: '/npm/does-not-exist', headers: { accept: HTML } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'Not Found', statusCode: 404 });
  });
});
