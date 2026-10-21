#!/usr/bin/env node
/**
 * Brings up what the end-to-end suite needs and waits until it answers:
 *
 *   DepGate    http://localhost:3050/readyz                                           compose: backend, postgres, redis
 *   Keycloak   http://localhost:8180/realms/depgate/.well-known/openid-configuration  compose: keycloak (profile `sso`)
 *
 * Playwright runs it from `webServer` in playwright.config.ts, so `npm run test:e2e` and `npm run test:e2e:ui`
 * need nothing started by hand; the CI e2e job runs it as a step. Only the services that do not answer are
 * started, so a stack that already runs, from this or any other checkout, is used as it is. The compose project
 * is this directory's, the same one `docker compose up` uses, and it stays up afterwards for the next run.
 *
 *   node e2e/stack.mjs          start what is missing, wait until both answer, exit
 *   node e2e/stack.mjs --hold   the same, then stay alive until killed: Playwright treats a webServer command
 *                               that exits before its URL answers as a failed start
 *
 * Rebuilds. The backend image is built from the Dockerfile, so a code change is only tested after a rebuild.
 * Whenever this script starts the backend it passes --build: with Docker's layer cache an unchanged tree costs
 * a few seconds and a changed tree costs the build it needs anyway, which beats silently testing stale code.
 * E2E_NO_BUILD=1 skips the build (the image from the last build, or the registry, is used). A DepGate that
 * already answers on 3050 is reused without a rebuild: after a code change, run
 * `docker compose up -d --build backend` (or `docker compose down`) before the suite.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPGATE = 'http://localhost:3050/readyz';
const KEYCLOAK = 'http://localhost:8180/realms/depgate/.well-known/openid-configuration';
const READY_TIMEOUT_MS = 5 * 60_000;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function log(message) {
  console.log(`[e2e stack] ${message}`);
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function waitFor(name, url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await answers(url))) {
    if (Date.now() > deadline) {
      throw new Error(`${name} did not answer at ${url} within ${READY_TIMEOUT_MS / 1000}s. Logs: docker compose --profile sso logs`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log(`${name} answers at ${url}`);
}

const services = [];
if (await answers(DEPGATE)) log('DepGate already answers on 3050: using it as it is (rebuild it yourself after a code change)');
else services.push('backend');
if (await answers(KEYCLOAK)) log('Keycloak already answers on 8180: using it as it is');
else services.push('keycloak');

if (services.length > 0) {
  const args = ['compose', '--profile', 'sso', 'up', '-d', '--wait'];
  if (services.includes('backend') && !process.env.E2E_NO_BUILD) args.push('--build');
  args.push(...services);
  log(`docker ${args.join(' ')}`);
  if (services.includes('backend')) log('The first run pulls the images and builds DepGate: a few minutes.');
  const result = spawnSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(`[e2e stack] could not run docker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[e2e stack] docker compose up failed (exit ${result.status}). Logs: docker compose --profile sso logs`);
    process.exit(result.status ?? 1);
  }
}

await waitFor('DepGate', DEPGATE);
await waitFor('Keycloak', KEYCLOAK);

if (process.argv.includes('--hold')) {
  log('stack ready; staying alive for Playwright');
  setInterval(() => {}, 1 << 30);
}
