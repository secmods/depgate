/**
 * Single sign-on through a real SAML 2.0 IdP: Keycloak from docker-compose (profile `sso`).
 *
 *   npm run test:e2e                            starts DepGate and Keycloak (e2e/stack.mjs), runs everything
 *   npx playwright test e2e/sso-saml.spec.ts    this suite alone, with the same start-up
 *
 * Skipped when Keycloak is not reachable, which only happens against your own stack (E2E_BASE_URL):
 * docker compose --profile sso up -d keycloak. The admin adds the provider in the UI from Keycloak's metadata URL;
 * the suite then registers the SP entity ID and ACS URL the page shows as a SAML client in Keycloak,
 * as an admin would. Users and passwords: e2e/keycloak/depgate-realm.json. The suite adds acme.test to the
 * allowed domains and puts the settings back afterwards.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, PREFIX, adminToken, authHeaders, signInAsAdmin, signOut } from './support';
import { registerSamlClient, removeSamlClients } from './keycloak/saml-client';

/** The browser and DepGate (in Docker) both reach Keycloak under this name. */
const METADATA_URL = process.env.E2E_SAML_METADATA_URL ?? 'http://keycloak.localhost:8180/realms/depgate/protocol/saml/descriptor';
const METADATA_FROM_RUNNER = process.env.E2E_SAML_METADATA_RUNNER ?? 'http://localhost:8180/realms/depgate/protocol/saml/descriptor';
const IDP_ENTITY_ID = 'http://keycloak.localhost:8180/realms/depgate';
const PASSWORD = 'Passw0rd!';
const DOMAIN = 'acme.test';
const PROVIDER_NAME = `${PREFIX}saml Keycloak`;
const BUTTON = 'Sign in with Keycloak SAML (e2e)';

const SECURITY = `${PREFIX}sso-sec@${DOMAIN}`;
const UNLISTED = `${PREFIX}sso-new@${DOMAIN}`;
const GMAIL = `${PREFIX}sso-gmail@gmail.com`;

interface Settings { allowedDomains: string[]; allowUnlistedSso: boolean }
interface UserRow { id: string; email: string; source: string; status: string; role: string }

let original: Settings | null = null;
let available = false;
let unavailableReason = 'Keycloak is not running: docker compose --profile sso up -d keycloak';
let spEntityId = '';

