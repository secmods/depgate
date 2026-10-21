import type { DataSource } from 'typeorm';
import type { PolicyResult } from '../policy-engine.js';
import { namespaceBlockPattern } from '../namespace-protection.js';
import type { WebhookPayload } from '../webhook-service.js';
import {
  currentActor,
  currentDownloadFacts,
  currentRepository,
  currentServedSource,
  type EventActor,
  type NotedDownload,
} from '../request-context.js';
import type { EventTarget } from './envelope.js';
import { recordEvent } from './record.js';

/**
 * Events of a package download (requirements_event_streaming.md §6.4, §8.5), shared by the eight
 * ecosystem routes and the namespace guard. Everything the events need is read from the request in
 * flight before anything is awaited: the actor (with the CI token's metadata), the repository, the
 * remote that served the version, and the malware entry and exception the policy engine reported.
 */

type App = {
  db: DataSource;
  metrics?: { recordDecision?: (decision: string) => void };
};

export type DownloadSubject = {
  ecosystem: string;
  packageName: string;
  version: string | null;
  /** Defaults to the repository of the request being served. */
  repository?: string | null;
};

type Context = {
  actor: EventActor;
  target: EventTarget;
  source?: { repository: string; type: string };
  facts?: NotedDownload;
};

function context(subject: DownloadSubject): Context {
  const repository = subject.repository !== undefined ? subject.repository : (currentRepository() ?? null);
  const served = currentServedSource();
  return {
    actor: currentActor() ?? { kind: 'system', name: 'DepGate' },
    target: {
      kind: 'package',
      ecosystem: subject.ecosystem,
      name: subject.packageName,
      version: subject.version,
      repository,
    },
    source: served ? { repository: served.sourceRepository, type: served.sourceType } : undefined,
    facts: currentDownloadFacts(),
  };
}

/** Advisory, CVE and EPSS values named in a block's reasons, as structured fields (R-P3). */
export function reasonFacts(reasons: string[] | null | undefined): Record<string, unknown> {
  const text = (reasons ?? []).join('\n');
  const advisories = [...new Set(text.match(/\b(?:GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|MAL-\d{4}-\d+|PYSEC-\d{4}-\d+|RUSTSEC-\d{4}-\d+|GO-\d{4}-\d+|OSV-\d{4}-\d+)\b/gi) ?? [])];
  const cves = [...new Set(text.match(/\bCVE-\d{4}-\d{4,}\b/g) ?? [])];
  const epss: Array<{ id: string; cve?: string; score: number }> = [];
  for (const match of text.matchAll(/([A-Z]+-[\w-]+)(?: \((CVE-\d{4}-\d+)\))?:[^\n]*?EPSS ([\d.]+) ?%/g)) {
    epss.push({ id: match[1], ...(match[2] ? { cve: match[2] } : {}), score: Math.round(Number(match[3]) * 1000) / 100_000 });
  }
  return {
    ...(advisories.length ? { advisories } : {}),
    ...(cves.length ? { cves } : {}),
    ...(epss.length ? { epss } : {}),
  };
}

function malwareOf(ctx: Context, result: PolicyResult | null): NotedDownload['malware'] | undefined {
  if (ctx.facts?.malware) return ctx.facts.malware;
  // A request the engine evaluated without facts (Go .info/.mod, Maven POMs) still names a list block.
  if (result?.policyId === 'malicious') {
    const id = result.reasons.join(' ').match(/\bMAL-\d{4}-\d+\b/)?.[0];
    return { id: id ?? 'unknown', source: 'feed', reason: result.reasons[0] ?? null, override: 'BLOCK' };
  }
  return undefined;
}

function malwareDetail(malware: NonNullable<NotedDownload['malware']>): { id: string; source: string } {
  return { id: malware.id, source: malware.source };
}

function policyOf(result: PolicyResult | null): { id: string; name: string } | null {
  return result ? { id: result.policyId, name: result.policyName } : null;
}

type MalwareOutcome = 'blocked' | 'allowed_by_override' | 'allowed_by_exception' | 'allowed';

function malwarePayload(
  ctx: Context,
  malware: NonNullable<NotedDownload['malware']>,
  decision: 'BLOCK' | 'ALLOW',
  result: PolicyResult | null
): WebhookPayload {
  return {
    event: 'malware_requested',
    timestamp: new Date().toISOString(),
    ecosystem: ctx.target.ecosystem,
    packageName: ctx.target.name,
    version: ctx.target.version,
    repository: ctx.target.repository,
    decision,
    policyId: result?.policyId ?? null,
    policyName: result?.policyName ?? null,
    reasons: result?.reasons ?? (malware.reason ? [malware.reason] : []),
    malware: malwareDetail(malware),
  };
}

