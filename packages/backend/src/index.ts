import 'dotenv/config';
import 'reflect-metadata';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type https from 'node:https';
import { FastifyInstance } from 'fastify';
import { buildApp, readTlsFiles } from './app.js';
import { config } from './config.js';
import { installCrashHandlers } from './crash-handlers.js';

/** How often a mounted certificate is checked for renewal. */
const CERT_POLL_MS = 60_000;

/**
 * Plain-HTTP listener that sends every request to the same path on GATEWAY_URL.
 * The target comes from configuration, never from the Host header, so it cannot be turned into an open redirect.
 */
function startRedirectServer(app: FastifyInstance, port: number): http.Server {
  const origin = new URL(config.gateway.baseUrl).origin;
  const server = http.createServer((req, res) => {
    const location = origin + (req.url?.startsWith('/') ? req.url : '/');
    // 308 keeps the method and body for publish requests; browsers and GETs get the classic 301.
    const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308;
    res.writeHead(status, { Location: location, 'Content-Length': '0' }).end();
  });
  server.listen(port, config.host, () => app.log.info(`HTTP redirect to ${origin} on ${config.host}:${port}`));
  return server;
}

/** Private listener for Prometheus and container health checks. */
function startManagementServer(app: FastifyInstance, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (path === '/metrics' && app.hasDecorator('metrics')) {
        const { contentType, body } = await app.metrics.render();
        res.writeHead(200, { 'Content-Type': contentType }).end(body);
        return;
      }
      if (path === '/healthz' || path === '/readyz') {
        const r = await app.inject({ method: 'GET', url: path });
        res.writeHead(r.statusCode, { 'Content-Type': 'application/json' }).end(r.body);
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      app.log.error(err, 'Management request failed');
      res.writeHead(500).end();
    }
  });
  server.listen(port, config.host, () => app.log.info(`Management (metrics, health) on ${config.host}:${port}`));
  return server;
}

/** Applies a renewed certificate to new connections without a restart. Triggered by SIGHUP or a file change. */
function watchCertificate(app: FastifyInstance): void {
  const reload = (reason: string) => {
    try {
      const tls = readTlsFiles();
      if (!tls) return;
      (app.server as unknown as https.Server).setSecureContext(tls);
      app.log.info(`TLS certificate reloaded (${reason})`);
    } catch (err) {
      // Keep serving the previous certificate; a half-written file is retried on the next change.
      app.log.error(err, 'TLS certificate reload failed; keeping the current certificate');
    }
  };
  process.on('SIGHUP', () => reload('SIGHUP'));
  // Polling works for bind mounts and Kubernetes secret updates, where inotify events are unreliable.
  for (const file of [config.tls.certFile, config.tls.keyFile]) {
    fs.watchFile(file, { interval: CERT_POLL_MS }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) reload(`${file} changed`);
    });
  }
}

async function main() {
  // Before any outbound connection: applies to fetch and every other client in the process.
  net.setDefaultAutoSelectFamilyAttemptTimeout(config.upstream.connectAttemptTimeoutMs);
  let app: FastifyInstance;
  try {
    app = await buildApp();
  } catch (err) {
    console.error(`DepGate did not start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const extraServers: http.Server[] = [];
  // buildApp made an HTTPS server exactly when readTlsFiles found certificates.
  const tlsEnabled = Boolean(readTlsFiles());
  const port = tlsEnabled ? config.tls.port : config.port;

  // docker stop sends SIGTERM: finish requests in flight and close DB, Redis and workers before exiting.
  let stopping = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal} received, shutting down`);
    for (const s of extraServers) s.close();
    try {
      await app.close();
      process.exit(exitCode);
    } catch (err) {
      app.log.error(err, 'Shutdown failed');
      process.exit(1);
    }
  };
  installCrashHandlers(app.log, (reason) => void shutdown(reason, 1));

  try {
    if (config.tls.disabled && config.tls.certFile) app.log.info('DISABLE_SSL is set: serving plain HTTP, TLS_CERT_FILE ignored');
    await app.listen({ port, host: config.host });
    const scheme = tlsEnabled ? 'https' : 'http';
    app.log.info(`DepGate listening on ${scheme}://${config.host}:${port}`);
    app.log.info(`Swagger UI at ${scheme}://${config.host}:${port}/api/docs`);
    app.log.info(`OpenAPI spec at ${scheme}://${config.host}:${port}/api/swagger.yml`);

    if (tlsEnabled) {
      watchCertificate(app);
      if (config.tls.redirectHttp) extraServers.push(startRedirectServer(app, config.port));
    }
    if (config.managementPort) extraServers.push(startManagementServer(app, config.managementPort));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main();
