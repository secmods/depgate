import { test, expect } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, loadUser, signInAsAdmin, signInAsUser } from './support';

const SAMPLES: Array<[string, string]> = [
  ['npm', 'lodash'],
  ['pypi', 'requests'],
  ['go', 'github.com/pkg/errors'],
  ['maven', 'org.apache.commons:commons-lang3'],
  ['nuget', 'Newtonsoft.Json'],
  ['cargo', 'serde'],
  ['composer', 'monolog/monolog'],
  ['rubygems', 'rack'],
];

test.describe('Package check', () => {
  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('checks lodash, filters the table, and warns on an unknown version', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/package-check');
    await page.getByLabel('Ecosystem').selectOption('npm');
    await page.getByLabel('Package').fill('lodash');
    await page.getByRole('button', { name: 'Check' }).click();

    await expect(page.getByRole('heading', { name: 'lodash', level: 2 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Recommended version')).toBeVisible();
    await expect(page.locator('.pc-recommended pre')).toContainText('npm install lodash@');

    await page.locator('.pc-recommended').getByRole('button', { name: /Copy$/ }).click();
    await expect(page.getByText('Copied to clipboard')).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('npm install lodash@');

    const before = await page.locator('table.pc-table tbody tr').count();
    await page.getByLabel('Filter versions').fill('4.17.21');
    await expect(page.locator('table.pc-table tbody tr')).toHaveCount(1);
    await expect(page.locator('table.pc-table tbody tr')).toContainText('4.17.21');
    await page.getByLabel('Filter versions').fill('');

    await page.getByRole('checkbox', { name: 'Allowed only' }).check();
    await expect(page.locator('table.pc-table tbody tr', { hasText: 'Blocked' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Hide pre-releases' }).check();
    await expect(page.locator('table.pc-table tbody tr', { hasText: 'Pre-release' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Allowed only' }).uncheck();
    await page.getByRole('checkbox', { name: 'Hide pre-releases' }).uncheck();
    await expect.poll(async () => page.locator('table.pc-table tbody tr').count()).toBeGreaterThanOrEqual(before);

    const loadMore = page.getByRole('button', { name: 'Load more' });
    if (await loadMore.isVisible()) {
      const shown = await page.locator('table.pc-table tbody tr').count();
      await loadMore.click();
      await expect.poll(async () => page.locator('table.pc-table tbody tr').count()).toBeGreaterThan(shown);
    }

    await page.getByLabel('Version (optional)').fill('99.0.0');
    await page.getByRole('button', { name: 'Check' }).click();
    await expect(page.getByText(/Version 99\.0\.0 not found/)).toBeVisible({ timeout: 60_000 });

    await expect(page.getByRole('button', { name: /npm · lodash/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'lodash', level: 2 })).toBeVisible({ timeout: 60_000 });
  });

  test('checks a package in every ecosystem and does not recommend a Maven pre-release', async ({ page }) => {
    test.setTimeout(8 * 60_000);
    await signInAsAdmin(page);
    await page.goto('/package-check');

    for (const [ecosystem, name] of SAMPLES) {
      await test.step(`${ecosystem} ${name}`, async () => {
        await page.getByLabel('Ecosystem').selectOption(ecosystem);
        await page.getByLabel('Package').fill(name);
        await page.getByLabel('Version (optional)').fill('');
        await page.getByRole('button', { name: 'Check' }).click();
        await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('Recommended version')).toBeVisible();
      });
    }

    await test.step('maven log4j-core is not recommended as a beta', async () => {
      await page.getByLabel('Ecosystem').selectOption('maven');
      await page.getByLabel('Package').fill('org.apache.logging.log4j:log4j-core');
      await page.getByRole('button', { name: 'Check' }).click();
      await expect(page.getByRole('heading', { name: 'org.apache.logging.log4j:log4j-core', level: 2 })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('.pc-recommended')).not.toContainText('3.0.0-beta3');
    });
  });

  test('names the blocking policy, and offers an exception to Security', async ({ page, request }) => {
    const token = await adminToken(request);
    const created = await request.post(`${API_BASE}/api/admin/policies`, {
      headers: authHeaders(token),
      data: {
        name: 'qa-e2e-packages-lodash',
        decision: 'BLOCK',
        priority: -1000000,
        isEnabled: true,
        mode: 'enforce',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '4.17.20' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    await signInAsAdmin(page);
    await page.goto('/package-check?ecosystem=npm&package=lodash&version=4.17.20');
    const asked = page.getByTestId('requested-version');
    await expect(asked).toContainText('4.17.20', { timeout: 60_000 });
    if (!(await asked.getByText('Blocked', { exact: true }).isVisible())) {
      await page.getByRole('button', { name: 'Check', exact: true }).click();
    }
    await expect(asked).toContainText('Blocked', { timeout: 60_000 });
    await expect(asked).toContainText('qa-e2e-packages-lodash');
    await expect(asked.getByRole('button', { name: 'Add exception' })).toBeVisible();
    await expect(asked.getByRole('button', { name: 'Request waiver' })).toHaveCount(0);
  });

  test('offers a waiver to a User on a blocked version', async ({ page, request }) => {
    test.skip(!loadUser().available, 'No User account is available');
    const token = await adminToken(request);
    const created = await request.post(`${API_BASE}/api/admin/policies`, {
      headers: authHeaders(token),
      data: {
        name: 'qa-e2e-packages-lodash',
        decision: 'BLOCK',
        priority: -1000000,
        isEnabled: true,
        mode: 'enforce',
        conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '4.17.20' },
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    await signInAsUser(page);
    await page.goto('/package-check?ecosystem=npm&package=lodash&version=4.17.20');
    const asked = page.getByTestId('requested-version');
    await expect(asked).toContainText('Blocked', { timeout: 60_000 });
    await expect(asked.getByRole('button', { name: 'Request waiver' })).toBeVisible();
    await expect(asked.getByRole('button', { name: 'Add exception' })).toHaveCount(0);

    await asked.getByRole('button', { name: 'Request waiver' }).click();
    await expect(page.getByRole('heading', { name: 'Request waiver' })).toBeVisible();
    const dialog = page.locator('.modal-content');
    await expect(dialog.locator('#waiver-package-name')).toHaveValue('lodash');
    await expect(dialog.getByRole('textbox', { name: 'Version', exact: true })).toHaveValue('4.17.20');
  });
});
