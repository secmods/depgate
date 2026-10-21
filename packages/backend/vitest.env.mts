/** Shared by vitest.config.mts and vitest.global-setup.ts, so both name the same integration database. */

export function isIntegrationRun(): boolean {
  const value = (process.env.RUN_INTEGRATION ?? '').toLowerCase().trim();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** `${DB_NAME}_test`, or TEST_DB_NAME. Never the developer's own database. */
export function testDatabaseName(): string {
  return process.env.TEST_DB_NAME || `${process.env.DB_NAME || 'depgate'}_test`;
}
