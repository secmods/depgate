import type { FastifyReply } from 'fastify';
import { config } from '../config.js';

export type VersionBlockNotice = {
  policyId?: string | null;
  policyName?: string | null;
  reasons?: string[] | null;
  remediation?: string | null;
};

/** Sentence clients show for a blocked version. Keeps the word "blocked" for matchers. */
export function blockedVersionMessage(block: VersionBlockNotice): string {
  const policy = block.policyName?.trim();
  const reasons = (block.reasons ?? []).map((reason) => reason.trim()).filter(Boolean);
  const reasonText = reasons.length > 0 ? `: ${reasons.join('; ')}` : '';
  const who = policy ? `policy "${policy}"` : 'DepGate policy';
  const fix = block.remediation?.trim();
  return `Package blocked by ${who}${reasonText}.${fix ? ` ${fix}` : ''}`;
}

/** What was blocked, for a link to the Package check page. */
export type CheckTarget = {
  ecosystem: string;
  packageName: string;
  version: string;
  repository?: string;
};

/** The Package check page filled in with the blocked package, so the client can print a link. */
export function packageCheckUrl(target: CheckTarget): string {
  const params = new URLSearchParams({ ecosystem: target.ecosystem, package: target.packageName });
  if (target.version) params.set('version', target.version);
  if (target.repository && target.repository !== 'default') params.set('repository', target.repository);
  return `${config.ui.baseUrl.replace(/\/$/, '')}/package-check?${params.toString()}`;
}

/**
 * HTTP/1.1 reason phrase. Go, Maven, NuGet, current pip, and RubyGems print this
 * and ignore a JSON body. HTTP/2 has no reason phrase; the JSON body covers those.
 */
export function policyStatusPhrase(message: string): string {
  const cleaned = message.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Package blocked by policy').slice(0, 180);
}

export function policyDenialBody(block: VersionBlockNotice, check?: CheckTarget): {
  error: string;
  title: string;
  status: number;
  detail: string;
  errors: Array<{ detail: string }>;
  policyId: string | null;
  policyName: string | null;
  reasons: string[];
  remediation: string | null;
  checkUrl?: string;
} {
  const message = blockedVersionMessage(block);
  const body = {
    error: message,
    title: 'Package blocked by policy',
    status: 403,
    detail: message,
    errors: [{ detail: message }],
    policyId: block.policyId ?? null,
    policyName: block.policyName ?? null,
    reasons: block.reasons ?? [],
    remediation: block.remediation ?? null,
  };
  return check ? { ...body, checkUrl: packageCheckUrl(check) } : body;
}

/**
 * 403 whose status line and body are the policy sentence each client prints.
 * npm inserts both the reason phrase and `body.error` around the tarball URL,
 * so pass a short `statusMessage` there and leave the sentence in the body.
 */
export function sendPolicyDenial(
  reply: FastifyReply,
  block: VersionBlockNotice,
  opts?: { statusMessage?: string; check?: CheckTarget }
): FastifyReply {
  const message = blockedVersionMessage(block);
  const phrase = policyStatusPhrase(opts?.statusMessage ?? message);
  reply.header('X-Error-Message', phrase);
  reply.header('Cache-Control', 'no-store');
  reply.code(403);
  reply.raw.statusMessage = phrase;
  return reply.type('application/json; charset=utf-8').send(policyDenialBody(block, opts?.check));
}
