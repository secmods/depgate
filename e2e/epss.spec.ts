/**
 * EPSS in the Vulnerability rule: the form, the EPSS data card (a real sync of the daily file), and
 * EPSS in Package check. The sync and Package check need outbound access to the EPSS feed (or its
 * GitHub backup), registry.npmjs.org and api.osv.dev.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, signInAsAdmin } from './support';

async function epssStatus(request: APIRequestContext): Promise<{ state: string; rowCount: number | null; scoreDate: string | null; feedSource: string | null }> {
  const res = await request.get(`${API_BASE}/api/admin/epss/status`, { headers: authHeaders(await adminToken(request)) });
  expect(res.ok()).toBe(true);
  return res.json();
}

/** Syncs once when the store is empty or stale; a fresh store is left as it is. */
async function ensureEpss(request: APIRequestContext): Promise<void> {
  const before = await epssStatus(request);
  if (before.rowCount && before.rowCount > 100_000 && before.scoreDate && Date.now() - Date.parse(before.scoreDate) < 72 * 3_600_000) return;
  const headers = authHeaders(await adminToken(request));
  const started = await request.post(`${API_BASE}/api/admin/epss/sync`, { headers });
  expect([202, 409]).toContain(started.status());
  await expect
    .poll(async () => (await epssStatus(request)).state, { timeout: 80_000, intervals: [1000], message: 'EPSS sync finishes' })
    .not.toBe('running');
  expect((await epssStatus(request)).rowCount ?? 0).toBeGreaterThan(100_000);
}

test.describe('EPSS', () => {
  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('creates a Vulnerability policy with an EPSS threshold: monitor first, review sentence, view', async ({ page }) => {
    const name = 'qa-e2e-epss-form';
    await signInAsAdmin(page);
    await page.goto('/policies/new');
    await page.locator('#policy-name').fill(name);
    await page.locator('#policy-priority').fill('-1000000');
    await page.locator('#policy-ecosystem').selectOption('npm');
    await page.getByTestId('policy-rule-vulnerability').click();
    await page.locator('#policy-cvss').fill('7.0');
    await expect(page.getByTestId('policy-mode-enforce').getByRole('radio')).toBeChecked();

    await page.locator('#policy-epss').check();
    await expect(page.getByTestId('policy-mode-monitor').getByRole('radio')).toBeChecked();
    await expect(page.getByTestId('policy-mode-auto')).toContainText('Switched to Monitor only');
    await expect(page.getByTestId('epss-score')).toHaveValue('10');
    await page.locator('#policy-cves').fill('CVE-2024-1234');
    await expect(page.getByTestId('policy-summary-title')).toHaveText('Monitor only — would block');
    await expect(page.getByTestId('policy-summary').locator('li')).toHaveText(['CVSS ≥ 7.0 and EPSS ≥ 10 %', 'or CVE-2024-1234']);
    await expect(page.getByTestId('policy-summary')).toContainText('Vulnerabilities without EPSS: flagged');

    await page.getByTestId('epss-mode-percentile').getByRole('radio').check();
    await page.getByTestId('epss-percentile').fill('95');
    await page.getByTestId('epss-unknown-ignore').check();
    await expect(page.getByTestId('policy-summary')).toContainText('CVSS ≥ 7.0 and EPSS percentile ≥ 95th');
    await expect(page.getByTestId('policy-summary')).toContainText('Vulnerabilities without EPSS: ignored');

    await page.getByTestId('policy-save').click();
    await expect(page.getByText('Policy created').first()).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toContainText('EPSS percentile ≥ 95th');
    await row.getByRole('button', { name: 'View details' }).click();
    await expect(page.locator('.modal-content').getByTestId('view-epss')).toContainText('EPSS percentile ≥ 95th');
    await expect(page.locator('.modal-content').getByTestId('view-epss')).toContainText('Vulnerabilities without EPSS: ignored');
  });

  test('the EPSS scores sync row shows the synced file: date, size and source', async ({ page, request }) => {
    await ensureEpss(request);
    await signInAsAdmin(page);
    await page.goto('/settings?tab=jobs');
    await expect(page.getByTestId('schedule-epss-sync')).toBeVisible();
    const details = page.getByTestId('epss-details');
    await expect(details).toBeVisible();
    await expect(details.getByTestId('epss-score-date')).not.toHaveText('Never synced');
    await expect(details.getByTestId('epss-rows')).toHaveText(/\d{3},\d{3}/);
    await expect(details.getByTestId('epss-source')).toContainText(/epss_scores/);
  });

  test('Package check shows EPSS next to each vulnerability, and an EPSS policy decides with it', async ({ page, request }) => {
    await ensureEpss(request);
    const headers = authHeaders(await adminToken(request));
    // Monitor mode: lodash 4.17.20 is served, and Package check still loads its vulnerabilities and EPSS.
    const created = await request.post(`${API_BASE}/api/admin/policies`, {
      headers,
      data: { name: 'qa-e2e-epss-check', decision: 'BLOCK', mode: 'monitor', priority: -1000000, conditions: { ecosystem: ['npm'], epssMin: 0.0001 } },
    });
    expect(created.status(), await created.text()).toBe(201);

    const check = await request.post(`${API_BASE}/api/package-check`, { headers, data: { ecosystem: 'npm', package: 'lodash', versions: ['4.17.20'] } });
    expect(check.ok()).toBe(true);
    const body = (await check.json()) as { epssDate: string | null; versions: Array<{ version: string; vulnerabilities?: Array<{ id: string; cves: string[]; epss: unknown }>; monitoring?: Array<{ reasons: string[] }> }> };
    const asked = body.versions.find((row) => row.version === '4.17.20')!;
    const scored = (asked.vulnerabilities ?? []).filter((vuln) => vuln.epss);
    expect(scored.length).toBeGreaterThan(0);
    expect(body.epssDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(asked.monitoring?.[0].reasons[0]).toMatch(/EPSS [\d.]+ % \(\d+(st|nd|rd|th) percentile, \d{4}-\d{2}-\d{2}\)/);

    await signInAsAdmin(page);
    await page.goto('/package-check?ecosystem=npm&package=lodash&version=4.17.20');
    await expect(page.getByTestId('pc-vuln-epss').first()).toContainText(/EPSS [\d.]+ % · \d+(st|nd|rd|th)/, { timeout: 30_000 });
  });

  test('the API rejects invalid EPSS thresholds and answers a CVE lookup from the store', async ({ request }) => {
    await ensureEpss(request);
    const headers = authHeaders(await adminToken(request));
    for (const [conditions, message] of [
      [{ epssMin: 0.1, epssPercentileMin: 0.9 }, /not both/],
      [{ epssMin: 5 }, /at most 1/],
      [{ cveSeverityThreshold: 'HIGH', epssUnknown: 'ignore' }, /needs epssMin/],
    ] as const) {
      const res = await request.post(`${API_BASE}/api/admin/policies`, { headers, data: { name: 'qa-e2e-epss-bad', decision: 'BLOCK', conditions } });
      expect(res.status()).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    const lookup = await request.get(`${API_BASE}/api/admin/epss/CVE-2021-44228`, { headers });
    expect(lookup.status()).toBe(200);
    expect(await lookup.json()).toMatchObject({ cve: 'CVE-2021-44228', score: expect.any(Number), percentile: expect.any(Number) });
  });
});
