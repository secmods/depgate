/**
 * Shared Playwright helpers.
 * Everything these tests create is named with PREFIX so cleanup never touches real data.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const API_BASE = process.env.E2E_API_URL ?? 'http://localhost:3050';
export const PREFIX = 'qa-e2e-';

export const adminUser = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@depgate.local';
export const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'admin';

/** Standing User from the product fixtures. Prepared in global setup when it can sign in. */
export const standingUser = {
  email: process.env.E2E_USER_EMAIL ?? 'user@depgate.local',
  password: process.env.E2E_USER_PASSWORD ?? 'usertest123',
};

const QA_USER = { email: `${PREFIX}user@example.com`, password: 'qa-e2e-pass-1' };
const USER_FILE = 'test-results/e2e-user.json';

export interface E2EUser {
  email: string;
  password: string;
  available: boolean;
}

export function loadUser(): E2EUser {
  try {
    return JSON.parse(readFileSync(USER_FILE, 'utf8')) as E2EUser;
  } catch {
    return { ...standingUser, available: false };
  }
}

export function writeUser(user: E2EUser): void {
  mkdirSync('test-results', { recursive: true });
  writeFileSync(USER_FILE, JSON.stringify(user));
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await submitLogin(page, email, password);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

export async function signInAsAdmin(page: Page): Promise<void> {
  await signIn(page, adminUser, adminPassword);
}

export async function signInAsUser(page: Page): Promise<void> {
  const user = loadUser();
  await signIn(page, user.email, user.password);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
}

export async function confirm(page: Page): Promise<void> {
  await page.getByTestId('confirm-accept').click();
}

let cachedAdmin: { token: string; at: number } | null = null;

export async function adminToken(request: APIRequestContext): Promise<string> {
  if (cachedAdmin && Date.now() - cachedAdmin.at < 10 * 60_000) return cachedAdmin.token;
  const login = await request.post(`${API_BASE}/api/auth/login`, {
    data: { email: adminUser, password: adminPassword },
  });
  if (!login.ok()) throw new Error(`Admin login failed: ${login.status()} ${await login.text()}`);
  const body = (await login.json()) as { token: string };
  cachedAdmin = { token: body.token, at: Date.now() };
  return body.token;
}

export function authHeaders(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function loginOk(request: APIRequestContext, email: string, password: string): Promise<boolean> {
  const res = await request.post(`${API_BASE}/api/auth/login`, { data: { email, password } });
  return res.ok();
}

async function inviteLink(request: APIRequestContext, token: string, email: string, resendId?: string): Promise<string | null> {
  const headers = authHeaders(token);
  const created = resendId
    ? await request.post(`${API_BASE}/api/admin/users/${resendId}/resend-invite`, { headers })
    : await request.post(`${API_BASE}/api/admin/users`, { headers, data: { email, role: 'User' } });
  if (created.status() === 409 && !resendId) return null;
  if (!created.ok()) return null;
  const body = (await created.json()) as { inviteUrl?: string; emailSent?: boolean };
  if (body.inviteUrl) return body.inviteUrl;
  if (!body.emailSent) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const fromMail = await mailpitLink(email);
    if (fromMail) return fromMail;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

async function mailpitLink(email: string): Promise<string | null> {
  try {
    const list = await fetch(`http://localhost:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (!list.ok) return null;
    const body = (await list.json()) as { messages?: Array<{ ID: string }> };
    const id = body.messages?.[0]?.ID;
    if (!id) return null;
    const message = await fetch(`http://localhost:8025/api/v1/message/${id}`);
    if (!message.ok) return null;
    const mail = (await message.json()) as { Text?: string; HTML?: string };
    const text = `${mail.Text ?? ''}\n${mail.HTML ?? ''}`;
    return text.match(/https?:\/\/[^\s"'<>]+\/set-password\?token=[^\s"'<>]+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Makes sure a User can sign in: the standing account, or a qa-e2e account accepted through the invitation link. */
export async function ensureUser(request: APIRequestContext): Promise<E2EUser> {
  if (await loginOk(request, standingUser.email, standingUser.password)) {
    return { ...standingUser, available: true };
  }
  if (await loginOk(request, QA_USER.email, QA_USER.password)) {
    return { ...QA_USER, available: true };
  }

  let token: string;
  try {
    token = await adminToken(request);
  } catch {
    return { ...standingUser, available: false };
  }

  const headers = authHeaders(token);
  const listed = await request.get(`${API_BASE}/api/admin/users?search=${encodeURIComponent(QA_USER.email)}`, { headers });
  const users = listed.ok() ? ((await listed.json()) as { items: Array<{ id: string; email: string; status: string }> }).items : [];
  const existing = users.find((user) => user.email === QA_USER.email);
  const link = existing?.status === 'invited'
    ? await inviteLink(request, token, QA_USER.email, existing.id)
    : existing
      ? null
      : await inviteLink(request, token, QA_USER.email);

  if (!link) return { ...QA_USER, available: false };
  const inviteToken = new URL(link).searchParams.get('token');
  if (!inviteToken) return { ...QA_USER, available: false };
  const set = await request.post(`${API_BASE}/api/auth/set-password`, {
    data: { token: inviteToken, password: QA_USER.password },
  });
  if (!set.ok()) return { ...QA_USER, available: false };
  return { ...QA_USER, available: true };
}

interface Named { id: string; name?: string; email?: string; url?: string; key?: string; packageName?: string }

async function deleteEach(
  request: APIRequestContext,
  headers: { Authorization: string },
  url: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await request.delete(`${url}/${id}`, { headers });
  }
}

/** Removes qa-e2e data left by this suite. Leaves the standing user and qa-e2e-user fixture alone. */
export async function cleanupQa(request: APIRequestContext): Promise<void> {
  let token: string;
  try {
    token = await adminToken(request);
  } catch {
    return;
  }
  const headers = authHeaders(token);

  const policies = await request.get(`${API_BASE}/api/admin/policies?limit=500`, { headers });
  if (policies.ok()) {
    const { items } = (await policies.json()) as { items: Named[] };
    await deleteEach(request, headers, `${API_BASE}/api/admin/policies`, items.filter((p) => p.name?.startsWith(PREFIX)).map((p) => p.id));
  }

  const exceptions = await request.get(`${API_BASE}/api/admin/exceptions?appliesTo=any&package=${PREFIX}&limit=200`, { headers });
  if (exceptions.ok()) {
    const { items } = (await exceptions.json()) as { items: Named[] };
    await deleteEach(request, headers, `${API_BASE}/api/admin/exceptions`, items.map((item) => item.id));
  }

  const waivers = await request.get(`${API_BASE}/api/waiver-requests?package=${PREFIX}&limit=200`, { headers });
  if (waivers.ok()) {
    const { items } = (await waivers.json()) as { items: Named[] };
    await deleteEach(request, headers, `${API_BASE}/api/waiver-requests`, items.map((item) => item.id));
  }

  const malware = await request.get(`${API_BASE}/api/admin/malicious-packages?source=custom&name=${PREFIX}&limit=200`, { headers });
  if (malware.ok()) {
    const { items } = (await malware.json()) as { items: Named[] };
    await deleteEach(request, headers, `${API_BASE}/api/admin/malicious-packages`, items.filter((item) => item.name?.startsWith(PREFIX)).map((item) => item.id));
  }

  const hooks = await request.get(`${API_BASE}/api/admin/webhooks`, { headers });
  if (hooks.ok()) {
    const items = (await hooks.json()) as Named[];
    await deleteEach(request, headers, `${API_BASE}/api/admin/webhooks`, items.filter((item) => item.url?.includes(PREFIX)).map((item) => item.id));
  }

  const repos = await request.get(`${API_BASE}/api/admin/repositories`, { headers });
  if (repos.ok()) {
    const items = (await repos.json()) as Named[];
    await deleteEach(request, headers, `${API_BASE}/api/admin/repositories`, items.filter((item) => item.key?.startsWith(PREFIX)).map((item) => item.id));
  }

  const accounts = await request.get(`${API_BASE}/api/admin/service-accounts?limit=200&search=${PREFIX}`, { headers });
  if (accounts.ok()) {
    const { items } = (await accounts.json()) as { items: Named[] };
    await deleteEach(request, headers, `${API_BASE}/api/admin/service-accounts`, items.filter((item) => item.name?.startsWith(PREFIX)).map((item) => item.id));
  }

  const users = await request.get(`${API_BASE}/api/admin/users?limit=200&search=${PREFIX}`, { headers });
  if (users.ok()) {
    const { items } = (await users.json()) as { items: Named[] };
    const disposable = items.filter(
      (item) => item.email?.startsWith(`${PREFIX}invite-`) || item.email?.startsWith(`${PREFIX}extra-`) || item.email?.startsWith(`${PREFIX}sso-`)
    );
    await deleteEach(request, headers, `${API_BASE}/api/admin/users`, disposable.map((item) => item.id));
  }

  const providers = await request.get(`${API_BASE}/api/admin/sso-providers`, { headers });
  if (providers.ok()) {
    const items = (await providers.json()) as Named[];
    await deleteEach(request, headers, `${API_BASE}/api/admin/sso-providers`, items.filter((item) => item.name?.startsWith(PREFIX)).map((item) => item.id));
  }
}
