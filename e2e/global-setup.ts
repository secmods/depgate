/**
 * Ensures an admin can sign in, prepares a User account, and clears qa-e2e data from an interrupted run.
 * Credentials: E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD, or admin@depgate.local / admin.
 */
import { request } from '@playwright/test';
import { adminPassword, adminUser, cleanupQa, ensureUser, writeUser } from './support';

async function globalSetup(): Promise<void> {
  const ctx = await request.newContext();
  try {
    await cleanupQa(ctx);
    writeUser(await ensureUser(ctx));
  } catch {
    writeUser({ email: adminUser, password: adminPassword, available: false });
  } finally {
    await ctx.dispose();
  }
}

export default globalSetup;
