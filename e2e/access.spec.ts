import { test, expect } from '@playwright/test';
import { cleanupQa, confirm, signInAsAdmin } from './support';

test.describe('Access', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('has Users, Single sign-on and Service accounts tabs, kept in the address', async ({ page }) => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Access' }).click();
    await expect(page).toHaveURL(/\/access$/);
    await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();
    for (const tab of ['Users', 'Single sign-on', 'Service accounts']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    await expect(page.getByTestId('users-sso-status')).toBeVisible();

    await page.getByRole('tab', { name: 'Single sign-on' }).click();
    await expect(page).toHaveURL(/\/access\?tab=sso$/);
    await expect(page.getByRole('heading', { name: 'Who may sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Identity providers' })).toBeVisible();

    await page.getByRole('tab', { name: 'Service accounts' }).click();
    await expect(page).toHaveURL(/\/access\?tab=service-accounts$/);
    await expect(page.getByRole('heading', { name: 'Service accounts' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Service accounts' })).toHaveAttribute('aria-selected', 'true');
  });

  test('pages and searches people, and remembers rows per page', async ({ page }) => {
    await page.goto('/access?tab=users');
    const pager = page.getByTestId('pagination');
    await expect(pager).toBeVisible();
    await pager.getByTestId('pagination-size').selectOption('10');
    await expect(page.getByTestId('pagination-range')).toContainText(/1–\d+/);
    expect(await page.locator('tbody tr').count()).toBeLessThanOrEqual(10);
    await page.reload();
    await expect(page.getByTestId('pagination-size')).toHaveValue('10');

    await page.getByRole('searchbox', { name: 'Search by email' }).fill('no-such-person-qa-e2e');
    await page.getByRole('searchbox', { name: 'Search by email' }).press('Enter');
    await expect(page.getByText('No people match')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search by email' }).fill('');
    await page.getByRole('searchbox', { name: 'Search by email' }).press('Enter');
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    await page.getByTestId('pagination-size').selectOption('20');
  });

  test('old Settings links land on the new tabs', async ({ page }) => {
    await page.goto('/settings?tab=users');
    await expect(page).toHaveURL(/\/access\?tab=users$/);
    await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
    await page.goto('/settings?tab=sso');
    await expect(page).toHaveURL(/\/access\?tab=sso$/);
    await expect(page.getByRole('heading', { name: 'Identity providers' })).toBeVisible();
  });

  test('invites a person without a password, and creates a service account', async ({ page }) => {
    const email = `qa-e2e-invite-${Date.now()}@example.com`;
    await page.goto('/access?tab=users');
    await page.getByRole('button', { name: 'Add user' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByRole('heading', { name: 'Add user' })).toBeVisible();
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0);
    // Starts ticked when single sign-on is off and unticked when it is on; this test sends one either way.
    await dialog.getByTestId('user-send-invite').check();
    await dialog.locator('#user-email').fill(email);
    await dialog.locator('#user-role').selectOption('User');
    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(dialog.getByRole('heading', { name: 'Invitation created' })).toBeVisible();
    await expect(dialog).toContainText(/Invitation sent|could not be sent/);
    await dialog.getByRole('button', { name: 'Done' }).click();

    const row = page.getByRole('row', { name: new RegExp(email) });
    await expect(row).toContainText('Invited');
    await page.getByTestId(`user-actions-${email}`).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const confirmDialog = page.locator('.modal-content').filter({ hasText: 'Delete user?' });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByTestId('confirm-accept').click();
    await expect(row).toHaveCount(0);

    await page.getByRole('tab', { name: 'Service accounts' }).click();
    await page.getByRole('button', { name: 'Add service account' }).click();
    await page.locator('#sa-name').fill('qa-e2e-ci');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Copy the key now.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    const account = page.getByRole('row', { name: /qa-e2e-ci/ });
    await expect(account).toBeVisible();
    await account.getByRole('button', { name: 'Delete service account' }).click();
    await confirm(page);
    await expect(page.getByText('Service account deleted')).toBeVisible();
  });
});
