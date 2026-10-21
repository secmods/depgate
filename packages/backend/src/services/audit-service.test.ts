import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logAudit, getRequestContext } from './audit-service.js';
import { noteActor, runWithRequest } from './request-context.js';
import { ledgerRowsLostTotal } from './jobs/metrics.js';
import { fakeEventDb } from '../test-support/event-db.js';
import { bindPublisher } from './events/record.js';
import type { EventEnvelope } from './events/envelope.js';

/** logAudit is the adapter from the old ledger entry shape onto recordEvent (requirements_event_streaming.md Appendix A). */
describe('audit-service (logAudit adapter)', () => {
  let events: ReturnType<typeof fakeEventDb>;
  const published: EventEnvelope[] = [];

  beforeEach(() => {
    events = fakeEventDb();
    published.length = 0;
    bindPublisher((envelope) => void published.push(envelope));
  });

  afterEach(() => bindPublisher(null));

  it('records a block in the Decision Ledger as BLOCK_ENFORCE, with the repository of the request being served', async () => {
    const entry = { ecosystem: 'npm', packageName: 'lodash', resolvedVersion: '4.17.21', decision: 'BLOCK' };
    await runWithRequest({ depgateRepoKey: 'qa-repo' }, () => logAudit(events.db, entry));
    await logAudit(events.db, entry);
    await runWithRequest({ depgateRepoKey: 'qa-repo' }, () => logAudit(events.db, { ...entry, repository: 'all' }));
    await events.flush();
    expect(events.ledger.map((row) => [row.decision, row.repository])).toEqual([
      ['BLOCK_ENFORCE', 'qa-repo'],
      ['BLOCK_ENFORCE', null],
      ['BLOCK_ENFORCE', 'all'],
    ]);
  });

  it('keeps a uuid policy id and drops a synthetic one', async () => {
    await logAudit(events.db, { ecosystem: 'npm', packageName: 'a', decision: 'BLOCK', policyId: 'malicious', policyName: 'Malicious packages list' });
    await logAudit(events.db, { ecosystem: 'npm', packageName: 'b', decision: 'BLOCK', policyId: '123e4567-e89b-42d3-a456-426614174000', policyName: 'P' });
    await events.flush();
    expect(events.ledger.map((row) => row.policyId)).toEqual([null, '123e4567-e89b-42d3-a456-426614174000']);
    expect(events.ledger[0].policyName).toBe('Malicious packages list');
  });

  it('never stores an allowed download row by row (D1)', async () => {
    await logAudit(events.db, { ecosystem: 'npm', packageName: 'lodash', resolvedVersion: '4.17.21', decision: 'ALLOW' });
    await events.flush();
    expect(events.ledger).toEqual([]);
    expect(published.map((event) => event.type)).toEqual(['ALLOW']);
  });

  it('writes admin events to the Audit Log with the actor of the request and a target (Appendix A)', async () => {
    const raw = { depgateRepoKey: undefined } as object;
    noteActor(raw, { kind: 'user', id: 'u1', name: 'sec@acme.test', ip: '10.0.0.5', userAgent: 'Mozilla', authMethod: 'oidc' });
    await runWithRequest(raw as never, () =>
      logAudit(events.db, {
        requester: 'sec@acme.test',
        requesterIp: '10.0.0.5',
        ecosystem: 'policy',
        packageName: 'Block GPL',
        decision: 'POLICY_UPDATED',
        policyId: 'p-1',
        conditionReasons: ['Changed priority from 10 to 5'],
      })
    );
    expect(events.audit).toHaveLength(1);
    expect(events.audit[0]).toMatchObject({
      type: 'POLICY_UPDATED',
      actorKind: 'user',
      actorId: 'u1',
      actorName: 'sec@acme.test',
      actorAuthMethod: 'oidc',
      targetKind: 'policy',
      targetId: 'p-1',
      targetName: 'Block GPL',
      summary: 'Changed priority from 10 to 5',
    });
    expect(events.ledger).toEqual([]);
  });

  it('renames old types (§6.2) and maps the old ecosystem to a target kind', async () => {
    await logAudit(events.db, { ecosystem: 'npm', packageName: 'evil', resolvedVersion: '1.0.0', decision: 'MALICIOUS_OVERRIDE_ALLOW', conditionReasons: ['False positive'] });
    await logAudit(events.db, { ecosystem: 'config', packageName: 'jobs/epss-sync', decision: 'CONFIG_UPDATED', conditionReasons: ['Run now'] });
    await logAudit(events.db, { ecosystem: 'config', packageName: 'gateway', decision: 'CONFIG_UPDATED', conditionReasons: ['namespaceCollisionCheck: true'] });
    expect(events.audit.map((row) => [row.type, row.targetKind, row.targetName])).toEqual([
      ['MALWARE_OVERRIDE_ALLOW', 'malware_entry', 'evil'],
      ['JOB_RUN_REQUESTED', 'job', 'epss-sync'],
      ['NAMESPACE_SETTINGS_UPDATED', 'setting', 'namespace'],
    ]);
    expect(published.map((event) => event.severity)).toEqual(['warning', 'notice', 'notice']);
  });

  it('drops feed sync rows (D3): Jobs & Feeds shows the runs', async () => {
    await logAudit(events.db, { ecosystem: 'malicious', packageName: 'malicious-feed', decision: 'MALICIOUS_SYNC' });
    await logAudit(events.db, { ecosystem: 'epss', packageName: 'epss-feed', decision: 'EPSS_SYNC_FAILED' });
    await events.flush();
    expect(events.audit).toEqual([]);
    expect(events.ledger).toEqual([]);
    expect(published).toEqual([]);
  });

  it('counts and logs a ledger batch lost to a dropped connection (never silent)', async () => {
    const before = (await ledgerRowsLostTotal.get()).values.find((value) => value.labels.decision === 'BLOCK_ENFORCE')?.value ?? 0;
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => void errors.push(line);
    try {
      events.failNext(new Error('Connection terminated unexpectedly'));
      await logAudit(events.db, { ecosystem: 'npm', packageName: 'lodash', decision: 'BLOCK' });
      await events.flush();
    } finally {
      console.error = original;
    }
    const after = (await ledgerRowsLostTotal.get()).values.find((value) => value.labels.decision === 'BLOCK_ENFORCE')?.value ?? 0;
    expect(after - before).toBe(1);
    expect(errors.join('\n')).toContain('Decision Ledger row lost');
  });

  it('getRequestContext reads ip, user agent and the user name', () => {
    const ctx = getRequestContext({ ip: '1.2.3.4', headers: { 'user-agent': 'npm/10' }, user: { username: 'a@b.c' } } as never);
    expect(ctx).toEqual({ reqIp: '1.2.3.4', userAgent: 'npm/10', requester: 'a@b.c' });
  });
});
