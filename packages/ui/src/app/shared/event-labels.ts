import type { Tone } from './status';

/** Decision Ledger events in the words of the policy form (requirements_event_streaming.md §6.2). */
export const DECISION_LABELS: Record<string, string> = {
  BLOCK_ENFORCE: 'Block · Enforce',
  BLOCK_MONITOR: 'Block · Monitor',
  ALLOW: 'Allow',
  UPSTREAM_UNAVAILABLE: 'Upstream unavailable',
  QUARANTINE: 'Quarantined (before 2026-10-09)',
  INTEGRITY_VIOLATION: 'Integrity violation (before 2026-10-18)',
};

export function decisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? decision;
}

export function decisionTone(decision: string): Tone {
  if (decision === 'ALLOW') return 'success';
  if (decision === 'BLOCK_MONITOR') return 'warning';
  if (decision === 'UPSTREAM_UNAVAILABLE' || decision === 'QUARANTINE') return 'warning';
  return 'danger';
}

/** Material icon per Audit Log target kind. */
export const TARGET_ICONS: Record<string, string> = {
  policy: 'policy',
  user: 'person',
  repository: 'storage',
  upstream_registry: 'cloud',
  exception: 'rule',
  waiver: 'approval',
  malware_entry: 'bug_report',
  package: 'deployed_code',
  setting: 'settings',
  sso_provider: 'key',
  webhook: 'webhook',
  stream_destination: 'conversion_path',
  job: 'schedule',
  ci_token: 'token',
  api_key: 'vpn_key',
  service_account: 'smart_toy',
};

export const TARGET_KINDS: Array<{ value: string; label: string }> = [
  { value: 'policy', label: 'Policy' },
  { value: 'exception', label: 'Exception' },
  { value: 'waiver', label: 'Waiver' },
  { value: 'malware_entry', label: 'Malware entry' },
  { value: 'package', label: 'Package' },
  { value: 'user', label: 'User' },
  { value: 'sso_provider', label: 'Identity provider' },
  { value: 'service_account', label: 'Service account' },
  { value: 'api_key', label: 'API key' },
  { value: 'ci_token', label: 'CI token' },
  { value: 'repository', label: 'Repository' },
  { value: 'upstream_registry', label: 'Upstream registry' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'stream_destination', label: 'Log streaming destination' },
  { value: 'setting', label: 'Setting' },
  { value: 'job', label: 'Job' },
];

export const JOB_LABELS: Record<string, string> = {
  'namespace-collision-check': 'Namespace collision check',
  'malicious-feed-sync': 'Malicious feed sync',
  'monitor-retention-purge': 'Monitoring and history retention',
  'epss-sync': 'EPSS scores sync',
  'event-retention-purge': 'Ledger and audit retention',
  'event-migration': 'Copy of older events',
};

export function jobLabel(job: string): string {
  return JOB_LABELS[job] ?? job;
}

/** `1.2 s`, `3 min 4 s`. */
export function durationLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

/** The Build column (§10.2): first of buildId, build, pipeline, runId, else the CI token name. */
export function metadataLine(metadata: Record<string, string> | null | undefined): string {
  return Object.entries(metadata ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}
