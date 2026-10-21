import fs from 'node:fs';
import path from 'node:path';
import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from '../config.js';
import { ECOSYSTEMS } from '../services/repo-keys.js';

/** Paths that belong to the API, package clients or operations. They keep a JSON 404 and never get the UI. */
const NOT_UI = new RegExp(`^/(?:api|${ECOSYSTEMS.join('|')}|healthz|readyz|metrics)(?:/|$|\\?)`);

/** Angular build names bundles with a content hash, so a new release always has new file names. */
const HASHED_BUNDLE = /-[A-Z0-9]{8,}\.(?:js|css)$/;

export function uiDirectory(): string {
  return path.resolve(config.uiDir || path.join(__dirname, '../../public'));
}

/** Browser navigation to a UI route (deep link or reload), as opposed to an API or package client request. */
export function isUiNavigation(method: string, url: string, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (NOT_UI.test(url)) return false;
  return (accept ?? '').includes('text/html');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The app shell with deployment settings from .env added as meta tags, which the UI reads at startup. */
export function appShell(html: string, docsUrl: string): string {
  if (!docsUrl) return html;
  return html.replace('</head>', `  <meta name="depgate-docs-url" content="${escapeAttribute(docsUrl)}">\n</head>`);
}

/**
 * Serves the web UI from the same origin as the API and the registries, so one port carries everything.
 * Does nothing when the build is absent (development, where the UI runs on ng serve).
 */
const uiStatic: FastifyPluginAsync = async (fastify) => {
  const root = uiDirectory();
  const indexFile = path.join(root, 'index.html');
  if (!fs.existsSync(indexFile)) return;
  const shell = appShell(fs.readFileSync(indexFile, 'utf8'), config.ui.docsUrl);
  const sendShell = (reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(shell);

  await fastify.register(fastifyStatic, {
    root,
    // One route per file found at startup, so the UI never shadows an API or registry route.
    wildcard: false,
    // The shell is sent from memory below, with its meta tags filled in.
    globIgnore: ['index.html'],
    // Its own Cache-Control would overwrite the one set below.
    cacheControl: false,
    setHeaders(reply, file) {
      // The app shell names the current bundles, so browsers must revalidate it on every load.
      reply.header('Cache-Control', HASHED_BUNDLE.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  fastify.get('/', (_request, reply) => sendShell(reply));
  fastify.get('/index.html', (_request, reply) => sendShell(reply));

  // Angular routes such as /policies/12/edit exist only in the browser. Anything else keeps a plain 404,
  // so a package client asking for a missing file never receives HTML.
  fastify.setNotFoundHandler((request, reply) => {
    if (isUiNavigation(request.method, request.url, request.headers.accept)) {
      return sendShell(reply);
    }
    // Same body as Fastify's default 404.
    return reply.status(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });

  fastify.log.info({ root }, 'Serving web UI');
};

// Not encapsulated: the not-found handler must cover the whole app.
export default fp(uiStatic, { name: 'ui-static' });
