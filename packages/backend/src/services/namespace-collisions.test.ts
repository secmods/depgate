import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

const state = vi.hoisted(() => ({ enabled: false, policies: [] as unknown[], rows: [] as unknown[], saved: [] as unknown[], webhooks: [] as unknown[] }));

vi.mock('./gateway-config.js', () => ({ getNamespaceCollisionCheck: vi.fn(async () => state.enabled) }));
vi.mock('./policy-engine.js', async (orig) => ({
  ...(await orig<object>()),
  getCompiledPolicies: vi.fn(async () => state.policies),
}));
import { collisionLookup, reservingPolicies, runCollisionCheck } from './namespace-collisions.js';
import { bindPublisher } from './events/record.js';
import type { EventEnvelope } from './events/envelope.js';

const published: EventEnvelope[] = [];
bindPublisher((envelope, _json, webhookPayload) => {
  published.push(envelope);
  if (webhookPayload) state.webhooks.push(webhookPayload);
});
import { compilePolicy } from './policy-engine.js';
import type { Policy } from '../db/entities/Policy.js';

const POLICY = compilePolicy({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'acme-npm',
  decision: 'BLOCK',
  conditions: { ecosystem: ['npm'], reservedNamespaces: ['@acme'], publicPackages: ['@acme/eslint-config'] },
  priority: 1,
  isEnabled: true,
  mode: 'enforce',
  modeChangedAt: null,
  repositoryIds: [],
} as unknown as Policy);

function fakeDb(): DataSource {
  const existing: Array<Record<string, unknown>> = [];
  return {
    query: vi.fn(async () => state.rows),
    getRepository: () => ({
      findOne: async ({ where }: { where: Record<string, unknown> }) =>
        existing.find((row) => row.name === where.name && row.policyId === where.policyId) ?? null,
      create: (row: Record<string, unknown>) => row,
      insert: async () => undefined,
      save: async (row: Record<string, unknown>) => {
        if (!existing.includes(row)) existing.push(row);
        state.saved.push(row);
        return row;
      },
    }),
  } as unknown as DataSource;
}

beforeEach(() => {
  state.enabled = false;
  state.policies = [POLICY];
  state.rows = [
    { ecosystem: 'npm', package_name: '@acme/billing' },
    { ecosystem: 'npm', package_name: '@acme/eslint-config' },
    { ecosystem: 'npm', package_name: '@acme/internal-only' },
  ];
  state.saved = [];
  state.webhooks = [];
  published.length = 0;
});

describe('namespace collision check (§9)', () => {
  it('with the setting off, sends nothing anywhere', async () => {
    const fetchImpl = vi.fn();
    const db = fakeDb();
    const result = await runCollisionCheck(db, { fetchImpl: fetchImpl as never, delayMs: 0 });
    expect(result.skipped).toBe('off');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('with it on, asks the public registry about reserved names only, records collisions once and fires the webhook', async () => {
    state.enabled = true;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/@acme%2fbilling')) return new Response(JSON.stringify({ 'dist-tags': { latest: '9.9.9' } }), { status: 200 });
      return new Response('{}', { status: 404 });
    });
    const db = fakeDb();
    const options = { fetchImpl: fetchImpl as never, delayMs: 0, publicBase: () => 'http://public.test' };
    const first = await runCollisionCheck(db, options);
    expect(first).toMatchObject({ skipped: null, checked: 2, found: 1, created: 1 });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['http://public.test/@acme%2fbilling', 'http://public.test/@acme%2finternal-only']);
    expect(state.saved[0]).toMatchObject({ name: '@acme/billing', publicLatestVersion: '9.9.9', policyId: POLICY.id });
    expect(state.webhooks).toEqual([expect.objectContaining({ event: 'namespace_collision', packageName: '@acme/billing', policyName: 'acme-npm' })]);
    // The webhook rides on a NAMESPACE_COLLISION_FOUND audit event (requirements_event_streaming.md §6.3).
    expect(published).toEqual([
      expect.objectContaining({ type: 'NAMESPACE_COLLISION_FOUND', category: 'audit', feature: 'namespace', severity: 'warning' }),
    ]);

    const second = await runCollisionCheck(db, options);
    expect(second.created).toBe(0);
    expect(state.webhooks).toHaveLength(1);
  });

  it('builds the lookup URL each ecosystem documents', () => {
    const url = (eco: string, name: string) => collisionLookup(eco, name, 'https://reg.test/')?.url;
    expect(url('npm', '@acme/billing')).toBe('https://reg.test/@acme%2fbilling');
    expect(url('pypi', 'acme-auth')).toBe('https://reg.test/pypi/acme-auth/json');
    expect(url('go', 'github.com/acme/svc')).toBe('https://reg.test/github.com/acme/svc/@v/list');
    expect(url('maven', 'com.acme:core')).toBe('https://reg.test/com/acme/core/maven-metadata.xml');
    expect(url('nuget', 'Acme.Billing')).toBe('https://reg.test/v3-flatcontainer/acme.billing/index.json');
    expect(url('cargo', 'acme-core')).toBe('https://reg.test/api/v1/crates/acme-core');
    expect(url('composer', 'acme/billing')).toBe('https://reg.test/p2/acme/billing.json');
    expect(url('rubygems', 'acme_billing')).toBe('https://reg.test/api/v1/gems/acme_billing.json');
  });

  it('a name in publicPackages is not a collision', () => {
    expect(reservingPolicies([POLICY], 'npm', '@acme/eslint-config')).toEqual([]);
    expect(reservingPolicies([POLICY], 'npm', '@acme/billing')).toEqual([POLICY]);
  });

  it('paces lookups per public registry host', async () => {
    state.enabled = true;
    state.rows = [
      { ecosystem: 'npm', package_name: '@acme/one' },
      { ecosystem: 'npm', package_name: '@acme/two' },
      { ecosystem: 'npm', package_name: '@acme/three' },
    ];
    const at: number[] = [];
    const fetchImpl = vi.fn(async () => {
      at.push(Date.now());
      return new Response('{}', { status: 404 });
    });
    await runCollisionCheck(fakeDb(), { fetchImpl: fetchImpl as never, delayMs: 80, publicBase: () => 'http://public.test' });
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(75);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(75);
  });
});
