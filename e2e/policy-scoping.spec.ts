import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, confirm, loadUser, signInAsAdmin, signInAsUser } from './support';

/**
 * Policy scoping per repository (requirements_policy_scoping.md). A Block policy limited to
 * npm/qa-e2e-scope blocks there and nowhere else; the UI shows and edits the scope.
 */
const REPO_KEY = 'qa-e2e-scope';
const POLICY = 'qa-e2e-scope-block';

async function ensureRepository(request: APIRequestContext, key = REPO_KEY): Promise<string> {
  const headers = authHeaders(await adminToken(request));
  const list = await request.get(`${API_BASE}/api/admin/repositories?ecosystem=npm`, { headers });
  const rows = (await list.json()) as Array<{ id: string; key: string }>;
  const existing = rows.find((row) => row.key === key);
  if (existing) return existing.id;
  const created = await request.post(`${API_BASE}/api/admin/repositories`, {
    headers,
    data: { ecosystem: 'npm', key, type: 'remote', upstreamUrl: 'https://registry.npmjs.org', source: 'public', description: 'qa-e2e scope' },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function registryToken(request: APIRequestContext, email: string, password: string): Promise<string> {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: { email, password } });
  const body = (await login.json()) as { token: string; registryToken?: string };
  return body.registryToken ?? body.token;
}

/** Status of the lodash 4.17.20 tarball through a repository, retried past the 5 s policy cache. */
async function tarballStatus(request: APIRequestContext, token: string, key: string, want: number): Promise<number> {
  let status = 0;
  for (let i = 0; i < 10; i += 1) {
    const res = await request.get(`${API_BASE}/npm/${key}/lodash/-/lodash-4.17.20.tgz`, {
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
    });
    status = res.status();
    if (status === want) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return status;
}

async function checkRow(page: Page, repository: string) {
  await page.goto(`/package-check?ecosystem=npm&package=lodash&version=4.17.20&repository=${repository}`);
  await expect(page.getByRole('heading', { name: 'lodash', level: 2 })).toBeVisible({ timeout: 60_000 });
  return page.locator('table.pc-table tbody tr', { hasText: '4.17.20' }).first();
}

async function createScopedPolicy(page: Page): Promise<void> {
  await page.goto('/policies');
  await page.getByRole('button', { name: 'New policy' }).first().click();
  await page.locator('#policy-name').fill(POLICY);
  await page.locator('#policy-priority').fill('-100000');
  await page.locator('#policy-ecosystem').selectOption('npm');

  await page.getByTestId('policy-scope-selected').check();
  await page.getByTestId(`policy-scope-repo-npm-${REPO_KEY}`).check();
  // `all` is never a scope (R5): a policy on a remote already covers its packages through all.
  await expect(page.getByTestId('policy-scope-repo-npm-all')).toHaveCount(0);
  await expect(page.getByTestId('policy-scope-list')).toContainText('Sources (remotes)');

  await page.getByTestId('policy-rule-packages').click();
  await page.locator('#policy-packages').fill('lodash');
  await page.getByTestId('add-exact-version').click();
  await page.getByRole('textbox', { name: 'Version', exact: true }).fill('4.17.20');

  await expect(page.getByTestId('policy-summary')).toContainText('Versions 4.17.20 of:');
  await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['lodash']);
  await expect(page.getByTestId('policy-review-scope')).toContainText(`npm/${REPO_KEY}`);
  await page.getByTestId('policy-save').click();
  await expect(page.getByText('Policy created').first()).toBeVisible();
}

test.describe('Policy scoping per repository', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('Security limits a policy to one repository; it blocks there and nowhere else', async ({ page, request }) => {
    test.setTimeout(4 * 60_000);
    await ensureRepository(request);
    await signInAsAdmin(page);
    await createScopedPolicy(page);

    const row = page.getByRole('row', { name: new RegExp(POLICY) });
    await expect(row).toContainText(`npm/${REPO_KEY}`);

    const blocked = await checkRow(page, REPO_KEY);
    await expect(blocked).toContainText('Blocked');
    await expect(blocked.getByTestId('policy-scope')).toHaveText(`Scoped to npm/${REPO_KEY}`);
    const allowed = await checkRow(page, 'default');
    await expect(allowed).not.toContainText(POLICY);

    const user = loadUser();
    const token = await registryToken(request, user.email, user.password);
    expect(await tarballStatus(request, token, REPO_KEY, 403)).toBe(403);
    expect(await tarballStatus(request, token, 'default', 200)).toBe(200);
    expect(await tarballStatus(request, token, 'all', 200)).toBe(200);
  });

  test('the Policies list filters by repository and the view shows the scope', async ({ page, request }) => {
    await ensureRepository(request);
    await signInAsAdmin(page);
    await createScopedPolicy(page);

    await page.getByTestId('policy-repository-filter').selectOption({ label: 'Applies to npm/default' });
    await expect(page.getByRole('row', { name: new RegExp(POLICY) })).toHaveCount(0);
    await page.getByTestId('policy-repository-filter').selectOption({ label: `Applies to npm/${REPO_KEY}` });
    const row = page.getByRole('row', { name: new RegExp(POLICY) });
    await expect(row).toHaveCount(1);

    await row.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByTestId('view-scope')).toContainText(`npm/${REPO_KEY}`);
    await page.locator('.modal-content').getByRole('button', { name: 'Close' }).first().click();

    await row.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByTestId('policy-scope-selected')).toBeChecked();
    await page.getByTestId('policy-scope-all').check();
    await expect(page.getByTestId('policy-review-scope')).toHaveText('All repositories');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy updated').first()).toBeVisible();
  });

  test('deleting the only scoped repository says what changes and disables the policy', async ({ page, request }) => {
    await ensureRepository(request);
    await signInAsAdmin(page);
    await createScopedPolicy(page);

    await page.goto('/settings');
    await page.getByRole('tab', { name: 'Repositories' }).click();
    await page.locator('.dg-subnav').getByRole('button', { name: /npm$/ }).click();
    // Anchored: the `all` row lists its members, this repository among them.
    const repoRow = page.getByRole('row', { name: new RegExp(`^${REPO_KEY} `) });
    await repoRow.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByTestId('repo-effective-policies')).toContainText(POLICY);
    await page.getByTestId('repo-cancel').click();

    await repoRow.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.modal-content')).toContainText(`Policy "${POLICY}" will be disabled`);
    await confirm(page);
    await expect(page.getByText(`Deleted ${REPO_KEY}`)).toBeVisible();

    await page.goto('/policies');
    const row = page.getByRole('row', { name: new RegExp(POLICY) });
    await expect(row).toContainText('Disabled');
    await expect(row).toContainText('Deleted repository');
  });

  test('a User asks for a waiver limited to the repository they checked', async ({ page, request }) => {
    const user = loadUser();
    test.skip(!user.available, 'No User account can sign in');
    await ensureRepository(request);
    const headers = authHeaders(await adminToken(request));
    const created = await request.post(`${API_BASE}/api/admin/policies`, {
      headers,
      data: {
        name: POLICY,
        decision: 'BLOCK',
        priority: -100000,
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '=4.17.20' },
        repositoryIds: [await ensureRepository(request)],
      },
    });
    expect(created.status()).toBe(201);

    await signInAsUser(page);
    const row = await checkRow(page, REPO_KEY);
    await row.getByRole('button', { name: 'Request waiver' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByTestId('waiver-scope-selected')).toBeChecked();
    await expect(dialog.getByTestId(`waiver-scope-repo-npm-${REPO_KEY}`)).toBeChecked();
    await dialog.locator('#waiver-reason').fill('qa-e2e-scope waiver');
    await dialog.getByRole('button', { name: 'Submit request' }).click();
    await expect(page.getByText('Request submitted for review')).toBeVisible();

    const waivers = await request.get(`${API_BASE}/api/waiver-requests?package=lodash&status=pending&limit=50`, { headers });
    const items = ((await waivers.json()) as { items: Array<{ id: string; reason: string; repositories: Array<{ key: string }> }> }).items;
    const mine = items.find((item) => item.reason === 'qa-e2e-scope waiver');
    expect(mine?.repositories.map((ref) => ref.key)).toEqual([REPO_KEY]);
    if (mine) await request.post(`${API_BASE}/api/waiver-requests/${mine.id}/reject`, { headers, data: { reviewNote: 'qa-e2e cleanup' } });
  });
});
