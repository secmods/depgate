import { test, expect } from '@playwright/test';
import { signInAsAdmin } from './support';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('shows request totals and reloads them', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toBeVisible();
    for (const label of ['Requests', 'Allowed', 'Blocked']) {
      await expect(page.locator('.dg-stat-label', { hasText: label })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Decisions by ecosystem' })).toBeVisible();

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('changes the time range without an error', async ({ page }) => {
    const range = page.getByLabel('Time range');
    await expect(range).toBeVisible();
    for (const value of ['24h', '7d', '30d']) {
      await range.selectOption(value);
      await expect(page.locator('.dg-stat-label', { hasText: 'Requests' })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });
});
