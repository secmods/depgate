/**
 * Single sign-on through a real OIDC provider: Keycloak from docker-compose (profile `sso`).
 *
 *   npm run test:e2e                       starts DepGate and Keycloak (e2e/stack.mjs), runs everything
 *   npx playwright test e2e/sso.spec.ts    this suite alone, with the same start-up
 *
 * Skipped when Keycloak is not reachable, which only happens against your own stack (E2E_BASE_URL):
 * docker compose --profile sso up -d keycloak. Users and passwords: e2e/keycloak/depgate-realm.json.
 * The suite adds acme.test to the allowed domains and puts the settings back afterwards.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, PREFIX, adminToken, authHeaders, confirm, signInAsAdmin, signOut } from './support';

const ISSUER = process.env.E2E_OIDC_ISSUER ?? 'http://keycloak.localhost:8180/realms/depgate';
/** The test runner is not a browser: it reaches Keycloak on its published port. */
const ISSUER_FROM_RUNNER = process.env.E2E_OIDC_ISSUER_RUNNER ?? 'http://localhost:8180/realms/depgate';
const CLIENT_ID = 'depgate';
const CLIENT_SECRET = 'depgate-dev-secret';
const PASSWORD = 'Passw0rd!';
const DOMAIN = 'acme.test';
const PROVIDER_NAME = `${PREFIX}sso Keycloak`;
const BUTTON = 'Sign in with Keycloak (e2e)';

const SECURITY = `${PREFIX}sso-sec@${DOMAIN}`;
const UNLISTED = `${PREFIX}sso-new@${DOMAIN}`;
const UNVERIFIED = `${PREFIX}sso-unverified@${DOMAIN}`;
const GMAIL = `${PREFIX}sso-gmail@gmail.com`;

interface Settings { allowedDomains: string[]; allowUnlistedSso: boolean }
interface UserRow { id: string; email: string; source: string; status: string; role: string }

let original: Settings | null = null;
let available = false;
let unavailableReason = 'Keycloak is not running: docker compose --profile sso up -d keycloak';

