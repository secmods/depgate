import { test, expect } from '@playwright/test';
import { adminPassword, adminUser, loadUser, signInAsAdmin, signOut, submitLogin } from './support';

test.describe('Sign in and sign out', () => {
  test('asks for email and password, and offers a reset', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
    await expect(page.getByLabel('Username')).toHaveCount(0);
  });

  test('stays on the login page for a wrong password and for a username', async ({ page }) => {
    await page.goto('/login');
    await submitLogin(page, adminUser, 'not-the-password');
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
    await expect(page).toHaveURL(/\/login/);

    await submitLogin(page, 'admin', adminPassword);
    await expect(page.getByRole('alert')).toContainText('Incorrect email or password.');
    await expect(page).toHaveURL(/\/login/);
  });

  test('refuses an empty form before calling the server', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Enter your email and password.');
  });

  test('sends Security to the dashboard and signs out', async ({ page }) => {
    await signInAsAdmin(page);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toBeVisible();

    await signOut(page);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Security analytics' })).toHaveCount(0);
  });

  test('returns to a bookmarked Security page after sign-in', async ({ page }) => {
    await page.goto('/policies');
    await expect(page).toHaveURL(/\/login\?returnUrl=/);
    await submitLogin(page, adminUser, adminPassword);
    await expect(page).toHaveURL(/\/policies/);
    await expect(page.getByRole('heading', { name: 'Policies' })).toBeVisible();
  });

  test('forgot password asks for an email and answers the same either way', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();

    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('alert')).toContainText('Enter your email.');

    await page.getByLabel('Email').fill('qa-e2e-nobody@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If that address has an account');

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(adminUser);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByRole('status')).toContainText('If that address has an account');
  });

  test('rejects a set-password link with a bad or missing token', async ({ page }) => {
    await page.goto('/set-password?token=garbage');
    await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
    await expect(page).not.toHaveURL(/token=/);

    await page.goto('/set-password');
    await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Send me a new link' })).toBeVisible();
  });

  test('sends a User to Registry, and back to a bookmarked package check', async ({ page }) => {
    const user = loadUser();
    test.skip(!user.available, 'No User account is available');

    await page.goto('/login');
    await submitLogin(page, user.email, user.password);
    await expect(page).toHaveURL(/\/registry/);
    await expect(page.getByRole('heading', { name: 'Registry' })).toBeVisible();
    await signOut(page);

    await page.goto('/package-check?ecosystem=npm&package=lodash');
    await expect(page).toHaveURL(/\/login\?returnUrl=/);
    await submitLogin(page, user.email, user.password);
    await expect(page).toHaveURL(/\/package-check\?/);
    await expect(page.getByRole('heading', { name: 'lodash' })).toBeVisible({ timeout: 60_000 });
  });
});