function raiseMalware(app: App, ctx: Context, malware: NonNullable<NotedDownload['malware']>, outcome: MalwareOutcome, result: PolicyResult | null): void {
  recordEvent(app.db, {
    type: 'MALWARE_REQUESTED',
    actor: ctx.actor,
    target: ctx.target,
    policy: policyOf(result),
    reasons: result?.reasons ?? (malware.reason ? [malware.reason] : null),
    details: { outcome, malware: malwareDetail(malware), ...(ctx.source ? { source: ctx.source } : {}) },
    webhookPayload: malwarePayload(ctx, malware, outcome === 'blocked' ? 'BLOCK' : 'ALLOW', result),
  });
}

/**
 * A refused download: a BLOCK_ENFORCE ledger row (and today's `package_blocked` webhook payload),
 * MALWARE_REQUESTED when the version is on the malware list, and DEPENDENCY_CONFUSION_BLOCKED when the
 * namespace guard refused it.
 */
export function recordDownloadBlocked(
  app: App,
  subject: DownloadSubject,
  result: PolicyResult,
  opts: { webhookPayload?: WebhookPayload } = {}
): void {
  const ctx = context(subject);
  const pattern = namespaceBlockPattern(result);
  const malware = malwareOf(ctx, result);
  const details: Record<string, unknown> = {
    ...(ctx.source ? { source: ctx.source } : {}),
    ...reasonFacts(result.reasons),
    ...(malware ? { malware: malwareDetail(malware) } : {}),
  };
  app.metrics?.recordDecision?.('BLOCK');
  recordEvent(app.db, {
    type: 'BLOCK_ENFORCE',
    actor: ctx.actor,
    target: ctx.target,
    policy: policyOf(result),
    reasons: result.reasons,
    details,
    malware: !!malware,
    webhookPayload: opts.webhookPayload,
  });
  if (malware) raiseMalware(app, ctx, malware, 'blocked', result);
  if (pattern) {
    recordEvent(app.db, {
      type: 'DEPENDENCY_CONFUSION_BLOCKED',
      actor: ctx.actor,
      target: ctx.target,
      policy: policyOf(result),
      reasons: result.reasons,
      details: { ...(pattern ? { namespace: pattern } : {}), ...(ctx.source ? { source: ctx.source } : {}) },
      webhookPayload: {
        event: 'dependency_confusion_blocked',
        timestamp: new Date().toISOString(),
        ecosystem: ctx.target.ecosystem,
        packageName: ctx.target.name,
        version: ctx.target.version,
        repository: ctx.target.repository,
        decision: 'BLOCK',
        policyId: result.policyId,
        policyName: result.policyName,
        reasons: result.reasons,
        namespace: pattern,
      },
    });
  }
}

/**
 * A served download: ALLOW (counted and noted for usage; stored only for a malware-listed version), named
 * by the Allow policy or the exception that let it through, from memory (R-P2).
 */
export function recordDownloadAllowed(app: App, subject: DownloadSubject, result: PolicyResult | null): void {
  const ctx = context(subject);
  const malware = ctx.facts?.malware;
  const exception = ctx.facts?.exception;
  const allowPolicy = result?.decision === 'ALLOW' ? result : null;
  let policy = policyOf(allowPolicy);
  let reasons = allowPolicy?.reasons ?? null;
  if (!policy && exception) {
    const line = exception.reason?.split('\n')[0]?.trim();
    policy = { id: exception.id, name: 'Exception' };
    reasons = [line ? `Exception: ${line}` : 'Allowed by an exception'];
  }
  const details: Record<string, unknown> = {
    ...(ctx.source ? { source: ctx.source } : {}),
    ...(exception ? { exception: { id: exception.id } } : {}),
    ...(malware ? { malware: malwareDetail(malware) } : {}),
  };
  app.metrics?.recordDecision?.('ALLOW');
  recordEvent(app.db, {
    type: 'ALLOW',
    actor: ctx.actor,
    target: ctx.target,
    policy,
    reasons,
    details,
    malware: !!malware,
  });
  if (malware) {
    const outcome: MalwareOutcome = malware.override === 'ALLOW' ? 'allowed_by_override' : exception ? 'allowed_by_exception' : 'allowed';
    raiseMalware(app, ctx, malware, outcome, allowPolicy);
  }
}
