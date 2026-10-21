export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';

/** Package ecosystems the gateway serves, in display order. */
export const ECOSYSTEMS = ['npm', 'pypi', 'go', 'maven', 'nuget', 'cargo', 'composer', 'rubygems'] as const;

const ECOSYSTEM_LABELS: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  go: 'Go',
  maven: 'Maven',
  nuget: 'NuGet',
  cargo: 'Cargo',
  'crates.io': 'crates.io',
  composer: 'Composer',
  rubygems: 'RubyGems',
  policy: 'Policy',
  malicious: 'Malware feed',
  api_key: 'API key',
  webhook: 'Webhook',
  config: 'Config',
  auth: 'Sign-in',
  user: 'User',
  sso: 'Single sign-on',
};

export function ecosystemLabel(ecosystem: string | null | undefined): string {
  if (!ecosystem) return '—';
  return ECOSYSTEM_LABELS[ecosystem] ?? ecosystem;
}

export function isPackageEcosystem(ecosystem: string | null | undefined): boolean {
  return !!ecosystem && (ECOSYSTEMS as readonly string[]).includes(ecosystem);
}

// One mapping for every status the API returns, so a value reads the same everywhere.
const SUCCESS = new Set([
  'SUCCEEDED', 'COMPLETED', 'HEALTHY', 'SIGNIN_SUCCEEDED',
  'ALLOW', 'APPROVED', 'ACTIVE', 'ENABLED', 'EXCEPTION_ADDED',
  'MALICIOUS_OVERRIDE_ALLOW', 'WAIVER_APPROVED', 'LOGIN_SUCCEEDED', 'USER_ENABLED',
]);
const DANGER = new Set([
  'BLOCK_ENFORCE', 'MALWARE_REQUESTED', 'DEPENDENCY_CONFUSION_BLOCKED', 'SIGNIN_FAILED', 'AUTH_FAILED',
  'BLOCK', 'BLOCKED', 'REJECTED', 'EXCEPTION_REVOKED', 'MALICIOUS_OVERRIDE_BLOCK',
  'MALICIOUS_SYNC_FAILED', 'WAIVER_REJECTED', 'FAILED', 'UPSTREAM_UNAVAILABLE', 'LOGIN_FAILED', 'USER_DISABLED',
  'DISABLED',
]);
const WARNING = new Set(['PENDING', 'WAIVER_REQUESTED', 'BLOCK_MONITOR', 'RETRYING', 'RUNNING']);
const INFO = new Set([
  'POLICY_CREATED', 'POLICY_UPDATED', 'POLICY_DELETED', 'MALICIOUS_ADDED', 'MALICIOUS_DELETED', 'MALICIOUS_SYNC',
  'MALICIOUS_OVERRIDE_TO_CUSTOM', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'CI_TOKEN_CREATED', 'CI_TOKEN_REVOKED',
  'WEBHOOK_CREATED', 'WEBHOOK_DELETED', 'UPSTREAM_REGISTRY_CREATED', 'UPSTREAM_REGISTRY_DELETED', 'CONFIG_UPDATED',
  'USER_CREATED', 'USER_DELETED', 'USER_PROVISIONED', 'IDENTITY_LINKED', 'USER_ROLE_CHANGED', 'SESSIONS_REVOKED',
  'SSO_PROVIDER_CREATED', 'SSO_PROVIDER_UPDATED', 'SSO_PROVIDER_DELETED', 'SIGNIN_SETTINGS_UPDATED',
  'ARTIFACT_CACHE_PURGED', 'ARTIFACT_CACHE_SETTINGS_UPDATED',
]);

export function statusTone(value: string | null | undefined): Tone {
  const key = (value ?? '').toUpperCase();
  if (SUCCESS.has(key)) return 'success';
  if (DANGER.has(key)) return 'danger';
  if (WARNING.has(key)) return 'warning';
  if (INFO.has(key)) return 'info';
  return 'neutral';
}

const LABELS: Record<string, string> = {
  ALLOW: 'Allow',
  BLOCK: 'Block',
  BLOCK_ENFORCE: 'Block · Enforce',
  BLOCK_MONITOR: 'Block · Monitor',
};

/** WAIVER_APPROVED -> "Waiver approved", pending -> "Pending". */
export function statusLabel(value: string | null | undefined): string {
  if (!value) return '—';
  const key = value.toUpperCase();
  if (LABELS[key]) return LABELS[key];
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
