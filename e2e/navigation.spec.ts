import { test, expect, type Page } from '@playwright/test';
import { loadUser, signInAsAdmin, signInAsUser } from './support';

const SECURITY_LINKS = [
  'Dashboard',
  'Malware Packages',
  'Policies',
  'Package check',
  'Monitoring',
  'Exceptions',
  'Decision Ledger',
  'Audit Log',
  'Jobs & Feeds',
  'Registry',
  'Access',
  'Settings',
];

const SECURITY_PAGES: Array<{ link: string; heading: string; url: RegExp }> = [
  { link: 'Dashboard', heading: 'Security analytics', url: /\/dashboard$/ },
  { link: 'Malware Packages', heading: 'Malware packages', url: /\/malicious$/ },
  { link: 'Policies', heading: 'Policies', url: /\/policies$/ },
  { link: 'Package check', heading: 'Package check', url: /\/package-check$/ },
  { link: 'Monitoring', heading: 'Monitoring', url: /\/monitoring$/ },
  { link: 'Exceptions', heading: 'Exceptions', url: /\/exceptions$/ },
  { link: 'Decision Ledger', heading: 'Decision ledger', url: /\/audit$/ },
  { link: 'Audit Log', heading: 'Audit log', url: /\/audit\/log$/ },
  { link: 'Jobs & Feeds', heading: 'Jobs & feeds', url: /\/audit\/jobs$/ },
  { link: 'Registry', heading: 'Registry', url: /\/registry$/ },
  { link: 'Access', heading: 'Access', url: /\/access$/ },
  { link: 'Settings', heading: 'Settings', url: /\/settings$/ },
];

function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Main' });
}

/** Both roles: Documentation (when DOCS_URL is set) and API docs, in new tabs. */
async function expectHelpNav(page: Page): Promise<void> {
  const help = page.getByRole('navigation', { name: 'Help' });
  await expect(help.getByRole('link', { name: 'API docs' })).toHaveAttribute('href', '/api/docs');
  const docs = help.getByRole('link', { name: 'Documentation' });
  if (await docs.count()) await expect(docs).toHaveAttribute('href', /^https?:\/\//);
  for (const link of await help.getByRole('link').all()) await expect(link).toHaveAttribute('target', '_blank');
}

/** A nav link's name; Monitoring carries a count badge while a policy is monitoring. */
function navName(label: string): RegExp {
  return new RegExp(`^${label}( \\d+ monitoring)?$`);
}

test.describe('Navigation', () => {
  test('Security sidebar lists the product pages and Help, and each page loads', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await signInAsAdmin(page);
    const nav = mainNav(page);
    await expect(nav.getByRole('link')).toHaveCount(SECURITY_LINKS.length);
    for (const label of SECURITY_LINKS) {
      await expect(nav.getByRole('link', { name: navName(label) })).toBeVisible();
    }
    await expectHelpNav(page);

    for (const item of SECURITY_PAGES) {
      await test.step(item.link, async () => {
        await nav.getByRole('link', { name: navName(item.link) }).click();
        await expect(page).toHaveURL(item.url);
        await expect(page.getByRole('heading', { name: item.heading, exact: true })).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
      });
    }
    expect(errors).toEqual([]);
  });

  test('User sidebar lists Package check, Registry and Waiver requests, and Help', async ({ page }) => {
    test.skip(!loadUser().available, 'No User account is available');
    await signInAsUser(page);
    const nav = mainNav(page);
    await expect(nav.getByRole('link')).toHaveCount(3);
    await expectHelpNav(page);
    for (const label of ['Package check', 'Registry', 'Waiver requests']) {
      await nav.getByRole('link', { name: navName(label) }).click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Policies' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Access' })).toHaveCount(0);
  });

  test('a User is sent home from every Security address', async ({ page }) => {
    test.skip(!loadUser().available, 'No User account is available');
    await signInAsUser(page);
    for (const path of ['/dashboard', '/policies', '/monitoring', '/monitoring/1', '/exceptions', '/audit', '/audit/log', '/audit/jobs', '/malicious', '/settings', '/access']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/registry/);
      await expect(page.getByRole('heading', { name: 'Security analytics' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Policies', exact: true })).toHaveCount(0);
    }
  });

  test('Security is sent home from the User waiver page', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/waivers');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Waiver requests' })).toHaveCount(0);
  });
});
