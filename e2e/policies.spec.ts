import { test, expect, type Page } from '@playwright/test';
import { cleanupQa, confirm, signInAsAdmin } from './support';

async function openNew(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New policy' }).first().click();
  await expect(page.getByRole('heading', { name: 'New policy' })).toBeVisible();
}

async function confirmSave(page: Page, created = true): Promise<void> {
  await page.getByTestId('policy-save').click();
  await expect(page.getByText(created ? 'Policy created' : 'Policy updated').first()).toBeVisible();
}

function policyRow(page: Page, name: string) {
  return page.getByRole('row', { name: new RegExp(name) });
}

test.describe('Policies', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/policies');
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('blocks Create until a rule is filled in', async ({ page }) => {
    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-empty');
    await expect(page.getByTestId('policy-save')).toBeDisabled();
    await expect(page.getByTestId('policy-save-blocker')).toHaveText('Select a rule.');

    await page.getByTestId('policy-rule-packages').click();
    await expect(page.getByTestId('policy-save-blocker')).toHaveText('Add at least one package name.');
    await page.locator('#policy-packages').fill('qa-e2e-pkg');
    await page.getByTestId('add-version-range').click();
    await page.getByLabel('Range start').fill('1.0.0');
    await expect(page.getByTestId('policy-save-blocker')).toHaveText('Each range needs both a start and an end version.');

    await page.getByLabel('Range end').fill('1.2.0');
    await page.getByTestId('add-exact-version').click();
    await page.getByRole('textbox', { name: 'Version', exact: true }).fill('[3.0,3.13.0)');
    await expect(page.getByText('Enter a single version, e.g. 1.2.3, 2.0.0-rc.1, or 1.0-SNAPSHOT')).toBeVisible();
    await expect(page.getByTestId('policy-save')).toBeDisabled();
  });

  test('offers Allow only on the Packages rule, and Monitor only on Block', async ({ page }) => {
    await openNew(page);
    await page.getByTestId('policy-rule-packages').click();
    await expect(page.getByTestId('policy-decision').locator('option')).toHaveText(['Allow', 'Block']);
    await page.getByTestId('policy-decision').selectOption('ALLOW');
    await expect(page.getByTestId('policy-mode')).toHaveCount(0);
    await expect(page.getByTestId('policy-allow-warning')).toContainText('skip every lower-priority policy');

    await page.getByTestId('policy-decision').selectOption('BLOCK');
    await expect(page.getByTestId('policy-mode-monitor')).toBeVisible();
    await page.getByTestId('policy-mode-monitor').getByRole('radio').check();

    // The chosen rule collapses to one card; Change shows them all again.
    await page.getByTestId('policy-rule-change').click();
    await page.getByTestId('policy-rule-vulnerability').click();
    await expect(page.getByTestId('policy-decision')).toHaveCount(0);
    await expect(page.locator('#policy-packages')).toHaveCount(0);
    await expect(page.getByTestId('policy-mode')).toBeVisible();
  });

  test('on npm, release types that npm does not have are disabled', async ({ page }) => {
    await openNew(page);
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-releaseType').click();
    for (const id of ['dev', 'snapshot', 'pseudo']) {
      await expect(page.getByTestId(`release-type-${id}`)).toContainText('Not in npm');
      await expect(page.getByTestId(`release-type-${id}`).getByRole('checkbox')).toBeDisabled();
    }
    await page.getByTestId('release-type-all').click();
    await expect(page.getByTestId('release-type-prerelease').getByRole('checkbox')).toBeChecked();
    await expect(page.getByTestId('release-type-snapshot').getByRole('checkbox')).not.toBeChecked();

    await page.locator('#policy-ecosystem').selectOption('');
    await expect(page.getByTestId('release-type-snapshot').getByRole('checkbox')).toBeEnabled();
    await expect(page.getByTestId('release-type-pseudo').getByRole('checkbox')).toBeEnabled();
  });

  test('creates, views, edits and disables a packages policy', async ({ page }) => {
    const name = 'qa-e2e-packages-npm';
    await openNew(page);
    await page.locator('#policy-name').fill(name);
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-packages').click();
    await page.getByTestId('policy-decision').selectOption('BLOCK');
    await page.locator('#policy-packages').fill('qa-e2e-pkg');
    await expect(page.getByTestId('policy-summary-title')).toHaveText('Block');
    await expect(page.getByTestId('policy-summary')).toContainText('Every version of:');
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['qa-e2e-pkg']);
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created')).toBeVisible();

    const row = policyRow(page, name);
    await expect(row).toContainText('Block');
    await expect(row).toContainText('Packages');
    await expect(row).toContainText('Enforced');

    await row.getByRole('button', { name: 'View details' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByRole('heading', { name })).toBeVisible();
    await expect(dialog.getByText('qa-e2e-pkg')).toBeVisible();
    await dialog.locator('.modal-footer').getByRole('button', { name: 'Close' }).click();

    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit policy' })).toBeVisible();
    await page.locator('#policy-name').fill(`${name}-edited`);
    await confirmSave(page, false);
    await expect(policyRow(page, `${name}-edited`)).toBeVisible();

    await policyRow(page, `${name}-edited`).getByRole('switch', { name: `Disable ${name}-edited` }).click();
    await expect(page.getByText(`"${name}-edited" disabled`)).toBeVisible();
    await expect(policyRow(page, `${name}-edited`)).toContainText('Disabled');
  });

  test('reorders two policies with move up', async ({ page }) => {
    const first = 'qa-e2e-order-a';
    const second = 'qa-e2e-order-b';
    for (const [name, priority] of [[first, '-1000002'], [second, '-1000001']] as const) {
      await openNew(page);
      await page.locator('#policy-name').fill(name);
      await page.locator('#policy-priority').fill(priority);
      await page.getByTestId('policy-rule-packages').click();
      await page.locator('#policy-packages').fill(name);
      await confirmSave(page);
    }

    const priority = (policyName: string) => policyRow(page, policyName).getByRole('cell').nth(1);
    await expect(priority(first)).toHaveText('-1000002');
    await expect(priority(second)).toHaveText('-1000001');
    await policyRow(page, second).getByRole('button', { name: 'Move up' }).click();
    await expect(page.getByText('Order updated').first()).toBeVisible();
    // A free slot just above the neighbour is taken by the moved policy; the neighbour keeps its number.
    await expect(priority(second)).toHaveText('-1000003');
    await expect(priority(first)).toHaveText('-1000002');
  });

  test('creates a release type, release age, vulnerability and license policy', async ({ page }) => {
    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-release-type-maven');
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('maven');
    await page.getByTestId('policy-rule-releaseType').click();
    await expect(page.getByTestId('release-type-prerelease')).toContainText('Alpha, beta, RC, preview.');
    await page.getByTestId('release-type-prerelease').getByRole('checkbox').check();
    await page.getByTestId('release-type-snapshot').getByRole('checkbox').check();
    await expect(page.getByTestId('release-type-pseudo').getByRole('checkbox')).toBeDisabled();
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['Pre-release', 'or Snapshot']);
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();
    await expect(policyRow(page, 'qa-e2e-release-type-maven')).toContainText('Pre-release, Snapshot');

    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-release-age-npm');
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-releaseAge').click();
    await page.locator('#policy-age-new').check();
    await expect(page.getByLabel('Too new within hours')).toHaveValue('72');
    await page.getByLabel('Too new within hours').fill('24');
    await expect(page.getByTestId('policy-summary')).toContainText('Published less than 24 hours ago');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-vuln-npm');
    await page.locator('#policy-priority').fill('-1000000');
    await page.getByTestId('policy-rule-vulnerability').click();
    await page.locator('#policy-cvss').fill('9.0');
    await expect(page.getByTestId('policy-summary')).toContainText('CVSS ≥ 9.0');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-license-npm');
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-license').click();
    await page.getByTestId('license-mode-allow').click();
    await page.locator('#policy-license-search').fill('MIT');
    await page.locator('.license-dropdown').getByText('MIT', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove MIT' })).toBeVisible();
    await page.getByTestId('license-mode-deny').getByRole('radio').check();
    await expect(page.getByTestId('license-mode-allow').getByRole('radio')).not.toBeChecked();
    await page.getByTestId('license-mode-allow').getByRole('radio').check();
    await expect(page.getByTestId('policy-summary')).toContainText('Versions whose license is not:');
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['MIT']);
    await expect(page.getByTestId('policy-summary')).toContainText('Packages without a license: blocked');
    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();
    await expect(policyRow(page, 'qa-e2e-license-npm')).toContainText('License');
  });

  test('deletes a policy from the list', async ({ page }) => {
    await openNew(page);
    await page.locator('#policy-name').fill('qa-e2e-delete-me');
    await page.locator('#policy-priority').fill('-1000000');
    await page.getByTestId('policy-rule-packages').click();
    await page.locator('#policy-packages').fill('qa-e2e-delete-me');
    await confirmSave(page);

    await policyRow(page, 'qa-e2e-delete-me').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('heading', { name: 'Delete policy?' })).toBeVisible();
    await confirm(page);
    await expect(page.getByText('Deleted "qa-e2e-delete-me"')).toBeVisible();
    await expect(policyRow(page, 'qa-e2e-delete-me')).toHaveCount(0);
  });
});