/** Keycloak answers the runner on its published port, and DepGate (in Docker) under the issuer name. */
async function keycloakUp(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await fetch(`${ISSUER_FROM_RUNNER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const headers = authHeaders(await adminToken(request));
  const discovered = await request.post(`${API_BASE}/api/admin/sso-providers/discover`, { headers, data: { issuer: ISSUER } });
  if (discovered.ok()) return true;
  unavailableReason = `DepGate cannot reach Keycloak at ${ISSUER} (${discovered.status()}): start it on the DepGate compose network with docker compose --profile sso up -d keycloak`;
  return false;
}

async function users(request: APIRequestContext, token: string): Promise<UserRow[]> {
  const res = await request.get(`${API_BASE}/api/admin/users?limit=200&search=${PREFIX}sso-`, { headers: authHeaders(token) });
  return ((await res.json()) as { items: UserRow[] }).items;
}

async function removeSsoFixtures(request: APIRequestContext, token: string): Promise<void> {
  const headers = authHeaders(token);
  for (const user of await users(request, token)) {
    if (user.email.startsWith(`${PREFIX}sso-`)) await request.delete(`${API_BASE}/api/admin/users/${user.id}`, { headers });
  }
  const providers = (await (await request.get(`${API_BASE}/api/admin/sso-providers`, { headers })).json()) as Array<{ id: string; name: string }>;
  for (const provider of providers) {
    if (provider.name.startsWith(`${PREFIX}sso`)) await request.delete(`${API_BASE}/api/admin/sso-providers/${provider.id}`, { headers });
  }
}

/** On the Keycloak login page: type the credentials and submit. */
async function keycloakLogin(page: Page, username: string): Promise<void> {
  await expect(page).toHaveURL(/keycloak\.localhost:8180\/realms\/depgate\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
}

async function ssoSignIn(page: Page, username: string, from = '/login'): Promise<void> {
  await page.goto(from);
  await page.getByRole('button', { name: BUTTON }).click();
  await keycloakLogin(page, username);
}

test.describe.serial('Single sign-on (OIDC, Keycloak)', () => {
  test.beforeAll(async ({ request }) => {
    available = await keycloakUp(request);
    if (!available) return;
    const token = await adminToken(request);
    const headers = authHeaders(token);
    await removeSsoFixtures(request, token);
    original = (await (await request.get(`${API_BASE}/api/admin/signin-settings`, { headers })).json()) as Settings;
    const domains = original.allowedDomains.includes(DOMAIN) ? original.allowedDomains : [...original.allowedDomains, DOMAIN];
    await request.put(`${API_BASE}/api/admin/signin-settings`, { headers, data: { allowedDomains: domains, allowUnlistedSso: true } });
    const added = await request.post(`${API_BASE}/api/admin/users`, { headers, data: { email: SECURITY, role: 'Security', sendInvite: false } });
    expect(added.status()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    if (!available) return;
    const token = await adminToken(request);
    await removeSsoFixtures(request, token);
    if (original) {
      const headers = authHeaders(token);
      await request.put(`${API_BASE}/api/admin/signin-settings`, { headers, data: original });
    }
  });

  test.beforeEach(() => {
    test.skip(!available, unavailableReason);
  });

  test('an admin adds an OIDC provider in Settings and it appears on the login page', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/access?tab=sso');
    await expect(page.getByRole('heading', { name: 'Identity providers' })).toBeVisible();
    await page.getByTestId('sso-add').click();
    await expect(page).toHaveURL(/\/access\/sso\/new$/);
    await expect(page.getByRole('heading', { name: 'Add identity provider' })).toBeVisible();

    const form = page.locator('section[aria-label="Identity provider"]');
    const summary = page.getByTestId('sso-summary');
    // ngModel writes the initial values a tick after the page renders; typing earlier can be overwritten.
    await expect(form.getByLabel('Scopes')).toHaveValue('openid email profile');
    // The redirect URI is there before anything is typed, to register at the provider first.
    const redirectUri = summary.getByTestId('sso-redirect-uri');
    await expect(redirectUri).toHaveText(/\/api\/auth\/sso\/[0-9a-f-]{36}\/callback$/);
    const registered = await redirectUri.textContent();
    await expect(summary.getByTestId('sso-save-blocker')).toContainText('Enter a name');

    await form.getByLabel('Name').fill(PROVIDER_NAME);
    await form.getByLabel('Button label').fill(BUTTON);
    // Typed with a trailing slash the provider does not publish: Discover corrects it.
    await form.getByLabel('Issuer URL').fill(`${ISSUER}/`);
    await expect(form.getByTestId('sso-discovery-link')).toHaveAttribute('href', `${ISSUER}/.well-known/openid-configuration`);
    await form.getByTestId('sso-discover').click();
    await expect(form.getByTestId('sso-discovered')).toContainText('RS256');
    await expect(form.getByLabel('Issuer URL')).toHaveValue(ISSUER);
    await expect(form.getByTestId('sso-issuer-note')).toContainText('exactly as the provider publishes it');
    await form.getByLabel('Client ID').fill(CLIENT_ID);
    await form.getByLabel('Client secret').fill(CLIENT_SECRET);
    await summary.getByTestId('sso-enabled').click();
    await expect(summary.getByTestId('sso-summary-facts')).toContainText(PROVIDER_NAME);
    await expect(summary.getByTestId('sso-summary-facts')).toContainText(ISSUER);
    await expect(summary.getByTestId('sso-summary-secret')).toHaveText('Saved when you create');
    await summary.getByTestId('sso-save').click();

    // Saved under the same id, so the URI registered before saving still works; the page becomes the edit page.
    await expect(page).toHaveURL(/\/access\/sso\/[0-9a-f-]{36}\/edit$/);
    await expect(page.getByRole('heading', { name: 'Edit identity provider' })).toBeVisible();
    await expect(page.getByTestId('sso-redirect-uri')).toHaveText(registered!);
    await expect(page.getByTestId('sso-page-test')).toBeVisible();
    await expect(page.getByTestId('sso-validation-error')).toHaveCount(0);
    await page.getByTestId('sso-back').click();
    await expect(page).toHaveURL(/\/access\?tab=sso$/);
    await expect(page.getByTestId(`sso-row-${PROVIDER_NAME}`)).toBeVisible();
    await expect(page.getByTestId(`sso-row-${PROVIDER_NAME}`).getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    await signOut(page);
    await expect(page.getByRole('button', { name: BUTTON })).toBeVisible();
  });

  test('a listed Security user signs in through the provider and gets Security', async ({ page }) => {
    await ssoSignIn(page, `${PREFIX}sso-sec`);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toBeVisible();
    // The one-time code is not left in the address bar or history.
    expect(page.url()).not.toContain('code=');
    await signOut(page);
  });

  test('a deep link survives single sign-on', async ({ page }) => {
    await page.goto('/policies');
    await expect(page).toHaveURL(/\/login\?returnUrl=/);
    await page.getByRole('button', { name: BUTTON }).click();
    await keycloakLogin(page, `${PREFIX}sso-sec`);
    await expect(page).toHaveURL(/\/policies$/);
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  });

  test('an unlisted person in an allowed domain is added as User', async ({ page, request }) => {
    await ssoSignIn(page, `${PREFIX}sso-new`);
    await expect(page).toHaveURL(/\/registry/);
    await expect(page.getByRole('heading', { name: 'Registry' })).toBeVisible();

    const row = (await users(request, await adminToken(request))).find((user) => user.email === UNLISTED);
    expect(row).toMatchObject({ role: 'User', source: 'sso', status: 'active' });
  });

  test('a Gmail account is refused even though the provider vouches for it', async ({ page, request }) => {
    await ssoSignIn(page, `${PREFIX}sso-gmail`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('sso-error')).toContainText("Your account's domain is not allowed to sign in");
    expect((await users(request, await adminToken(request))).some((user) => user.email === GMAIL)).toBe(false);
  });

  test('an unverified email is refused', async ({ page, request }) => {
    await ssoSignIn(page, `${PREFIX}sso-unverified`);
    await expect(page.getByTestId('sso-error')).toContainText('has not verified your email');
    expect((await users(request, await adminToken(request))).some((user) => user.email === UNVERIFIED)).toBe(false);
  });

  test('Test shows what the provider sent, without signing anyone in', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/access?tab=sso');
    await page.getByTestId(`sso-view-${PROVIDER_NAME}`).click();
    const view = page.getByRole('dialog');
    await expect(view.getByTestId('sso-view-facts')).toContainText(ISSUER);
    await expect(view.getByTestId('sso-redirect-uri')).toHaveText(/\/callback$/);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      view.getByTestId('sso-view-test').click(),
    ]);
    await keycloakLogin(popup, `${PREFIX}sso-sec`);
    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByTestId('sso-test-outcome')).toContainText(`Would sign in as ${SECURITY} with role Security`, { timeout: 30_000 });
    await expect(dialog.getByTestId('sso-test-checks')).toContainText('Allowed sign-in domain');
    await expect(dialog.getByTestId('sso-test-claims')).toContainText('"email_verified": true');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await view.locator('.modal-footer').getByRole('button', { name: 'Close' }).click();
  });

  test('an admin disables a user, who can then not sign in by any method', async ({ page, browser }) => {
    await signInAsAdmin(page);
    await page.goto('/access?tab=users');
    await page.getByTestId(`user-actions-${UNLISTED}`).click();
    await page.getByRole('menuitem', { name: 'Disable' }).or(page.getByRole('button', { name: 'Disable', exact: true })).first().click();
    await confirm(page);
    await expect(page.getByTestId(`user-row-${UNLISTED}`)).toContainText('Disabled');

    const other = await browser.newContext();
    const visitor = await other.newPage();
    await ssoSignIn(visitor, `${PREFIX}sso-new`);
    await expect(visitor.getByTestId('sso-error')).toContainText('Your DepGate account is disabled');
    await other.close();

    await page.getByTestId(`user-actions-${UNLISTED}`).click();
    await page.getByRole('menuitem', { name: 'Enable' }).or(page.getByRole('button', { name: 'Enable', exact: true })).first().click();
    await expect(page.getByTestId(`user-row-${UNLISTED}`)).toContainText('Active');
  });

  test('the Audit Log shows how people signed in', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/audit/log');
    await page.getByTestId('audit-feature-filter').selectOption('signin');
    await page.getByTestId('audit-action-filter').selectOption('SIGNIN_SUCCEEDED');
    await page.getByLabel('Actor or IP').fill(SECURITY);
    await page.getByLabel('Actor or IP').press('Enter');
    const row = page.getByRole('row', { name: new RegExp(SECURITY) }).first();
    await expect(row).toContainText(`${SECURITY} signed in with ${PROVIDER_NAME} (OIDC)`);
    await expect(row).not.toContainText('with a password');
  });
});
