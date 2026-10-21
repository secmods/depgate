import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E for DepGate.
 *
 *   npm run test:e2e
 *   npm run test:e2e:ui
 *
 * Both start what they need: `webServer` below runs e2e/stack.mjs, which brings up DepGate on 3050 (backend,
 * postgres, redis) and Keycloak on 8180 (compose profile `sso`) with docker compose, builds the DepGate image
 * when it starts the backend, and reuses whatever already answers. That file explains the rebuild trade-off.
 *
 * With the dev servers, set E2E_BASE_URL=http://localhost:4200: then nothing is started and the stack is
 * yours (`npm run dev:backend`, plus `docker compose --profile sso up -d keycloak` for the SSO suites).
 * The suite shares one database, so it runs one test at a time.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3050';

/** Covers a first run: image pulls, the DepGate build and Keycloak's realm import. */
const STACK_TIMEOUT = 15 * 60_000;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // One entry per URL the stack must answer on, started in this order. A DepGate that already answers is
  // reused (reuseExistingServer); the second entry then still brings up Keycloak when only that is missing.
  // The script starts only what is missing, so running it twice is harmless.
  webServer: process.env.E2E_BASE_URL ? undefined : [
    {
      name: 'depgate',
      command: 'node e2e/stack.mjs --hold',
      url: 'http://localhost:3050/readyz',
      reuseExistingServer: true,
      timeout: STACK_TIMEOUT,
      stdout: 'pipe',
    },
    {
      name: 'keycloak',
      command: 'node e2e/stack.mjs --hold',
      url: 'http://localhost:8180/realms/depgate/.well-known/openid-configuration',
      reuseExistingServer: true,
      timeout: STACK_TIMEOUT,
      stdout: 'pipe',
    },
  ],
});
