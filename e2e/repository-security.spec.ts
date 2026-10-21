import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, loadUser, signInAsAdmin } from './support';

/**
 * Repository security (requirements_repository_security.md): R2 the order of `all`, R3/R4 the
 * order warning, R5 a policy on a remote covers it through `all`, R6 a namespace bound to a remote.
 *
 * The docker gateway has no private registry, so `qa-e2e-internal` is a second remote on the
 * public npm registry, marked Internal through the API.
 */
const INTERNAL = 'qa-e2e-internal';
const POLICY = 'qa-e2e-security';
/** A second public remote, for a namespace bound to a chosen remote rather than to the internal ones. */
const BOUND = 'qa-e2e-bound';

async function ensureInternalRemote(request: APIRequestContext, key = INTERNAL, source = 'internal'): Promise<string> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  const existing = ((await list.json()) as Array<{ id: string; key: string }>).find((row) => row.key === key);
  if (existing) return existing.id;
  const created = await request.post(`${API_BASE}/api/admin/repositories`, {
    headers,
    data: { ecosystem: 'npm', key, type: 'remote', upstreamUrl: 'https://registry.npmjs.org', source },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** The order of npm `all` before the suite, without QA remotes. */
let originalOrder: string[] | null = null;

/** `all` back to the order it had before the suite, with any QA remote last (as before the test). */
async function restoreAllOrder(request: APIRequestContext): Promise<void> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  const rows = (await list.json()) as Array<{ id: string; key: string; memberKeys: string[] }>;
  const all = rows.find((row) => row.key === 'all');
  if (!all) return;
  originalOrder ??= all.memberKeys.filter((key) => !key.startsWith('qa-e2e-'));
  const kept = originalOrder.filter((key) => all.memberKeys.includes(key));
  const memberKeys = [...kept, ...all.memberKeys.filter((key) => !kept.includes(key))];
  await request.put(`${API_BASE}/api/admin/repositories/${all.id}`, { headers, data: { memberKeys } });
}

async function npmAllOrder(request: APIRequestContext): Promise<string[]> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  return ((await list.json()) as Array<{ key: string; memberKeys: string[] }>).find((row) => row.key === 'all')?.memberKeys ?? [];
}

async function putDefaultFirst(request: APIRequestContext): Promise<void> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  const all = ((await list.json()) as Array<{ id: string; key: string; memberKeys: string[] }>).find((row) => row.key === 'all');
  if (!all) return;
  const memberKeys = ['default', ...all.memberKeys.filter((key) => key !== 'default')];
  await request.put(`${API_BASE}/api/admin/repositories/${all.id}`, { headers, data: { memberKeys } });
}

async function openAll(page: Page) {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Repositories' }).click();
  await page.locator('.dg-subnav').getByRole('button', { name: /npm$/ }).click();
  // The key cell comes first; the `all` row's member list also names other repositories.
  return page.getByRole('row', { name: /^all virtual/ });
}

async function registryToken(request: APIRequestContext): Promise<string> {
  const user = loadUser();
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
  const body = (await login.json()) as { token: string; registryToken?: string };
  return body.registryToken ?? body.token;
}

async function statusOf(request: APIRequestContext, token: string, path: string, want: number) {
  let res = await request.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 });
  for (let i = 0; i < 10 && res.status() !== want; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res = await request.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 });
  }
  return res.status();
}

