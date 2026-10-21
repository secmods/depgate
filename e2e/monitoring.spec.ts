import { test, expect } from '@playwright/test';
import { cleanupQa, signInAsAdmin } from './support';

test.describe('Monitoring', () => {
  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('creates a monitor-mode policy and opens its report', async ({ page }) => {
    const name = 'qa-e2e-vuln-monitor';
    await signInAsAdmin(page);
    await page.goto('/monitoring');
    await expect(page.getByRole('heading', { name: 'Monitoring' })).toBeVisible();

    await page.getByRole('button', { name: 'New policy' }).first().click();
    await expect(page.getByRole('heading', { name: 'New policy' })).toBeVisible();
    await page.locator('#policy-name').fill(name);
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-vulnerability').click();
    await expect(page.getByTestId('policy-mode-monitor').getByRole('radio')).toBeChecked();
    await page.locator('#policy-cvss').fill('9.0');
    await expect(page.getByTestId('policy-summary-title')).toContainText('would block');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    await page.getByLabel('Search policies').fill(name);
    await page.getByLabel('Search policies').press('Enter');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await page.getByTestId('sort-name').click();
    await expect(row).toBeVisible();

    await row.click();
    await expect(page).toHaveURL(/\/monitoring\/.+/);
    await expect(page.getByTestId('detail-title')).toHaveText(name);
    await expect(page.getByTestId('detail-enforce')).toBeVisible();
    await expect(page.getByTestId('detail-export')).toBeDisabled();
    await page.reload();
    await expect(page.getByTestId('nav-monitoring-badge')).toBeVisible();
  });
});
