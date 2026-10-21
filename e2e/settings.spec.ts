import { test, expect, type Locator } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, confirm, signInAsAdmin } from './support';

/**
 * Type only after Angular has written the control's current value.
 * Filling as soon as the input is visible races ngModel setup: the next
 * change detection writes the model back over the typed text, and Save
 * then persists the old value.
 */
async function fillAfterBind(locator: Locator, value: string, boundValue: string): Promise<void> {
  await expect(locator).toHaveValue(boundValue);
  await locator.fill(value);
  await expect(locator).toHaveValue(value);
}

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('shows Webhooks, Email, Repositories and Jobs; people moved to Access', async ({ page }) => {
    for (const tab of ['Webhooks', 'Email', 'Repositories', 'Jobs']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible();
    }
    for (const gone of ['Registry', 'API Keys', 'Users & access', 'Single sign-on']) {
      await expect(page.getByRole('tab', { name: gone })).toHaveCount(0);
    }

    await page.getByRole('tab', { name: 'Webhooks' }).click();
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible();
    await page.getByRole('tab', { name: 'Email' }).click();
    await expect(page.getByRole('heading', { name: 'Email (SMTP)' })).toBeVisible();
    await expect(page.getByText('Address people use to open DepGate')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Repositories' }).click();
    await expect(page.getByRole('heading', { name: 'Gateway security' })).toBeVisible();
    await expect(page.locator('.dg-subnav').getByRole('button', { name: /npm$/ })).toBeVisible();
    await expect(page.locator('.dg-subnav').getByRole('button', { name: /PyPI$/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Jobs' }).click();
    await expect(page.getByRole('heading', { name: 'Queues' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
  });

  test('adds and deletes a webhook', async ({ page }) => {
    const url = 'https://example.com/qa-e2e-hook';
    await page.getByRole('tab', { name: 'Webhooks' }).click();
    await page.getByRole('button', { name: 'Add webhook' }).first().click();
    await expect(page.getByRole('heading', { name: 'Add webhook' })).toBeVisible();
    // The defaults are ticked by ngModel a tick after the dialog renders; once they are, the URL field is bound too.
    await expect(page.locator('#evt-package_blocked')).toBeChecked();
    await expect(page.locator('#evt-malware_requested')).toBeChecked();
    await expect(page.locator('#evt-dependency_confusion_blocked')).toBeChecked();
    await expect(page.locator('#evt-namespace_collision')).not.toBeChecked();
    await fillAfterBind(page.locator('#webhook-url'), url, '');
    await expect(page.locator('#evt-policy_violation')).toHaveCount(0);
    await expect(page.locator('#evt-integrity_violation')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Webhook added')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    await expect(row).toContainText('package_blocked');
    await row.getByRole('button', { name: 'Delete webhook' }).click();
    await confirm(page);
    await expect(page.getByText('Webhook deleted')).toBeVisible();
    await expect(row).toHaveCount(0);
  });

  test('refuses an invalid SMTP host or port and keeps the saved settings', async ({ page, request }) => {
    const token = await adminToken(request);
    const headers = authHeaders(token);
    const current = await request.get(`${API_BASE}/api/admin/mail-settings`, { headers });
    expect(current.ok()).toBeTruthy();
    const saved = (await current.json()) as { host: string; port: number; secure: boolean; user: string; from: string };

    try {
      await page.getByRole('tab', { name: 'Email' }).click();
      await expect(page.locator('#smtp-host')).toHaveValue(saved.host);
      if (!(await page.locator('#smtp-from').inputValue()).trim()) {
        await page.locator('#smtp-from').fill('depgate@example.com');
      }
      await page.locator('#smtp-host').fill('not a host!');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Enter a valid SMTP host name')).toBeVisible();

      await page.locator('#smtp-host').fill(saved.host || 'smtp.example.com');
      await page.locator('#smtp-port').fill('0');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Port must be between 1 and 65535')).toBeVisible();

      await page.locator('#smtp-from').fill('');
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    } finally {
      await request.put(`${API_BASE}/api/admin/mail-settings`, {
        headers,
        data: { host: saved.host, port: saved.port, secure: saved.secure, user: saved.user, from: saved.from },
      });
    }
  });

  test('saves a registry token lifetime and restores it', async ({ page, request }) => {
    const token = await adminToken(request);
    const headers = authHeaders(token);
    const current = await request.get(`${API_BASE}/api/admin/config/gateway`, { headers });
    expect(current.ok()).toBeTruthy();
    const saved = (await current.json()) as {
      sessionTokenDays: number;
    };
    const nextDays = saved.sessionTokenDays >= 365 ? saved.sessionTokenDays - 1 : saved.sessionTokenDays + 1;

    try {
      await page.getByRole('tab', { name: 'Repositories' }).click();
      const days = page.getByLabel('Token lifetime in days');
      await expect(days).toHaveValue(String(saved.sessionTokenDays));
      await days.fill(String(nextDays));
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(`Registry tokens last ${nextDays} days`)).toBeVisible();

      await page.reload();
      await page.getByRole('tab', { name: 'Repositories' }).click();
      await expect(page.getByLabel('Token lifetime in days')).toHaveValue(String(nextDays));

      await expect(page.getByRole('switch', { name: 'Strict token mode' })).toHaveCount(0);
    } finally {
      await request.patch(`${API_BASE}/api/admin/config/gateway`, {
        headers,
        data: {
          sessionTokenDays: saved.sessionTokenDays,
        },
      });
    }
  });

  test('adds, edits and deletes an npm repository', async ({ page }) => {
    await page.getByRole('tab', { name: 'Repositories' }).click();
    await page.locator('.dg-subnav').getByRole('button', { name: /npm$/ }).click();
    await page.getByRole('button', { name: 'Add repository' }).click();
    await expect(page).toHaveURL(/\/settings\/repositories\/new\?eco=npm$/);
    await expect(page.getByRole('heading', { name: 'Add repository' })).toBeVisible();
    await expect(page.locator('#repo-timeout')).toHaveValue('30000');
    await fillAfterBind(page.locator('#repo-key'), 'qa-e2e-repo', '');
    await fillAfterBind(page.locator('#repo-description'), 'qa-e2e repository', '');
    await fillAfterBind(page.locator('#repo-upstream'), 'https://registry.npmjs.org', '');
    await page.locator('#repo-source-public').check();
    await page.getByTestId('repo-save').click();
    await expect(page.getByText('Repository added').first()).toBeVisible();
    // After a save the page stays open and links to this repository's client setup.
    await expect(page).toHaveURL(/\/settings\/repositories\/[^/]+\/edit$/);
    await expect(page.getByTestId('repo-client-setup')).toHaveAttribute('href', '/registry?eco=npm&key=qa-e2e-repo');
    await page.getByTestId('repo-cancel').click();

    const row = page.getByRole('row', { name: /^qa-e2e-repo / });
    await expect(row).toContainText('qa-e2e repository');
    await row.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByText(/qa-e2e-repo is reachable/)).toBeVisible({ timeout: 30_000 });

    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Edit repository' })).toBeVisible();
    await fillAfterBind(page.locator('#repo-description'), 'qa-e2e repository edited', 'qa-e2e repository');
    await page.getByTestId('repo-save').click();
    await expect(page.getByText('Repository updated')).toBeVisible();
    await page.getByTestId('repo-cancel').click();
    await expect(row).toContainText('qa-e2e repository edited');

    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await confirm(page);
    await expect(page.getByText('Deleted qa-e2e-repo')).toBeVisible();
  });
});
