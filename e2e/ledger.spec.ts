import { test, expect } from '@playwright/test';
import { signInAsAdmin } from './support';

test.describe('Decision Ledger', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/audit');
  });

  test('shows the ledger, filters, and an empty result', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Decision ledger' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    // Dates are typed only for a custom range.
    await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
    await page.getByTestId('time-range').selectOption('custom');
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();

    await page.getByLabel('Ecosystem').selectOption('npm');
    await page.getByLabel('Event').selectOption('ALLOW');
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeVisible();

    await page.getByLabel('Search by package').fill(`qa-e2e-missing-${Date.now()}`);
    await page.getByLabel('Search by package').press('Enter');
    await expect(page.getByText('No entries match these filters')).toBeVisible();

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
  });

  test('exports the current rows as CSV when the ledger has any', async ({ page }) => {
    const exportButton = page.getByRole('button', { name: 'Export CSV' });
    test.skip(await exportButton.isDisabled(), 'The ledger has no rows to export');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      exportButton.click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/i);
  });
});
