import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, adminToken, authHeaders, cleanupQa, loadUser } from './support';

async function userToken(request: APIRequestContext): Promise<string> {
  const user = loadUser();
  const login = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: user.email, password: user.password },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  return ((await login.json()) as { token: string }).token;
}

test.describe('API access', () => {
  test('refuses anonymous calls to policies, package check and the npm document', async ({ request }) => {
    expect((await request.get(`${API_BASE}/api/admin/policies`)).status()).toBe(401);
    expect((await request.post(`${API_BASE}/api/package-check`, { data: { ecosystem: 'npm', package: 'lodash' } })).status()).toBe(401);
    expect((await request.get(`${API_BASE}/npm/lodash`)).status()).toBe(401);
    expect((await request.get(`${API_BASE}/npm/lodash/-/lodash-4.17.21.tgz`)).status()).toBe(401);
    expect((await request.post(`${API_BASE}/api/admin/users`, { data: { email: 'qa-e2e-extra-x@example.com', role: 'User' } })).status()).toBe(401);
    expect((await request.get(`${API_BASE}/api/admin/mail-settings`)).status()).toBe(401);
  });

  test('answers forgot-password the same for a real and an unknown address', async ({ request }) => {
    const known = await request.post(`${API_BASE}/api/auth/forgot-password`, {
      data: { email: 'admin@depgate.local' },
    });
    const unknown = await request.post(`${API_BASE}/api/auth/forgot-password`, {
      data: { email: `qa-e2e-nobody-${Date.now()}@example.com` },
    });
    expect(known.status()).toBe(200);
    expect(unknown.status()).toBe(known.status());
    expect(await unknown.json()).toEqual(await known.json());

    expect((await request.get(`${API_BASE}/api/auth/token-info?token=bad`)).status()).toBe(404);
    expect((await request.post(`${API_BASE}/api/auth/set-password`, { data: { token: 'bad', password: 'long-enough-password' } })).status()).toBe(400);
  });

  test('a User can check packages and cannot administer the gateway', async ({ request }) => {
    test.skip(!loadUser().available, 'No User account is available');
    const headers = authHeaders(await userToken(request));

    const check = await request.post(`${API_BASE}/api/package-check`, {
      headers,
      data: { ecosystem: 'npm', package: 'lodash', version: '4.17.21' },
      timeout: 60_000,
    });
    expect(check.ok(), await check.text()).toBeTruthy();

    const packument = await request.get(`${API_BASE}/npm/lodash`, { headers, timeout: 60_000 });
    expect(packument.status()).toBe(200);

    const forbidden = [
      request.post(`${API_BASE}/api/admin/policies`, { headers, data: { name: 'qa-e2e-denied', decision: 'BLOCK', conditions: { packageBlockList: ['qa-e2e-denied'] } } }),
      request.get(`${API_BASE}/api/admin/policies`, { headers }),
      request.get(`${API_BASE}/api/admin/exceptions`, { headers }),
      request.get(`${API_BASE}/api/admin/audit-logs`, { headers }),
      request.get(`${API_BASE}/api/admin/dashboard/stats`, { headers }),
      request.get(`${API_BASE}/api/admin/monitor/policies`, { headers }),
      request.get(`${API_BASE}/api/admin/users`, { headers }),
      request.get(`${API_BASE}/api/admin/webhooks`, { headers }),
      request.get(`${API_BASE}/api/admin/mail-settings`, { headers }),
      request.post(`${API_BASE}/api/admin/users`, { headers, data: { email: 'qa-e2e-extra-denied@example.com', role: 'User' } }),
    ];
    for (const call of forbidden) {
      expect((await call).status()).toBe(403);
    }

    const tarball = await request.get(`${API_BASE}/npm/default/_auth/not-a-real-token/lodash/-/lodash-4.17.21.tgz`);
    expect([401, 403]).toContain(tarball.status());
  });

  test('rejects a policy with no rule, two rules, Allow on the wrong rule, or a free-form range', async ({ request }) => {
    const headers = authHeaders(await adminToken(request));
    const post = (data: object) => request.post(`${API_BASE}/api/admin/policies`, { headers, data });

    const cases: object[] = [
      { name: 'qa-e2e-api-none', decision: 'BLOCK', conditions: {} },
      { name: 'qa-e2e-api-two', decision: 'BLOCK', conditions: { ecosystem: ['npm'], packageBlockList: ['qa-e2e-pkg'], releaseTypes: ['prerelease'] } },
      { name: 'qa-e2e-api-allow', decision: 'ALLOW', conditions: { ecosystem: ['npm'], releaseTypes: ['prerelease'] } },
      { name: 'qa-e2e-api-monitor', decision: 'ALLOW', mode: 'monitor', conditions: { ecosystem: ['npm'], packageBlockList: ['qa-e2e-pkg'] } },
      { name: 'qa-e2e-api-license', decision: 'BLOCK', conditions: { ecosystem: ['npm'], licenseAllowList: ['MIT'], licenseDenyList: ['GPL-3.0-or-later'] } },
      { name: 'qa-e2e-api-snapshot', decision: 'BLOCK', conditions: { ecosystem: ['npm'], releaseTypes: ['snapshot'] } },
      { name: 'qa-e2e-api-range', decision: 'BLOCK', conditions: { ecosystem: ['npm'], packageBlockList: ['lodash'], versionRange: '[3.0,3.13.0)' } },
    ];

    try {
      for (const body of cases) {
        const res = await post(body);
        expect(res.status(), JSON.stringify(body)).toBe(400);
      }
    } finally {
      await cleanupQa(request);
    }
  });
});
