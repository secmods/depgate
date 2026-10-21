import 'reflect-metadata';
import { vi } from 'vitest';

// Integration tests should not perform real outbound webhook HTTP calls.
const runIntegration = (process.env.RUN_INTEGRATION ?? '').toLowerCase().trim();
const isIntegrationRun = runIntegration === '1' || runIntegration === 'true' || runIntegration === 'yes' || runIntegration === 'on';

if (isIntegrationRun) {
  // Keep integration suites deterministic: disable scheduled malicious-feed sync,
  // which can asynchronously import package blocks and race with policy assertions.
  process.env.MALICIOUS_SYNC_INTERVAL_HOURS = '0';
  // Nor the EPSS schedule or startup download; suites run the sync themselves against a stub.
  process.env.EPSS_SYNC_INTERVAL_HOURS = '0';
  // Suites call the monitor retention purge themselves.
  process.env.MONITOR_PURGE_INTERVAL_MINUTES = '0';
  process.env.NAMESPACE_COLLISION_INTERVAL_HOURS = '0';
  // Own queue keys, so a gateway running against the same Redis (docker compose) never takes a test's jobs.
  process.env.QUEUE_PREFIX = process.env.QUEUE_PREFIX || 'depgate-test';
  // Suites sign in by trying several admin passwords; the failures must not lock later suites out.
  // The sign-in limit test turns the limits on for itself.
  process.env.LOGIN_FAILURE_LIMIT_PER_IP = process.env.LOGIN_FAILURE_LIMIT_PER_IP || '0';
  process.env.LOGIN_FAILURE_LIMIT_PER_EMAIL = process.env.LOGIN_FAILURE_LIMIT_PER_EMAIL || '0';

  // Cover both specifier styles used by ts/esm transforms. doMock, not mock: Vitest hoists vi.mock out of this block.
  vi.doMock('./src/services/webhook-service.js', async () => {
    const actual = await vi.importActual<typeof import('./src/services/webhook-service.js')>('./src/services/webhook-service.js');
    return { ...actual, deliverWebhooks: vi.fn().mockResolvedValue(undefined), deliverFromStream: vi.fn().mockResolvedValue(undefined) };
  });
  vi.doMock('./src/services/webhook-service.ts', async () => {
    const actual = await vi.importActual<typeof import('./src/services/webhook-service.ts')>('./src/services/webhook-service.ts');
    return { ...actual, deliverWebhooks: vi.fn().mockResolvedValue(undefined), deliverFromStream: vi.fn().mockResolvedValue(undefined) };
  });
}
