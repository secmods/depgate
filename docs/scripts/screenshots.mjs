/**
 * Captures the screenshots used in the documentation into docs/public/screenshots/.
 * Run it against the seeded screenshot instance (docker-compose.yml and seed.mjs in this folder):
 *
 *   node docs/scripts/screenshots.mjs              every screenshot
 *   node docs/scripts/screenshots.mjs policy view  only shots whose name contains "policy" or "view"
 *
 * Uses Playwright from the repository root (npm install there first).
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../package.json'));
const { chromium } = require('@playwright/test');

const BASE = process.env.DOCS_BASE_URL ?? 'http://localhost:3060';
const SECURITY = { email: process.env.DOCS_ADMIN_EMAIL ?? 'security@example.com', password: process.env.DOCS_ADMIN_PASSWORD ?? 'docs-demo-admin' };
const USER = { email: 'alice.chen@example.com', password: 'docs-demo-user' };
/** A person in the demo identity provider (e2e/keycloak/depgate-realm.json), for the test sign-in. */
const IDP_USER = { username: 'alice', password: 'Passw0rd!' };
const OUT = join(here, '../public/screenshots');
const filters = process.argv.slice(2);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const contexts = {};

async function pageAs(who) {
  if (!contexts[who.email]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').fill(who.email);
    await page.getByLabel('Password').fill(who.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    contexts[who.email] = page;
  }
  return contexts[who.email];
}

async function open(page, path) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE + path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
}

/** Viewport screenshot; `height` grows the window first so long pages fit without a cut-off sidebar. */
async function capture(page, name, { height, width, locator } = {}) {
  if (height || width) {
    await page.setViewportSize({ width: width ?? 1440, height: height ?? 900 });
    await page.waitForTimeout(400);
  }
  const path = join(OUT, `${name}.png`);
  if (locator) await locator.screenshot({ path });
  else await page.screenshot({ path });
}

async function fitHeight(page, max = 2000) {
  const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
  return Math.min(Math.max(h, 900), max);
}

const dialog = (page) => page.locator('[role="dialog"], .modal.show .modal-dialog, .cdk-overlay-pane').last();

