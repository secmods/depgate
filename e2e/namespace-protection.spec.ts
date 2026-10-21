import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, loadUser, signInAsAdmin } from './support';

/**
 * Internal namespace rule (requirements_namespace_protection.md §11 E2E): Security marks a remote
 * internal, creates the policy, uses Try a name, and runs Package check on a reserved name.
 *
 * The docker gateway has no private registry, so `qa-e2e-internal` is a second remote on the public
 * npm registry marked Internal (the form warns about exactly that). The reserved names are
 * `@qa-e2e-acme` (exists nowhere) and the exact name `is-number` (exists on both remotes).
 */
const INTERNAL = 'qa-e2e-internal';

async function putFirstInAll(request: APIRequestContext, key: string): Promise<void> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  const all = ((await list.json()) as Array<{ id: string; key: string; memberKeys: string[] }>).find((row) => row.key === 'all');
  if (!all) return;
  const memberKeys = [key, ...all.memberKeys.filter((member) => member !== key)];
  expect((await request.put(`${API_BASE}/api/admin/repositories/${all.id}`, { headers, data: { memberKeys } })).status()).toBe(200);
}
const POLICY = 'qa-e2e-namespace-npm';
const SCOPE = '@qa-e2e-acme';
const RESERVED = 'is-number';

async function repositoryRow(page: Page, key: string) {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Repositories' }).click();
  await page.locator('.dg-subnav').getByRole('button', { name: /npm$/ }).click();
  // Anchored: the `all` row lists its members, this repository among them.
  return page.getByRole('row', { name: new RegExp(`^${key} `) });
}

async function addInternalRemote(page: Page): Promise<void> {
  await page.goto('/settings');
  await page.getByRole('tab', { name: 'Repositories' }).click();
  await page.locator('.dg-subnav').getByRole('button', { name: /npm$/ }).click();
  await page.getByRole('button', { name: /Add repository/ }).click();
  await page.locator('#repo-key').fill(INTERNAL);
  await page.locator('#repo-description').fill('qa-e2e internal registry');
  await page.locator('#repo-upstream').fill('https://registry.npmjs.org');
  await page.locator('#repo-source-internal').check();
  await expect(page.getByTestId('repo-source-public-warning')).toContainText('This looks like a public registry');
  await page.getByTestId('repo-save').click();
  await expect(page.getByText('Repository added').first()).toBeVisible();
  await page.getByTestId('repo-cancel').click();
}

async function registryToken(request: APIRequestContext): Promise<string> {
  const user = loadUser();
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: { email: user.email, password: user.password } });
  const body = (await login.json()) as { token: string; registryToken?: string };
  return body.registryToken ?? body.token;
}

/** Status of a request, retried past the 5 s policy cache. */
async function statusOf(request: APIRequestContext, token: string, path: string, want: number) {
  let res = await request.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 });
  for (let i = 0; i < 10 && res.status() !== want; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    res = await request.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, maxRedirects: 0 });
  }
  return res;
}

