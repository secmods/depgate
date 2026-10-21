import { test, expect, type Page } from '@playwright/test';
import { cleanupQa, confirm, loadUser, signInAsAdmin, signInAsUser } from './support';

async function requestWaiver(page: Page, packageName: string, version: string, reason: string): Promise<void> {
  await page.getByRole('button', { name: 'Request waiver' }).click();
  const dialog = page.locator('.modal-content');
  await dialog.locator('#waiver-ecosystem').selectOption('npm');
  await dialog.locator('#waiver-package-name').fill(packageName);
  await dialog.getByTestId('add-exact-version').click();
  await dialog.getByRole('textbox', { name: 'Version', exact: true }).fill(version);
  await dialog.locator('#waiver-reason').fill(reason);
  await dialog.getByRole('button', { name: 'Submit request' }).click();
}

test.describe('Waiver requests', () => {
  test.beforeEach(() => {
    test.skip(!loadUser().available, 'No User account is available');
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('a User asks, cannot approve, and a duplicate pending request is refused', async ({ page }) => {
    const packageName = `qa-e2e-waiver-${Date.now()}`;
    await signInAsUser(page);
    await page.goto('/waivers');
    await expect(page.getByRole('heading', { name: 'Waiver requests' })).toBeVisible();

    await requestWaiver(page, packageName, '1.0.0', 'qa-e2e-waiver-a');
    await expect(page.getByText('Request submitted for review')).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(packageName) })).toContainText('Pending');

    await page.getByRole('row', { name: new RegExp(packageName) }).getByRole('button', { name: 'View details' }).click();
    const view = page.locator('.modal-content');
    await expect(view.getByRole('heading', { name: 'Waiver request' })).toBeVisible();
    await expect(view.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await view.locator('.modal-footer').getByRole('button', { name: 'Close' }).click();

    await page.goto('/exceptions');
    await expect(page).toHaveURL(/\/registry/);

    await page.goto('/waivers');
    await requestWaiver(page, packageName, '1.0.0', 'qa-e2e-waiver-duplicate');
    await expect(page.getByText('A pending waiver request already exists for this package')).toBeVisible();
  });

  test('Security approves one request and rejects another', async ({ page: userPage, browser, baseURL }) => {
    const packageName = `qa-e2e-waiver-${Date.now()}`;
    const adminContext = await browser.newContext({ baseURL: baseURL ?? 'http://localhost:3050' });
    const adminPage = await adminContext.newPage();

    try {
      await signInAsUser(userPage);
      await userPage.goto('/waivers');
      await requestWaiver(userPage, packageName, '1.0.0', 'qa-e2e-waiver-approve');
      await expect(userPage.getByText('Request submitted for review')).toBeVisible();
      await requestWaiver(userPage, packageName, '1.0.1', 'qa-e2e-waiver-reject');
      await expect(userPage.getByText('Request submitted for review')).toBeVisible();

      await signInAsAdmin(adminPage);
      await adminPage.goto('/exceptions');
      await adminPage.getByRole('tab', { name: /Waiver requests/ }).click();
      await adminPage.getByLabel('Search by package name').fill(packageName);
      await adminPage.getByLabel('Search by package name').press('Enter');

      const approveRow = adminPage.getByRole('row', { name: new RegExp(`${packageName}[\\s\\S]*1\\.0\\.0`) });
      await approveRow.getByRole('button', { name: 'Review' }).click();
      await adminPage.locator('.modal-content').getByRole('button', { name: 'Approve', exact: true }).click();
      await adminPage.locator('.modal-content').getByRole('button', { name: 'Approve waiver' }).click();
      await expect(adminPage.getByText(`Approved the waiver for ${packageName}`)).toBeVisible();

      const rejectRow = adminPage.getByRole('row', { name: new RegExp(`${packageName}[\\s\\S]*1\\.0\\.1`) });
      await rejectRow.getByRole('button', { name: 'Review' }).click();
      await adminPage.locator('.modal-content').getByRole('button', { name: 'Reject', exact: true }).click();
      await adminPage.locator('#review-note').fill('qa-e2e-not-approved');
      await adminPage.locator('.modal-content').getByRole('button', { name: 'Reject waiver' }).click();
      await expect(adminPage.getByText(`Rejected the waiver for ${packageName}`)).toBeVisible();

      await userPage.reload();
      await expect(userPage.getByRole('row', { name: new RegExp(`${packageName}[\\s\\S]*1\\.0\\.0`) })).toContainText('Approved');
      const rejected = userPage.getByRole('row', { name: new RegExp(`${packageName}[\\s\\S]*1\\.0\\.1`) });
      await expect(rejected).toContainText('Rejected');
      await rejected.getByRole('button', { name: 'View details' }).click();
      await expect(userPage.locator('.modal-content')).toContainText('qa-e2e-not-approved');
      await userPage.locator('.modal-content .modal-footer').getByRole('button', { name: 'Close' }).click();

      await requestWaiver(userPage, packageName, '1.0.2', 'qa-e2e-waiver-withdraw');
      await expect(userPage.getByText('Request submitted for review')).toBeVisible();
      await userPage.getByRole('row', { name: new RegExp(`${packageName}[\\s\\S]*1\\.0\\.2`) }).getByRole('button', { name: 'View details' }).click();
      await userPage.locator('.modal-content').getByRole('button', { name: 'Delete', exact: true }).click();
      await confirm(userPage);
      await expect(userPage.getByText(`Withdrew the request for ${packageName}`)).toBeVisible();
    } finally {
      await adminContext.close();
    }
  });
});
