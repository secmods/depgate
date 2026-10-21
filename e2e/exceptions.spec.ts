import { test, expect } from '@playwright/test';
import { cleanupQa, confirm, signInAsAdmin } from './support';

test.describe('Exceptions', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/exceptions');
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('adds an exception, shows who created it, and revokes it', async ({ page }) => {
    const packageName = `qa-e2e-pkg-${Date.now()}`;
    await expect(page.getByRole('heading', { name: 'Exceptions' })).toBeVisible();
    await page.getByRole('button', { name: 'Add exception' }).click();
    await expect(page.getByRole('heading', { name: 'Add exception' })).toBeVisible();

    await page.locator('#exception-ecosystem').selectOption('npm');
    await page.locator('#exception-package-name').fill(packageName);
    await page.getByTestId('add-exact-version').click();
    await page.locator('.modal-content').getByRole('textbox', { name: 'Version', exact: true }).fill('1.2.3');
    await page.locator('#exception-reason').fill('qa-e2e-exception');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Exception added')).toBeVisible();

    await page.getByLabel('Search by package name').fill(packageName);
    await page.getByLabel('Search by package name').press('Enter');
    const row = page.getByRole('row', { name: new RegExp(packageName) });
    await expect(row).toContainText('1.2.3');
    await expect(row).toContainText('Active');

    await row.getByRole('button', { name: 'View details' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByRole('heading', { name: packageName })).toBeVisible();
    await expect(dialog.getByText('qa-e2e-exception')).toBeVisible();
    await expect(dialog.getByText('1.2.3', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('heading', { name: 'Revoke exception?' })).toBeVisible();
    await confirm(page);
    await expect(page.getByText(`Revoked the exception for ${packageName}`)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(packageName) })).toHaveCount(0);
  });
});