test.describe('Repository security', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupQa(request);
    await restoreAllOrder(request);
  });

  test.afterEach(async ({ request }) => {
    await restoreAllOrder(request);
    await cleanupQa(request);
  });

  test('Security orders all, the public-before-internal warning goes away, and Package check shows the order', async ({ page, request }) => {
    await ensureInternalRemote(request);
    await signInAsAdmin(page);
    const allRow = await openAll(page);
    await expect(allRow.getByTestId('repo-order-warning-all')).toBeVisible();
    await allRow.getByRole('button', { name: 'Edit', exact: true }).click();

    const order = page.getByTestId('repo-order');
    await expect(order).toContainText('default');
    await expect(page.getByTestId('repo-order-warning')).toContainText(
      `Public registry default is searched before internal ${INTERNAL}`
    );
    // To the top, whatever other remotes the gateway has.
    const steps = (await npmAllOrder(request)).indexOf(INTERNAL);
    for (let i = 0; i < steps; i += 1) await page.getByRole('button', { name: `Move ${INTERNAL} up` }).click();
    await expect(page.getByRole('button', { name: `Move ${INTERNAL} up` })).toBeDisabled();
    await expect(page.getByTestId('repo-order-warning')).toHaveCount(0);
    await page.getByTestId('repo-save').click();
    await expect(page.getByText('Repository updated').first()).toBeVisible();
    await page.getByTestId('repo-cancel').click();
    await expect(allRow).toContainText(`Every enabled remote: ${INTERNAL} → `);
    await expect(allRow.getByTestId('repo-order-warning-all')).toHaveCount(0);

    await page.goto('/package-check?ecosystem=npm&package=lodash&version=4.17.21&repository=all');
    await expect(page.getByTestId('pc-search-order')).toContainText(`Searched in order: npm/${INTERNAL} → `, { timeout: 60_000 });
    await expect(page.getByTestId('pc-served-by')).toHaveText(`Served by npm/${INTERNAL}`);
  });

  test('a policy on the default remote blocks the same package through all (R5)', async ({ page, request }) => {
    test.setTimeout(3 * 60_000);
    // `default` must serve lodash through all; afterEach restores the gateway's order.
    await putDefaultFirst(request);
    await signInAsAdmin(page);
    await page.goto('/policies');
    await page.getByRole('button', { name: 'New policy' }).first().click();
    await page.locator('#policy-name').fill(POLICY);
    await page.locator('#policy-priority').fill('-100000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-scope-selected').check();
    await expect(page.getByTestId('policy-scope-repo-npm-all')).toHaveCount(0);
    await page.getByTestId('policy-scope-repo-npm-default').check();
    await page.getByTestId('policy-rule-packages').click();
    await page.locator('#policy-packages').fill('lodash');
    await page.getByTestId('add-exact-version').click();
    await page.getByRole('textbox', { name: 'Version', exact: true }).fill('4.17.20');
    await expect(page.getByTestId('policy-summary')).toContainText('Versions 4.17.20 of:');
    await expect(page.getByTestId('policy-review-scope')).toContainText('npm/default');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    await page.goto('/package-check?ecosystem=npm&package=lodash&version=4.17.20&repository=all');
    const row = page.locator('table.pc-table tbody tr', { hasText: '4.17.20' }).first();
    await expect(row).toContainText('Blocked', { timeout: 60_000 });
    await expect(row.getByTestId('policy-scope')).toHaveText('Scoped to npm/default');

    const token = await registryToken(request);
    expect(await statusOf(request, token, '/npm/all/lodash/-/lodash-4.17.20.tgz', 403)).toBe(403);
    expect(await statusOf(request, token, '/npm/default/lodash/-/lodash-4.17.20.tgz', 403)).toBe(403);
  });

  test('a namespace bound to one remote is served only from it (R6)', async ({ page, request }) => {
    test.setTimeout(3 * 60_000);
    await ensureInternalRemote(request);
    await ensureInternalRemote(request, BOUND, 'public');
    await signInAsAdmin(page);
    await page.goto('/policies');
    await page.getByRole('button', { name: 'New policy' }).first().click();
    await page.locator('#policy-name').fill(POLICY);
    await page.locator('#policy-priority').fill('-100000');
    await page.getByTestId('policy-rule-namespace').click();
    await page.locator('#policy-ecosystem').selectOption('npm');
    const input = page.getByTestId('ns-reserved-input');
    await input.fill('is-number');
    await input.press('Enter');
    // The internal remote is ticked by default; nothing ticked cannot be saved.
    await expect(page.getByTestId(`ns-allowed-${INTERNAL}`)).toBeChecked();
    // Untick every internal remote (the gateway may have others besides the test's).
    const ticked = page.getByTestId('ns-remotes').locator('input[type=checkbox]:checked');
    while ((await ticked.count()) > 0) await ticked.first().uncheck();
    await expect(page.getByTestId('ns-no-internal')).toContainText('Select at least one remote');
    await expect(page.getByTestId('policy-save')).toBeDisabled();
    await page.getByTestId(`ns-allowed-${BOUND}`).check();
    await expect(page.getByTestId('ns-default-help')).toHaveCount(0);
    await page.getByTestId('policy-mode-enforce').locator('input').check();
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['is-number']);
    await expect(page.getByTestId('policy-summary')).toContainText(`Served only from: ${BOUND}`);
    await expect(page.getByTestId('policy-summary')).toContainText('Other remotes: blocked');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(POLICY) });
    await row.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByTestId('view-served-from')).toContainText('Only the remote the policy allows');
    await page.locator('.modal-content').getByRole('button', { name: 'Close' }).first().click();

    const token = await registryToken(request);
    expect(await statusOf(request, token, '/npm/default/is-number', 403)).toBe(403);
    expect(await statusOf(request, token, '/npm/all/is-number', 200)).toBe(200);
  });
});