const shots = {
  // ── Getting started ──
  async login() {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
    const page = await context.newPage();
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');
    // The brand panel's request-flow animation runs on an 8 s loop; about 1.5 s in, the first request has reached the gate and been allowed.
    await page.waitForTimeout(1500);
    await capture(page, 'login');
    await context.close();
  },
  async dashboard() {
    const page = await pageAs(SECURITY);
    await open(page, '/dashboard');
    await capture(page, 'dashboard', { height: await fitHeight(page) });
  },

  // ── Developers ──
  async 'registry-npm'() {
    const page = await pageAs(USER);
    await open(page, '/registry');
    await capture(page, 'registry-npm');
  },
  async 'registry-pypi'() {
    const page = await pageAs(USER);
    await open(page, '/registry');
    await page.getByRole('button', { name: /PyPI/ }).first().click();
    await page.waitForTimeout(500);
    await capture(page, 'registry-pypi');
  },
  async 'package-check'() {
    const page = await pageAs(USER);
    await open(page, '/package-check?ecosystem=npm&package=lodash&repository=default');
    await page.waitForTimeout(1500);
    await capture(page, 'package-check', { height: await fitHeight(page, 2000) });
  },
  async 'package-check-blocked'() {
    const page = await pageAs(USER);
    await open(page, '/package-check?ecosystem=npm&package=lodash&version=4.17.19&repository=default');
    await page.waitForTimeout(1500);
    await capture(page, 'package-check-blocked', { height: await fitHeight(page, 2200) });
  },
  async 'waiver-request'() {
    const page = await pageAs(USER);
    await open(page, '/waivers');
    await capture(page, 'waivers-user');
    await page.getByRole('button', { name: /Request waiver/ }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#waiver-package-name').fill('node-fetch');
    await page.getByTestId('add-exact-version').click().catch(() => {});
    await page.locator('.modal-body input[aria-label="Version"]').first().fill('2.6.0').catch(() => {});
    await page.locator('#waiver-reason').fill('Required by the PDF export service until it moves to the native fetch API (ticket WEB-311).');
    await capture(page, 'waiver-request');
    await page.keyboard.press('Escape');
  },

  // ── Policies ──
  async policies() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies');
    await capture(page, 'policies', { height: await fitHeight(page) });
  },
  async 'policy-new'() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies/new');
    await capture(page, 'policy-new');
  },
  async 'policy-new-vulnerability'() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies/new');
    await page.locator('#policy-name').fill('High vulnerabilities in production');
    await page.locator('#policy-description').fill('Blocks versions with a vulnerability rated High or Critical.');
    await page.locator('#policy-priority').fill('15');
    await page.getByTestId('policy-rule-vulnerability').click();
    await page.getByTestId('cvss-min').fill('7.0');
    await page.waitForTimeout(500);
    await capture(page, 'policy-new-vulnerability', { height: await fitHeight(page, 1700) });
  },
  async 'policy-new-license'() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies/new');
    await page.locator('#policy-name').fill('Approved licenses (PyPI)');
    await page.locator('#policy-ecosystem').selectOption({ label: 'PyPI' }).catch(() => {});
    await page.getByTestId('policy-rule-license').click();
    await page.getByTestId('license-mode-allow').click().catch(() => {});
    const chips = page.locator('[data-testid="policy-rule-body"] input[type="text"]').first();
    for (const id of ['MIT', 'Apache-2.0', 'BSD-3-Clause']) {
      await chips.fill(id);
      await chips.press('Enter');
    }
    await chips.fill('');
    await page.keyboard.press('Escape');
    await page.locator('#policy-description').click();
    await page.waitForTimeout(500);
    await capture(page, 'policy-new-license', { height: await fitHeight(page, 1700) });
  },
  async 'policy-new-namespace'() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies/new');
    await page.locator('#policy-name').fill('Protect the @acme namespace');
    await page.locator('#policy-ecosystem').selectOption({ label: 'npm' }).catch(() => {});
    await page.getByTestId('policy-rule-namespace').click();
    const chips = page.getByTestId('ns-reserved-input');
    for (const id of ['@acme', 'acme-*']) {
      await chips.fill(id);
      await chips.press('Enter');
    }
    await chips.fill('');
    await page.waitForTimeout(800);
    await capture(page, 'policy-new-namespace', { height: await fitHeight(page, 1800) });
  },
  async 'policy-view'() {
    const page = await pageAs(SECURITY);
    await open(page, '/policies');
    await page.getByRole('row', { name: /Critical vulnerabilities/ }).first().getByRole('button', { name: /View/i }).click();
    await page.waitForTimeout(800);
    await capture(page, 'policy-view');
    await page.keyboard.press('Escape');
  },

  // ── Monitoring ──
  async monitoring() {
    const page = await pageAs(SECURITY);
    await open(page, '/monitoring');
    await capture(page, 'monitoring', { width: 1600 });
  },
  async 'monitoring-report'() {
    const page = await pageAs(SECURITY);
    await open(page, '/monitoring');
    await page.getByText('Approved licenses (npm)').first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    await capture(page, 'monitoring-report', { height: await fitHeight(page, 1600) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: /^Approve$/ }).first().click();
    await page.waitForTimeout(700);
    await capture(page, 'monitoring-approve');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.getByTestId('detail-enforce').click();
    await page.waitForTimeout(1000);
    await capture(page, 'monitoring-enforce');
    await page.keyboard.press('Escape');
  },

  // ── Exceptions and waivers ──
  async exceptions() {
    const page = await pageAs(SECURITY);
    await open(page, '/exceptions');
    await capture(page, 'exceptions');
    await page.getByRole('button', { name: /Add exception/ }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#exception-package-name').fill('follow-redirects');
    await page.getByTestId('add-exact-version').click().catch(() => {});
    await page.locator('.modal-body input[aria-label="Version"]').first().fill('1.14.0').catch(() => {});
    await page.locator('#exception-reason').fill('Vendor patch applied in our fork; replace after the Q4 upgrade.');
    await capture(page, 'exception-add');
    await page.keyboard.press('Escape');
  },
  async waivers() {
    const page = await pageAs(SECURITY);
    await open(page, '/exceptions');
    await page.getByRole('tab', { name: /Waiver requests/ }).click();
    await page.waitForTimeout(800);
    await capture(page, 'waivers-review');
    await page.getByRole('button', { name: 'Review' }).first().click();
    await page.waitForTimeout(700);
    await capture(page, 'waiver-approve');
    await page.keyboard.press('Escape');
  },

  // ── Malware, ledger, audit ──
  async malicious() {
    const page = await pageAs(SECURITY);
    await open(page, '/malicious');
    await capture(page, 'malicious');
    await page.getByRole('button', { name: 'Change decision' }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#override-reason').fill('False positive confirmed by the security team (ticket SEC-1502).');
    await capture(page, 'malware-override');
    await page.keyboard.press('Escape');
  },
  async ledger() {
    const page = await pageAs(SECURITY);
    await open(page, '/audit');
    await capture(page, 'ledger');
    await page.getByTestId('ledger-table').getByRole('row', { name: /Block · Enforce/ }).first().click();
    await page.waitForTimeout(700);
    await capture(page, 'ledger-detail');
    await page.keyboard.press('Escape');
  },
  async 'audit-log'() {
    const page = await pageAs(SECURITY);
    await open(page, '/audit/log');
    await capture(page, 'audit-log');
    await page.getByTestId('audit-log-table').getByRole('row', { name: /Mail settings changed|Repository updated|Policy/ }).first().click();
    await page.waitForTimeout(700);
    await capture(page, 'audit-log-detail');
  },
  async 'jobs-feeds'() {
    const page = await pageAs(SECURITY);
    await open(page, '/audit/jobs');
    await capture(page, 'jobs-feeds');
  },

  // ── Settings ──
  async repositories() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=upstreams');
    await capture(page, 'settings-repositories', { height: await fitHeight(page) });
    await open(page, '/settings?tab=upstreams');
    await page.getByRole('button', { name: /Add repository/ }).click();
    await page.waitForURL(/\/settings\/repositories\/new/);
    await page.waitForTimeout(700);
    await capture(page, 'repository-add');
  },
  async email() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=email');
    await capture(page, 'settings-email');
  },
  async webhooks() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=webhooks');
    await capture(page, 'settings-webhooks');
    await page.getByRole('button', { name: /Add webhook|Add/ }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#webhook-url').fill('https://hooks.slack.com/services/T0000/B0000/XXXX');
    await capture(page, 'webhook-add');
    await page.keyboard.press('Escape');
  },
  async 'log-streaming'() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=streaming');
    await page.waitForTimeout(1000);
    await capture(page, 'settings-log-streaming');
    await open(page, '/settings/log-streaming/new');
    await page.getByTestId('dest-type-splunk').click();
    await page.getByTestId('dest-name').fill('Splunk production');
    await page.getByTestId('dest-url').fill('https://splunk.acme.internal:8088');
    await page.getByTestId('dest-token').fill('docs-demo-hec-token');
    await page.getByTestId('dest-index').fill('security');
    await page.waitForTimeout(800);
    await capture(page, 'log-streaming-add', { height: await fitHeight(page, 1900) });
  },
  async jobs() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=jobs');
    await capture(page, 'settings-jobs', { height: await fitHeight(page) });
  },
  async 'artifact-cache'() {
    const page = await pageAs(SECURITY);
    await open(page, '/settings?tab=cache');
    await page.waitForTimeout(800);
    await capture(page, 'settings-artifact-cache', { height: await fitHeight(page) });
  },

  // ── Access ──
  async users() {
    const page = await pageAs(SECURITY);
    await open(page, '/access?tab=users');
    await capture(page, 'access-users', { height: await fitHeight(page) });
    await open(page, '/access?tab=users');
    await page.getByRole('button', { name: /Add user/ }).first().click();
    await page.waitForTimeout(600);
    await dialog(page).getByLabel(/Email/).first().fill('dev.lead@example.com');
    await capture(page, 'user-add');
    await page.keyboard.press('Escape');
  },
  async 'service-accounts'() {
    const page = await pageAs(SECURITY);
    await open(page, '/access?tab=service-accounts');
    await capture(page, 'access-service-accounts');
    await page.getByRole('button', { name: /Add service account/ }).first().click();
    await page.waitForTimeout(600);
    await page.locator('#sa-name').fill('gitlab-ci');
    await capture(page, 'service-account-add');
    await page.keyboard.press('Escape');
  },
  async sso() {
    const page = await pageAs(SECURITY);
    await open(page, '/access?tab=sso');
    await page.waitForTimeout(800);
    await capture(page, 'access-sso', { height: await fitHeight(page) });
  },
  async 'sso-provider-new'() {
    const page = await pageAs(SECURITY);
    await open(page, '/access/sso/new');
    await page.locator('#sso-name').fill('Okta');
    await page.locator('#sso-label').fill('Sign in with Okta');
    await page.locator('#sso-issuer').fill('https://acme.okta.com');
    await page.locator('#sso-client-id').fill('0oa1acmedepgate4x7');
    await page.locator('#sso-client-secret').fill('docs-demo-client-secret');
    await page.locator('#sso-scopes').click();
    await page.waitForTimeout(600);
    await capture(page, 'sso-provider-new', { height: await fitHeight(page, 1700) });
  },
  async 'sso-provider-saml'() {
    const page = await pageAs(SECURITY);
    await open(page, '/access/sso/new');
    await page.getByTestId('sso-type-saml').click();
    await page.locator('#sso-name').fill('Entra ID');
    await page.locator('#sso-label').fill('Sign in with Microsoft');
    await page.locator('#saml-metadata-url').fill('https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml');
    await page.locator('#sso-scopes, #saml-entity-id').first().click();
    await page.waitForTimeout(600);
    await capture(page, 'sso-provider-saml', { height: await fitHeight(page, 1900) });
  },
  async 'sso-test'() {
    const page = await pageAs(SECURITY);
    await open(page, '/access?tab=sso');
    await page.getByTestId('sso-view-Acme SSO').click();
    await page.waitForTimeout(600);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('sso-view-test').click()]);
    await popup.waitForLoadState('domcontentloaded');
    await popup.locator('#username').fill(IDP_USER.username);
    await popup.locator('#password').fill(IDP_USER.password);
    await popup.locator('#kc-login').click();
    await page.getByTestId('sso-test-outcome').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    await capture(page, 'sso-test');
    await page.keyboard.press('Escape');
  },
};

let failed = 0;
for (const [name, run] of Object.entries(shots)) {
  if (filters.length && !filters.some((f) => name.includes(f))) continue;
  try {
    await run();
    console.log(`ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message.split('\n')[0]}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
