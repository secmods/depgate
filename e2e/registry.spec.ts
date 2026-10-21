import { test, expect, type Page } from '@playwright/test';
import { loadUser, signInAsAdmin, signInAsUser } from './support';

const ECOSYSTEMS: Array<{ button: RegExp; title: RegExp }> = [
  { button: /^np\s+npm$/, title: /npm · .+ configuration/ },
  { button: /PyPI$/, title: /pip · .+ configuration/ },
  { button: /Go$/, title: /Go · .+ configuration/ },
  { button: /Maven$/, title: /Maven · .+ configuration/ },
  { button: /NuGet$/, title: /NuGet · .+ configuration/ },
  { button: /Cargo$/, title: /Cargo · .+ configuration/ },
  { button: /Composer$/, title: /Composer · .+ configuration/ },
  { button: /RubyGems$/, title: /RubyGems · .+ configuration/ },
];

const PUBLIC_HOSTS = [
  'registry.npmjs.org',
  'files.pythonhosted.org',
  'pypi.org',
  'proxy.golang.org',
  'repo1.maven.org',
  'repo.maven.apache.org',
  'api.nuget.org',
  'crates.io',
  'repo.packagist.org',
  'rubygems.org',
];

async function expectGatewaySnippet(page: Page, title: RegExp): Promise<void> {
  const card = page.locator('section.dg-card').filter({ has: page.getByRole('heading', { name: title }) });
  await expect(card).toBeVisible();
  const snippet = card.locator('pre').first();
  const text = await snippet.innerText();
  for (const host of PUBLIC_HOSTS) {
    expect(text, `snippet should not point at ${host}`).not.toContain(host);
  }
  expect(text.length).toBeGreaterThan(10);
}

test.describe('Registry', () => {
  test('lists every ecosystem and the snippet points at this gateway', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/registry');
    await expect(page.getByRole('heading', { name: 'Registry' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy snippet' })).toBeVisible();

    for (const eco of ECOSYSTEMS) {
      await page.getByRole('button', { name: eco.button }).click();
      await expectGatewaySnippet(page, eco.title);
    }

    await page.getByRole('button', { name: 'Copy snippet' }).click();
    await expect(page.getByText('Copied to clipboard')).toBeVisible();
  });

  test('shows the signed-in user their own registry snippet', async ({ page }) => {
    test.skip(!loadUser().available, 'No User account is available');
    await signInAsUser(page);
    await expect(page.getByRole('heading', { name: 'Registry' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
    await page.getByRole('button', { name: /PyPI$/ }).click();
    await expectGatewaySnippet(page, /pip · .+ configuration/);
  });
});
