import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, adminPassword, adminToken, adminUser, authHeaders, cleanupQa, signInAsAdmin } from './support';

/** Where the backend container reaches this test process. */
const RECEIVER_HOST = process.env.E2E_RECEIVER_HOST ?? 'host.docker.internal';
const BLOCKED = 'is-odd';

interface Received { id: string; event: string; attempt: number; eventHeader: string | undefined }

/** A webhook endpoint that answers 503 (Retry-After: 1) to the first call and 200 afterwards. */
function startReceiver(): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  let calls = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls += 1;
      try {
        const parsed = JSON.parse(body) as { id: string; event: string; attempt: number };
        received.push({ id: parsed.id, event: parsed.event, attempt: parsed.attempt, eventHeader: req.headers['x-depgate-event-id'] as string | undefined });
      } catch {
        /* not JSON: counted, not recorded */
      }
      if (calls === 1) {
        res.writeHead(503, { 'Retry-After': '1' });
        res.end('busy');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve({ server, port: (server.address() as AddressInfo).port, received })));
}

async function blockOnce(request: APIRequestContext): Promise<void> {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: { email: adminUser, password: adminPassword } });
  const body = (await login.json()) as { token: string; registryToken?: string };
  const token = body.registryToken ?? body.token;
  for (let i = 0; i < 15; i += 1) {
    const res = await request.get(`${API_BASE}/npm/${BLOCKED}/-/${BLOCKED}-3.0.1.tgz`, { headers: authHeaders(token), maxRedirects: 0, timeout: 60_000 });
    if (res.status() === 403) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${BLOCKED} was never blocked`);
}

test.describe('Webhook deliveries and Jobs', () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  test.beforeAll(async () => {
    receiver = await startReceiver();
  });

  test.afterAll(async () => {
    await new Promise((resolve) => receiver.server.close(resolve));
  });

  test.beforeEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupQa(request);
  });

  test('a failed delivery is retried, shown in Deliveries, and redelivered with the same event ID', async ({ page, request }) => {
    test.setTimeout(120_000);
    const token = await adminToken(request);
    const headers = authHeaders(token);
    const url = `http://${RECEIVER_HOST}:${receiver.port}/qa-e2e-hook`;
    const hook = await request.post(`${API_BASE}/api/admin/webhooks`, { headers, data: { url, events: ['package_blocked'], isEnabled: true } });
    expect(hook.ok(), await hook.text()).toBeTruthy();
    const { id: webhookId } = (await hook.json()) as { id: string };
    const policy = await request.post(`${API_BASE}/api/admin/policies`, {
      headers,
      data: { name: 'qa-e2e-webhook-block', decision: 'BLOCK', conditions: { ecosystem: ['npm'], packageBlockList: [BLOCKED] } },
    });
    expect(policy.ok(), await policy.text()).toBeTruthy();

    await blockOnce(request);

    // The first attempt gets 503; the retry one second later is delivered.
    await expect.poll(async () => {
      const res = await request.get(`${API_BASE}/api/admin/webhooks/${webhookId}/deliveries?status=delivered`, { headers });
      const body = (await res.json()) as { items: Array<{ attempts: number }> };
      return body.items.some((item) => item.attempts >= 2);
    }, { timeout: 60_000 }).toBe(true);
    const first = receiver.received.find((r) => r.event === 'package_blocked')!;
    expect(first.attempt).toBe(1);
    expect(receiver.received.some((r) => r.id === first.id && r.attempt === 2)).toBe(true);
    expect(first.eventHeader).toBe(first.id);

    await signInAsAdmin(page);
    await page.goto('/settings?tab=webhooks');
    const row = page.getByRole('row', { name: /qa-e2e-hook/ });
    await row.getByRole('button', { name: 'Deliveries' }).click();
    const dialog = page.locator('.modal-content');
    await expect(dialog.getByRole('heading', { name: 'Deliveries' })).toBeVisible();
    const delivered = dialog.getByTestId('delivery-delivered').first();
    await expect(delivered).toContainText('Delivered');
    await expect(delivered).toContainText('package_blocked');

    const before = receiver.received.length;
    await delivered.getByTestId('delivery-redeliver').click();
    await expect(page.getByText('Redelivery queued with the same event ID')).toBeVisible();
    await expect.poll(() => receiver.received.length, { timeout: 30_000 }).toBeGreaterThan(before);
    const ids = new Set(receiver.received.filter((r) => r.event === 'package_blocked').map((r) => r.id));
    expect(ids.has(receiver.received[receiver.received.length - 1].id)).toBe(true);
  });

  test('Settings → Jobs lists the three schedules and records a run', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/settings?tab=jobs');
    await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible();
    for (const job of ['namespace-collision-check', 'malicious-feed-sync', 'monitor-retention-purge']) {
      await expect(page.getByTestId(`schedule-${job}`)).toBeVisible();
    }
    await page.getByTestId('run-now-monitor-retention-purge').click();
    await expect(page.getByText(/Monitoring and history retention (queued|is already running)/)).toBeVisible();
    await expect.poll(async () => {
      await page.getByRole('button', { name: 'Refresh' }).first().click();
      return page.getByTestId('schedule-monitor-retention-purge').textContent();
    }, { timeout: 30_000 }).toMatch(/succeeded|running/);
  });
});
