import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeEventDb } from '../../test-support/event-db.js';
import { noteActor, noteDownloadFacts, noteServedSource, runWithRequest } from '../request-context.js';
import { maliciousResult, type PolicyResult } from '../policy-engine.js';
import { namespaceBlockResult } from '../namespace-protection.js';
import { publishMonitorMatches } from '../monitor-recorder.js';
import { bindPublisher } from './record.js';
import type { EventEnvelope } from './envelope.js';
import { recordDownloadAllowed, recordDownloadBlocked, reasonFacts } from './download-events.js';
import { pendingCountsForTest, resetSummaryState } from './summary.js';

type Published = { envelope: EventEnvelope; webhook?: Record<string, unknown> };

describe('download events (§6.4, §8.5)', () => {
  let events: ReturnType<typeof fakeEventDb>;
  const published: Published[] = [];
  const CI = { kind: 'ci_token' as const, id: 't1', name: 'payments-api-build', ip: '10.0.0.9', userAgent: 'npm/10', authMethod: 'ci_token', metadata: { buildId: '8812' } };
  const MALWARE = { id: 'MAL-2025-46974', source: 'feed' as const, reason: 'MAL-2025-46974', override: 'BLOCK' as const };

  beforeEach(() => {
    events = fakeEventDb();
    published.length = 0;
    resetSummaryState();
    bindPublisher((envelope, _json, webhook) => void published.push({ envelope, webhook }));
  });

  afterEach(() => bindPublisher(null));

  /** Runs `fn` inside a package request: repository `prod`, served by npm/default, by a CI token. */
  function inRequest<T>(fn: () => T, facts?: Parameters<typeof noteDownloadFacts>[0]): T {
    const raw = { depgateRepoKey: 'prod' };
    noteActor(raw, CI);
    return runWithRequest(raw, () => {
      noteServedSource({ sourceRepository: 'npm/default', sourceType: 'public' });
      if (facts) noteDownloadFacts(facts);
      return fn();
    });
  }

  const subject = { ecosystem: 'npm', packageName: 'event-stream', version: '3.3.6' };
  const types = () => published.map((row) => row.envelope.type);

  it('a blocked malware download: BLOCK_ENFORCE ledger row tagged malware, and MALWARE_REQUESTED with outcome blocked', async () => {
    inRequest(() => recordDownloadBlocked({ db: events.db }, subject, maliciousResult('MAL-2025-46974', 'event-stream'), { webhookPayload: { event: 'package_blocked', timestamp: 't' } }), { malware: MALWARE });
    await events.flush();
    expect(types()).toEqual(['BLOCK_ENFORCE', 'MALWARE_REQUESTED']);
    expect(events.ledger).toHaveLength(1);
    expect(events.ledger[0]).toMatchObject({ decision: 'BLOCK_ENFORCE', malware: true, repository: 'prod', requester: 'payments-api-build', authMethod: 'ci_token', actorMetadata: { buildId: '8812' } });
    expect(events.ledger[0].details).toMatchObject({ source: { repository: 'npm/default', type: 'public' }, malware: { id: 'MAL-2025-46974', source: 'feed' }, advisories: ['MAL-2025-46974'] });
    const malware = published[1];
    expect(malware.envelope.details).toMatchObject({ outcome: 'blocked' });
    expect(malware.webhook).toMatchObject({ event: 'malware_requested', decision: 'BLOCK', malware: { id: 'MAL-2025-46974', source: 'feed' }, repository: 'prod' });
  });

  it('a malware download let through by an override is stored as an ALLOW ledger row, the one exception to D1', async () => {
    inRequest(() => recordDownloadAllowed({ db: events.db }, subject, null), { malware: { ...MALWARE, override: 'ALLOW' } });
    await events.flush();
    expect(types()).toEqual(['ALLOW', 'MALWARE_REQUESTED']);
    expect(events.ledger.map((row) => [row.decision, row.malware])).toEqual([['ALLOW', true]]);
    expect(published[1].envelope.details).toMatchObject({ outcome: 'allowed_by_override' });
    expect(published[1].webhook).toMatchObject({ event: 'malware_requested', decision: 'ALLOW' });
  });

  it('a malware download allowed by an exception names the exception without a lookup (R-P2)', async () => {
    inRequest(() => recordDownloadAllowed({ db: events.db }, subject, null), { malware: MALWARE, exception: { id: 'e1', reason: 'Vendored fork\nApproved by sec' } });
    await events.flush();
    expect(published[0].envelope).toMatchObject({ type: 'ALLOW', policy: { id: 'e1', name: 'Exception' }, reasons: ['Exception: Vendored fork'] });
    expect(published[1].envelope.details).toMatchObject({ outcome: 'allowed_by_exception' });
    expect(events.ledger.map((row) => row.decision)).toEqual(['ALLOW']);
  });

  it('an ordinary allowed download is counted and noted for usage, never stored', async () => {
    inRequest(() => recordDownloadAllowed({ db: events.db }, { ...subject, packageName: 'lodash', version: '4.17.21' }, null));
    await events.flush();
    expect(types()).toEqual(['ALLOW']);
    expect(events.ledger).toEqual([]);
    expect(pendingCountsForTest().counts.size).toBe(1);
  });

  it('a namespace block also raises DEPENDENCY_CONFUSION_BLOCKED with the reserved pattern', async () => {
    const block = namespaceBlockResult({ policyId: 'p-ns', policyName: 'acme-npm', pattern: '@acme', allowedRemoteIds: null } as never, 'npm', 'prod', '@acme/billing');
    inRequest(() => recordDownloadBlocked({ db: events.db }, { ecosystem: 'npm', packageName: '@acme/billing', version: '1.0.0' }, block));
    await events.flush();
    expect(types()).toEqual(['BLOCK_ENFORCE', 'DEPENDENCY_CONFUSION_BLOCKED']);
    expect(published[1].envelope.details).toMatchObject({ namespace: '@acme' });
    expect(published[1].webhook).toMatchObject({ event: 'dependency_confusion_blocked', namespace: '@acme', policyName: 'acme-npm' });
    expect(events.ledger).toHaveLength(1);
  });

  it('BLOCK_MONITOR: one event per matching Monitor policy, with the final decision when another policy enforces a block', async () => {
    const matches = [
      { policyId: 'm1', policyName: 'Monitor GPL', reasons: ['GPL-3.0'], reasonKey: 'GPL-3.0' },
      { policyId: 'm2', policyName: 'Monitor new', reasons: ['Published 2 days ago'], reasonKey: 'too_new' },
    ];
    inRequest(() => publishMonitorMatches(events.db, 'npm', 'left-pad', '1.3.0', matches, 'prod', { decision: 'BLOCK_ENFORCE', policyId: 'b1', policyName: 'Block CVSS 9' }));
    await events.flush();
    expect(published.map((row) => [row.envelope.type, row.envelope.policy?.name, row.envelope.details?.finalDecision])).toEqual([
      ['BLOCK_MONITOR', 'Monitor GPL', { decision: 'BLOCK_ENFORCE', policyId: 'b1', policyName: 'Block CVSS 9' }],
      ['BLOCK_MONITOR', 'Monitor new', { decision: 'BLOCK_ENFORCE', policyId: 'b1', policyName: 'Block CVSS 9' }],
    ]);
    expect(published[0].envelope.actor).toMatchObject({ kind: 'ci_token', name: 'payments-api-build' });
    expect(events.ledger).toEqual([]);
  });

  it('advisory, CVE and EPSS values of a block become structured fields (R-P3)', () => {
    const result: PolicyResult = {
      decision: 'BLOCK',
      policyId: 'p',
      policyName: 'EPSS',
      reasons: ['GHSA-abcd-efgh-ijkl (CVE-2024-1234): CVSS 3.1 7.5, EPSS 42.1 % (97th percentile, 2026-10-11)', '1 more vulnerability matches'],
    };
    expect(reasonFacts(result.reasons)).toEqual({
      advisories: ['GHSA-abcd-efgh-ijkl'],
      cves: ['CVE-2024-1234'],
      epss: [{ id: 'GHSA-abcd-efgh-ijkl', cve: 'CVE-2024-1234', score: 0.421 }],
    });
  });
});