test.describe('Namespace protection rule', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('Security marks a remote internal; the list shows the source and the default remote stays public', async ({ page }) => {
    await signInAsAdmin(page);
    await addInternalRemote(page);
    const row = await repositoryRow(page, INTERNAL);
    await expect(row.getByTestId(`repo-source-${INTERNAL}`)).toContainText('Internal');
    await expect(page.getByTestId('repo-source-default')).toContainText('Public (fixed)');

    await page.getByRole('row', { name: /default/ }).first().getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByTestId('repo-source-fixed')).toHaveText('Public (fixed)');
    await page.getByTestId('repo-cancel').click();
  });

  test('Security creates the policy, tries names, and Package check shows the namespace', async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    await signInAsAdmin(page);
    await addInternalRemote(page);
    // The test's remote must serve the reserved names through all, ahead of any internal remote the
    // gateway already has; deleting it at cleanup puts `all` back as it was.
    await putFirstInAll(request, INTERNAL);

    await page.goto('/policies');
    await page.getByRole('button', { name: 'New policy' }).first().click();
    await page.locator('#policy-name').fill(POLICY);
    await page.locator('#policy-priority').fill('-100000');
    await page.getByTestId('policy-rule-namespace').click();
    await expect(page.getByTestId('ns-ecosystem-required')).toBeVisible();
    // Only Packages offers Allow, so there is no action to choose.
    await expect(page.getByTestId('policy-decision')).toHaveCount(0);
    await page.locator('#policy-ecosystem').selectOption('npm');

    const input = page.getByTestId('ns-reserved-input');
    await input.fill('@qa-e2e-acme-*');
    await expect(page.getByTestId('ns-draft-error')).toContainText('scope is reserved whole');
    await input.fill(`${SCOPE},${RESERVED}`);
    await input.press('Enter');
    await expect(page.getByTestId(`ns-reserved-tag-${SCOPE}`)).toBeVisible();
    await expect(page.getByTestId(`ns-reserved-tag-${RESERVED}`)).toBeVisible();
    // The optional parts stay folded until asked for.
    await expect(page.locator('#ns-public-input')).toHaveCount(0);
    await page.getByTestId('ns-public-toggle').click();
    await page.locator('#ns-public-input').fill(`${SCOPE}/eslint-config`);
    await page.locator('#ns-public-input').press('Enter');

    await expect(page.getByTestId(`ns-allowed-${INTERNAL}`)).toBeChecked();
    await expect(page.getByTestId('ns-allowed-default')).not.toBeChecked();
    await expect(page.getByTestId('ns-default-help')).toContainText('every internal remote');
    await expect(page.getByTestId('ns-no-internal')).toHaveCount(0);

    // Test a name: the candidate policy, before it is saved.
    await page.getByTestId('ns-try-toggle').click();
    await page.getByTestId('ns-try-input').fill(`${SCOPE}/billing`);
    await page.getByTestId('ns-try-button').click();
    // Other internal npm remotes of the gateway may be listed too.
    await expect(page.getByTestId('ns-try-result')).toContainText(new RegExp(`Downloaded only from .*npm/${INTERNAL}`));
    await page.getByTestId('ns-try-input').fill(`${SCOPE}/eslint-config`);
    await page.getByTestId('ns-try-button').click();
    await expect(page.getByTestId('ns-try-reason')).toContainText('published publicly on purpose');

    await page.getByTestId('policy-mode-enforce').locator('input').check();
    // The list of internal remotes may hold the gateway's own as well.
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText([SCOPE, `or ${RESERVED}`]);
    await expect(page.getByTestId('policy-summary')).toContainText(
      new RegExp(`Served only from: internal remotes \\(([^)]*, )?${INTERNAL}(, [^)]*)?\\)`)
    );
    await expect(page.getByTestId('policy-summary')).toContainText('Other remotes: blocked');
    await expect(page.getByTestId('policy-summary')).toContainText(`From any remote: ${SCOPE}/eslint-config`);
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(POLICY) });
    await expect(row).toContainText(`Internal only: ${SCOPE}, ${RESERVED}`);
    await row.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByTestId('view-reserved')).toContainText(SCOPE);
    await expect(page.getByTestId('view-collisions')).toContainText('None found');
    await page.locator('.modal-content').getByRole('button', { name: 'Close' }).first().click();

    // Package check on a reserved name: served only from the internal remote through all.
    await page.goto(`/package-check?ecosystem=npm&package=${RESERVED}&repository=all`);
    await expect(page.getByTestId('namespace-panel')).toContainText(`Reserved internal namespace ${RESERVED}`, { timeout: 60_000 });
    await expect(page.getByTestId('namespace-internal')).toContainText(`npm/${INTERNAL}`);
    await expect(page.getByTestId('namespace-skipped')).toContainText('npm/default');
    await expect(page.getByTestId('pc-served-by')).toHaveText(`Served by npm/${INTERNAL}`);

    // Through default (public only) it is blocked, with the namespace and repository named.
    await page.goto(`/package-check?ecosystem=npm&package=${RESERVED}&version=7.0.0`);
    await expect(page.getByTestId('namespace-notice')).toContainText('has no internal remote', { timeout: 60_000 });
    await expect(page.getByTestId('namespace-notice')).toContainText(POLICY);

    // A reserved name no internal remote has: the download's 404, never a fall-through to public.
    await page.goto(`/package-check?ecosystem=npm&package=${SCOPE}/billing&repository=all`);
    await expect(page.getByTestId('namespace-notice')).toContainText('was not found in internal remotes', { timeout: 60_000 });

    // The client sees the same: 403 with the reason on default, served through all.
    const token = await registryToken(request);
    const blocked = await statusOf(request, token, `/npm/default/${RESERVED}`, 403);
    expect(blocked.status()).toBe(403);
    expect(((await blocked.json()) as { reasons: string[] }).reasons[0]).toContain('has no internal remote');
    expect((await statusOf(request, token, `/npm/all/${RESERVED}/-/${RESERVED}-7.0.0.tgz`, 200)).status()).toBe(200);
    expect((await statusOf(request, token, `/npm/all/${SCOPE}%2fbilling`, 404)).status()).toBe(404);

    // The ledger lists the refusal. Allowed downloads are counted, not listed (requirements_event_streaming.md D9).
    const headers = authHeaders(await adminToken(request));
    await expect
      .poll(async () => {
        const ledger = await request.get(`${API_BASE}/api/admin/audit-logs?package=${RESERVED}&limit=10`, { headers });
        const rows = ((await ledger.json()) as { items: Array<{ decision: string; policyName?: string | null }> }).items;
        return rows.some((r) => r.decision === 'BLOCK' && r.policyName === POLICY);
      })
      .toBe(true);

    await page.goto(`/audit?package=${RESERVED}`);
    // Other suites may have refused this name under their own policies; this test's row names its policy.
    const blockRow = page.locator('tr', { hasText: RESERVED }).filter({ hasText: POLICY }).first();
    await expect(blockRow).toContainText(/Block/i);
  });

  test('the collision check is off by default and can be turned on and off', async ({ page, request }) => {
    const headers = authHeaders(await adminToken(request));
    const before = (await (await request.get(`${API_BASE}/api/admin/config/gateway`, { headers })).json()) as { namespaceCollisionCheck?: boolean };
    await signInAsAdmin(page);
    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Repositories' }).click();
    const toggle = page.getByTestId('namespace-collision-switch');
    await expect(toggle).toHaveAttribute('aria-checked', String(before.namespaceCollisionCheck === true));
    await expect(page.getByText('sends those names to the public registries')).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(before.namespaceCollisionCheck !== true));
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(before.namespaceCollisionCheck === true));
  });
});
