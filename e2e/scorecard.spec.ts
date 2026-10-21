/**
 * Project health (OpenSSF Scorecard) policies: the form, the API, and a monitored download.
 * The last test downloads express through `default` and reads its real Scorecard, so it needs
 * outbound access to registry.npmjs.org and api.securityscorecards.dev.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, signInAsAdmin } from './support';

async function createPolicy(request: APIRequestContext, data: Record<string, unknown>): Promise<{ id: string }> {
  const token = await adminToken(request);
  const res = await request.post(`${API_BASE}/api/admin/policies`, { headers: authHeaders(token), data });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

test.describe('Project health (OpenSSF Scorecard)', () => {
  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('creates a policy: monitor first, overall score, Advanced checks, and both "no score" choices', async ({ page }) => {
    const name = 'qa-e2e-scorecard-form';
    await signInAsAdmin(page);
    await page.goto('/policies/new');
    await expect(page.getByRole('heading', { name: 'New policy' })).toBeVisible();
    await page.locator('#policy-name').fill(name);
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-scorecard').click();

    await expect(page.getByTestId('policy-decision')).toHaveCount(0);
    await expect(page.getByTestId('policy-mode-monitor').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('policy-mode-auto')).toBeVisible();
    await expect(page.getByTestId('scorecard-min')).toHaveValue('5');
    await expect(page.getByTestId('scorecard-unknown-select')).toHaveValue('allow');
    await expect(page.getByTestId('scorecard-unavailable-select')).toHaveValue('allow');
    await expect(page.getByTestId('scorecard-info')).toContainText('not malware');
    await expect(page.getByTestId('policy-summary-title')).toHaveText('Monitor only — would block');
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['OpenSSF Scorecard below 5.0']);
    await expect(page.getByTestId('policy-summary')).toContainText('Packages without a Scorecard: allowed');
    await expect(page.getByTestId('policy-summary')).toContainText('Scorecard unreachable: allowed');

    await page.getByTestId('scorecard-advanced').locator('summary').click();
    await page.getByTestId('scorecard-add-check').click();
    await expect(page.getByTestId('scorecard-check-0')).toContainText('dangerous patterns');
    await page.getByTestId('scorecard-unavailable-select').selectOption('block');
    await expect(page.getByTestId('scorecard-unavailable-warning')).toBeVisible();
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['OpenSSF Scorecard below 5.0', 'or Dangerous-Workflow check below 10']);
    await expect(page.getByTestId('policy-summary')).toContainText('Scorecard unreachable: flagged');

    await page.getByTestId('scorecard-min').fill('');
    await page.getByTestId('scorecard-check-0').locator('input[type=number]').fill('');
    await expect(page.getByTestId('policy-save-blocker')).toHaveText('Each check needs a minimum from 0 to 10.');
    await page.getByTestId('scorecard-check-0').locator('input[type=number]').fill('10');
    await page.getByTestId('scorecard-min').fill('4.5');

    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();

    await page.goto('/policies');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('Project health');
    await row.getByRole('button', { name: 'View details' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByTestId('view-scorecard-min')).toHaveText('At least 4.5');
    await expect(dialog.getByTestId('view-scorecard-checks')).toContainText('Dangerous-Workflow at least 10');
    await expect(dialog.getByText('Repositories whose remotes are all public')).toBeVisible();
  });

  test('the API lists the checks and rejects Allow, Webhooks and out-of-range scores', async ({ request }) => {
    const headers = authHeaders(await adminToken(request));
    const checks = await request.get(`${API_BASE}/api/admin/policies/scorecard-checks`, { headers });
    expect(checks.ok()).toBe(true);
    const names = ((await checks.json()) as { checks: Array<{ name: string }> }).checks.map((check) => check.name);
    expect(names).toHaveLength(18);
    expect(names).not.toContain('Webhooks');

    for (const [data, message] of [
      [{ decision: 'ALLOW', conditions: { scorecardMinScore: 5 } }, /can block, not allow/],
      [{ decision: 'BLOCK', conditions: { scorecardChecks: [{ name: 'Webhooks', minScore: 5 }] } }, /never in public results/],
      [{ decision: 'BLOCK', conditions: { scorecardMinScore: 11 } }, /from 0 to 10/],
    ] as const) {
      const res = await request.post(`${API_BASE}/api/admin/policies`, { headers, data: { name: 'qa-e2e-scorecard-bad', ...data } });
      expect(res.status()).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
  });

  test('a monitored low score is recorded on Monitoring with its reason, and Package check shows the panel', async ({ page, request }) => {
    const name = 'qa-e2e-scorecard-monitor';
    // Below 10 matches nearly every project, so express (about 8.9) is recorded.
    const policy = await createPolicy(request, {
      name,
      decision: 'BLOCK',
      mode: 'monitor',
      priority: -1000000,
      conditions: { ecosystem: ['npm'], scorecardMinScore: 10 },
    });
    const headers = authHeaders(await adminToken(request));
    const tarball = await request.get(`${API_BASE}/npm/default/express/-/express-4.21.2.tgz`, { headers, maxRedirects: 0 });
    expect([200, 302, 307]).toContain(tarball.status());

    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_BASE}/api/admin/monitor/packages?policyId=${policy.id}`, { headers });
          if (!res.ok()) return '';
          const body = (await res.json()) as { items: Array<{ packageName: string; reasonKey: string }> };
          return body.items.find((item) => item.packageName === 'express')?.reasonKey ?? '';
        },
        { timeout: 30_000, message: 'express is recorded by the monitoring policy' }
      )
      .toBe('scorecard:overall');

    await signInAsAdmin(page);
    await page.goto(`/monitoring/${policy.id}`);
    await expect(page.getByTestId('detail-title')).toHaveText(name);
    await expect(page.getByText('Scorecard below the minimum').first()).toBeVisible();
    await expect(page.getByText('express').first()).toBeVisible();

    await page.goto('/package-check?ecosystem=npm&package=express&version=4.21.2');
    const panel = page.getByTestId('project-health');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId('project-health-repo')).toHaveText('github.com/expressjs/express');
    await expect(panel.getByTestId('project-health-score')).toContainText('/ 10');
    await expect(panel).toContainText('Dangerous-Workflow');
  });
});