/** Keycloak answers the runner on its published port, and DepGate (in Docker) under the metadata URL's name. */
async function keycloakUp(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await fetch(METADATA_FROM_RUNNER, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const headers = authHeaders(await adminToken(request));
  const metadata = await request.post(`${API_BASE}/api/admin/sso-providers/saml-metadata`, { headers, data: { url: METADATA_URL } });
  if (metadata.ok()) return true;
  unavailableReason = `DepGate cannot reach Keycloak at ${METADATA_URL} (${metadata.status()}): start it on the DepGate compose network with docker compose --profile sso up -d keycloak`;
  return false;
}

async function users(request: APIRequestContext, token: string): Promise<UserRow[]> {
  const res = await request.get(`${API_BASE}/api/admin/users?limit=200&search=${PREFIX}sso-`, { headers: authHeaders(token) });
  return ((await res.json()) as { items: UserRow[] }).items;
}

async function removeFixtures(request: APIRequestContext, token: string): Promise<void> {
  const headers = authHeaders(token);
  for (const user of await users(request, token)) {
    if (user.email.startsWith(`${PREFIX}sso-`)) await request.delete(`${API_BASE}/api/admin/users/${user.id}`, { headers });
  }
  const providers = (await (await request.get(`${API_BASE}/api/admin/sso-providers`, { headers })).json()) as Array<{ id: string; name: string }>;
  for (const provider of providers) {
    if (provider.name.startsWith(`${PREFIX}saml`)) await request.delete(`${API_BASE}/api/admin/sso-providers/${provider.id}`, { headers });
  }
  await removeSamlClients();
}

/** On the Keycloak login page reached through a SAML AuthnRequest: type the credentials and submit. */
async function keycloakLogin(page: Page, username: string): Promise<void> {
  await expect(page).toHaveURL(/keycloak\.localhost:8180\/realms\/depgate\/(protocol\/saml|login-actions)/);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
}

async function samlSignIn(page: Page, username: string, from = '/login'): Promise<void> {
  await page.goto(from);
  await page.getByRole('button', { name: BUTTON }).click();
  await keycloakLogin(page, username);
}

test.describe.serial('Single sign-on (SAML, Keycloak)', () => {
  test.beforeAll(async ({ request }) => {
    available = await keycloakUp(request);
    if (!available) return;
    const token = await adminToken(request);
    const headers = authHeaders(token);
    await removeFixtures(request, token);
    original = (await (await request.get(`${API_BASE}/api/admin/signin-settings`, { headers })).json()) as Settings;
    const domains = original.allowedDomains.includes(DOMAIN) ? original.allowedDomains : [...original.allowedDomains, DOMAIN];
    await request.put(`${API_BASE}/api/admin/signin-settings`, { headers, data: { allowedDomains: domains, allowUnlistedSso: true } });
    const added = await request.post(`${API_BASE}/api/admin/users`, { headers, data: { email: SECURITY, role: 'Security', sendInvite: false } });
    expect(added.status()).toBe(201);
  });

  test.afterAll(async ({ request }) => {
    if (!available) return;
    const token = await adminToken(request);
    await removeFixtures(request, token);
    if (original) await request.put(`${API_BASE}/api/admin/signin-settings`, { headers: authHeaders(token), data: original });
  });

  test.beforeEach(() => {
    test.skip(!available, unavailableReason);
  });

  test('an admin adds a SAML provider from its metadata URL and it appears on the login page', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/access?tab=sso');
    await page.getByTestId('sso-add').click();
    await expect(page).toHaveURL(/\/access\/sso\/new$/);

    const form = page.locator('section[aria-label="Identity provider"]');
    const summary = page.getByTestId('sso-summary');
    await expect(form.getByText('SAML 2.0')).toBeVisible();
    await expect(form.getByText('coming later')).toHaveCount(0);
    await form.getByTestId('sso-type-saml').check();

    // What to register at the IdP is there before anything is typed.
    const entity = summary.getByTestId('sso-sp-entity-id');
    await expect(entity).toHaveText(/\/api\/auth\/saml\/[0-9a-f-]{36}\/metadata$/);
    spEntityId = (await entity.textContent())!;
    const acsUrl = (await summary.getByTestId('sso-acs-url').textContent())!;
    expect(acsUrl).toBe(spEntityId.replace(/\/metadata$/, '/acs'));
    await registerSamlClient(spEntityId, acsUrl);

    await form.getByLabel('Name', { exact: true }).fill(PROVIDER_NAME);
    await form.getByLabel('Button label').fill(BUTTON);
    await form.getByLabel('IdP metadata URL').fill(METADATA_URL);
    await form.getByTestId('saml-read-metadata').click();
    await expect(form.getByLabel('IdP entity ID')).toHaveValue(IDP_ENTITY_ID);
    await expect(form.getByLabel('IdP SSO URL')).toHaveValue(`${IDP_ENTITY_ID}/protocol/saml`);
    await expect(form.getByTestId('saml-idp-certs')).toContainText('CN=depgate');
    await expect(form.getByTestId('saml-idp-certs')).toContainText('SHA-256');
    // Keycloak's realm metadata asks for signed requests; this client does not need them.
    await expect(form.getByTestId('saml-metadata-note')).toContainText('wants signed requests');
    await expect(summary.getByTestId('sso-save-blocker')).toContainText('SP certificate');
    await form.getByTestId('saml-sign-requests').uncheck();
    await expect(summary.getByTestId('sso-save-blocker')).toHaveCount(0);

    await summary.getByTestId('sso-enabled').click();
    await expect(summary.getByTestId('sso-summary-facts')).toContainText(IDP_ENTITY_ID);
    await expect(summary.getByTestId('sso-summary-security')).toContainText('Signed assertions required');
    await summary.getByTestId('sso-save').click();

    await expect(page).toHaveURL(/\/access\/sso\/[0-9a-f-]{36}\/edit$/);
    await expect(page.getByTestId('sso-validation-error')).toHaveCount(0);
    await expect(page.getByTestId('sso-sp-entity-id')).toHaveText(spEntityId);
    await expect(page.getByTestId('sso-sp-metadata')).toHaveAttribute('href', spEntityId);
    await expect(page.getByTestId('sso-type-oidc')).toBeDisabled();
    await page.getByTestId('sso-back').click();
    const row = page.getByTestId(`sso-row-${PROVIDER_NAME}`);
    await expect(row).toContainText('SAML');
    await expect(row).toContainText(IDP_ENTITY_ID);
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    await signOut(page);
    await expect(page.getByRole('button', { name: BUTTON })).toBeVisible();
  });

  test('DepGate serves its SP metadata at the entity ID', async ({ request }) => {
    const res = await request.get(spEntityId);
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`entityID="${spEntityId}"`);
    expect(xml).toContain('urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST');
  });

  test('a listed Security user signs in through SAML and gets Security', async ({ page }) => {
    await samlSignIn(page, `${PREFIX}sso-sec`);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toBeVisible();
    expect(page.url()).not.toContain('code=');
    expect(page.url()).not.toContain('SAMLResponse');
    await signOut(page);
  });

  test('a deep link survives SAML sign-in', async ({ page }) => {
    await page.goto('/policies');
    await expect(page).toHaveURL(/\/login\?returnUrl=/);
    await page.getByRole('button', { name: BUTTON }).click();
    await keycloakLogin(page, `${PREFIX}sso-sec`);
    await expect(page).toHaveURL(/\/policies$/);
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  });

  test('an unlisted person in an allowed domain is added as User', async ({ page, request }) => {
    await samlSignIn(page, `${PREFIX}sso-new`);
    await expect(page).toHaveURL(/\/registry/);
    const row = (await users(request, await adminToken(request))).find((user) => user.email === UNLISTED);
    expect(row).toMatchObject({ role: 'User', source: 'sso', status: 'active' });
  });

  test('a Gmail address is refused even though the IdP vouches for it', async ({ page, request }) => {
    await samlSignIn(page, `${PREFIX}sso-gmail`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('sso-error')).toContainText("Your account's domain is not allowed to sign in");
    expect((await users(request, await adminToken(request))).some((user) => user.email === GMAIL)).toBe(false);
  });

  test('Test shows the NameID and attributes Keycloak sent, without signing anyone in', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/access?tab=sso');
    await page.getByTestId(`sso-view-${PROVIDER_NAME}`).click();
    const view = page.getByRole('dialog');
    await expect(view.getByTestId('sso-view-facts')).toContainText(IDP_ENTITY_ID);
    await expect(view.getByTestId('sso-view-facts')).toContainText('CN=depgate');
    await expect(view.getByTestId('sso-acs-url')).toHaveText(/\/acs$/);
    const [popup] = await Promise.all([page.waitForEvent('popup'), view.getByTestId('sso-view-test').click()]);
    await keycloakLogin(popup, `${PREFIX}sso-sec`);
    const dialog = page.getByRole('dialog').last();
    await expect(dialog.getByTestId('sso-test-outcome')).toContainText(`Would sign in as ${SECURITY} with role Security`, { timeout: 30_000 });
    await expect(dialog.getByTestId('sso-test-checks')).toContainText('Email (NameID)');
    await expect(dialog.getByText('Attributes received')).toBeVisible();
    await expect(dialog.getByTestId('sso-test-claims')).toContainText(`"NameID": "${SECURITY}"`);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await view.locator('.modal-footer').getByRole('button', { name: 'Close' }).click();
  });

  test('the Audit Log shows SAML sign-ins', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/audit/log');
    await page.getByTestId('audit-feature-filter').selectOption('signin');
    await page.getByTestId('audit-action-filter').selectOption('SIGNIN_SUCCEEDED');
    await page.getByLabel('Actor or IP').fill(SECURITY);
    await page.getByLabel('Actor or IP').press('Enter');
    const row = page.getByRole('row', { name: new RegExp(SECURITY) }).first();
    await expect(row).toContainText(`${SECURITY} signed in with ${PROVIDER_NAME} (SAML)`);
  });
});
