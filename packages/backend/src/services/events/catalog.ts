/**
 * The event catalog (requirements_event_streaming.md §6.3): every event type DepGate records or streams,
 * grouped by the UI page it belongs to. The same groups and labels are the destination form, the Audit Log
 * filter, the event reference docs and the envelope's `feature` field.
 */

export type EventCategory = 'decision' | 'audit' | 'job';
export type Severity = 'info' | 'notice' | 'warning' | 'error';

export type CatalogEvent = {
  /** What a destination selection stores: the type, or `JOB_FAILED:<job>` / `JOB_SUCCEEDED:<job>` for job events. */
  key: string;
  type: string;
  label: string;
  category: EventCategory;
  severity: Severity;
  /** Selected by the Recommended preset. */
  default: boolean;
  /** ALLOW and BLOCK_MONITOR: published to the bulk stream, only when a destination selects them. */
  highVolume?: boolean;
};

export type CatalogGroup = {
  /** Tab name on pages with tabs (Access, Settings); undefined for a page without tabs. */
  tab?: string;
  events: CatalogEvent[];
};

export type CatalogFeature = {
  feature: string;
  label: string;
  groups: CatalogGroup[];
};

type Row = [type: string, label: string, category: EventCategory, severity: Severity, isDefault: boolean, highVolume?: boolean];

function ev([type, label, category, severity, isDefault, highVolume]: Row): CatalogEvent {
  return { key: type, type, label, category, severity, default: isDefault, ...(highVolume ? { highVolume } : {}) };
}

function jobEvents(job: string, failed: string, completed: string): CatalogEvent[] {
  return [
    { key: `JOB_FAILED:${job}`, type: 'JOB_FAILED', label: failed, category: 'job', severity: 'error', default: true },
    { key: `JOB_SUCCEEDED:${job}`, type: 'JOB_SUCCEEDED', label: completed, category: 'job', severity: 'info', default: false },
  ];
}

function group(rows: Row[], extra: CatalogEvent[] = [], tab?: string): CatalogGroup {
  return { ...(tab ? { tab } : {}), events: [...rows.map(ev), ...extra] };
}

/** In the order of the left navigation. */
export const CATALOG: CatalogFeature[] = [
  {
    feature: 'decisions',
    label: 'Decision ledger',
    groups: [
      group([
        ['BLOCK_ENFORCE', 'Block · Enforce', 'decision', 'warning', true],
        ['UPSTREAM_UNAVAILABLE', 'Upstream unavailable', 'decision', 'error', true],
        ['ALLOW', 'Allow', 'decision', 'info', false, true],
      ]),
    ],
  },
  {
    feature: 'monitoring',
    label: 'Monitoring',
    groups: [group([['BLOCK_MONITOR', 'Block · Monitor', 'decision', 'notice', false, true]])],
  },
  {
    feature: 'policies',
    label: 'Policies',
    groups: [
      group([
        ['POLICY_CREATED', 'Policy created', 'audit', 'notice', true],
        ['POLICY_UPDATED', 'Policy updated', 'audit', 'notice', true],
        ['POLICY_DELETED', 'Policy deleted', 'audit', 'notice', true],
      ]),
    ],
  },
  {
    feature: 'exceptions',
    label: 'Exceptions',
    groups: [
      group([
        ['EXCEPTION_ADDED', 'Exception added', 'audit', 'notice', true],
        ['EXCEPTION_UPDATED', 'Exception updated', 'audit', 'notice', true],
        ['EXCEPTION_REVOKED', 'Exception revoked', 'audit', 'notice', true],
      ]),
    ],
  },
  {
    feature: 'waivers',
    label: 'Waiver requests',
    groups: [
      group([
        ['WAIVER_REQUESTED', 'Waiver requested', 'audit', 'notice', true],
        ['WAIVER_UPDATED', 'Waiver updated', 'audit', 'notice', true],
        ['WAIVER_APPROVED', 'Waiver approved', 'audit', 'notice', true],
        ['WAIVER_REJECTED', 'Waiver rejected', 'audit', 'notice', true],
        ['WAIVER_DELETED', 'Waiver deleted', 'audit', 'notice', true],
      ]),
    ],
  },
  {
    feature: 'malware',
    label: 'Malware packages',
    groups: [
      group(
        [
          ['MALWARE_REQUESTED', 'Malware requested (any outcome)', 'decision', 'error', true],
          ['MALWARE_ADDED', 'Entry added', 'audit', 'notice', true],
          ['MALWARE_UPDATED', 'Entry updated', 'audit', 'notice', true],
          ['MALWARE_DELETED', 'Entry deleted', 'audit', 'notice', true],
          ['MALWARE_OVERRIDE_ALLOW', 'Override · Allow', 'audit', 'warning', true],
          ['MALWARE_OVERRIDE_BLOCK', 'Override · Block', 'audit', 'notice', true],
          ['MALWARE_OVERRIDE_TO_CUSTOM', 'Override · Custom entry', 'audit', 'notice', true],
        ],
        jobEvents('malicious-feed-sync', 'Feed sync failed', 'Feed sync completed')
      ),
    ],
  },
  {
    feature: 'package_check',
    label: 'Package check',
    groups: [group([['PACKAGE_CHECKED', 'Package checked', 'audit', 'info', true]])],
  },
  {
    feature: 'vulnerability',
    label: 'Vulnerability',
    groups: [group([], jobEvents('epss-sync', 'EPSS sync failed', 'EPSS sync completed'))],
  },
  {
    feature: 'namespace',
    label: 'Namespace protection',
    groups: [
      group(
        [
          ['DEPENDENCY_CONFUSION_BLOCKED', 'Dependency confusion blocked', 'decision', 'error', true],
          ['NAMESPACE_SETTINGS_UPDATED', 'Namespace settings changed', 'audit', 'notice', true],
          ['NAMESPACE_COLLISION_FOUND', 'Collision found', 'audit', 'warning', true],
        ],
        jobEvents('namespace-collision-check', 'Collision check failed', 'Collision check completed')
      ),
    ],
  },
  {
    feature: 'signin',
    label: 'Sign in',
    groups: [
      group([
        ['SIGNIN_SUCCEEDED', 'Sign-in succeeded', 'audit', 'info', true],
        ['SIGNIN_FAILED', 'Sign-in failed', 'audit', 'notice', true],
        ['PASSWORD_RESET_REQUESTED', 'Password reset requested', 'audit', 'info', true],
        ['PASSWORD_RESET_EMAIL_SENT', 'Password reset email sent', 'audit', 'info', true],
        ['PASSWORD_RESET', 'Password reset completed', 'audit', 'info', true],
        ['INVITE_ACCEPTED', 'Invitation accepted', 'audit', 'notice', true],
        ['IDENTITY_LINKED', 'Identity linked', 'audit', 'notice', true],
        ['SESSIONS_REVOKED', 'Sessions revoked', 'audit', 'notice', true],
      ]),
    ],
  },
  {
    feature: 'access',
    label: 'Access',
    groups: [
      group(
        [
          ['USER_CREATED', 'User created', 'audit', 'notice', true],
          ['USER_PROVISIONED', 'User provisioned', 'audit', 'notice', true],
          ['USER_DELETED', 'User deleted', 'audit', 'notice', true],
          ['USER_DISABLED', 'User disabled', 'audit', 'notice', true],
          ['USER_ENABLED', 'User enabled', 'audit', 'notice', true],
          ['USER_ROLE_CHANGED', 'Role changed', 'audit', 'notice', true],
          ['INVITE_RESENT', 'Invitation resent', 'audit', 'notice', true],
        ],
        [],
        'Users'
      ),
      group(
        [
          ['SSO_PROVIDER_CREATED', 'Provider created', 'audit', 'notice', true],
          ['SSO_PROVIDER_UPDATED', 'Provider updated', 'audit', 'notice', true],
          ['SSO_PROVIDER_DELETED', 'Provider deleted', 'audit', 'notice', true],
          ['SIGNIN_SETTINGS_UPDATED', 'Sign-in settings changed', 'audit', 'notice', true],
        ],
        [],
        'Single sign-on'
      ),
      group(
        [
          ['SERVICE_ACCOUNT_CREATED', 'Service account created', 'audit', 'notice', true],
          ['SERVICE_ACCOUNT_REVOKED', 'Service account revoked', 'audit', 'notice', true],
          ['API_KEY_CREATED', 'API key created', 'audit', 'notice', true],
          ['API_KEY_REVOKED', 'API key revoked', 'audit', 'notice', true],
          ['CI_TOKEN_CREATED', 'CI token created', 'audit', 'notice', true],
          ['CI_TOKEN_REVOKED', 'CI token revoked', 'audit', 'notice', true],
        ],
        [],
        'Service accounts'
      ),
    ],
  },
  {
    feature: 'settings',
    label: 'Settings',
    groups: [
      group([['CONFIG_UPDATED', 'Gateway settings changed', 'audit', 'notice', true]], [], 'Registry'),
      group(
        [
          ['REPOSITORY_CREATED', 'Repository created', 'audit', 'notice', true],
          ['REPOSITORY_UPDATED', 'Repository updated', 'audit', 'notice', true],
          ['REPOSITORY_DELETED', 'Repository deleted', 'audit', 'notice', true],
          ['UPSTREAM_REGISTRY_CREATED', 'Upstream registry created', 'audit', 'notice', true],
          ['UPSTREAM_REGISTRY_UPDATED', 'Upstream registry updated', 'audit', 'notice', true],
          ['UPSTREAM_REGISTRY_DELETED', 'Upstream registry deleted', 'audit', 'notice', true],
        ],
        [],
        'Repositories'
      ),
      group(
        [
          ['WEBHOOK_CREATED', 'Webhook created', 'audit', 'notice', true],
          ['WEBHOOK_UPDATED', 'Webhook updated', 'audit', 'notice', true],
          ['WEBHOOK_DELETED', 'Webhook deleted', 'audit', 'notice', true],
        ],
        [],
        'Webhooks'
      ),
      group([['MAIL_SETTINGS_UPDATED', 'Mail settings changed', 'audit', 'notice', true]], [], 'Email'),
      group(
        [
          ['ARTIFACT_CACHE_SETTINGS_UPDATED', 'Artifact cache settings changed', 'audit', 'notice', true],
          ['ARTIFACT_CACHE_PURGED', 'Artifact cache purged', 'audit', 'notice', true],
        ],
        [],
        'Artifact cache'
      ),
      group(
        [
          ['STREAM_DESTINATION_CREATED', 'Destination created', 'audit', 'notice', true],
          ['STREAM_DESTINATION_UPDATED', 'Destination updated', 'audit', 'notice', true],
          ['STREAM_DESTINATION_DELETED', 'Destination deleted', 'audit', 'notice', true],
        ],
        [],
        'Log streaming'
      ),
      group(
        [
          ['JOB_RUN_REQUESTED', 'Job run requested', 'audit', 'notice', true],
          ['JOB_RETRIED', 'Job retried', 'audit', 'notice', true],
          ['JOB_DISCARDED', 'Job discarded', 'audit', 'notice', true],
        ],
        [
          ...jobEvents('event-retention-purge', 'Retention purge failed (ledger, audit)', 'Retention purge completed (ledger, audit)'),
          ...jobEvents('monitor-retention-purge', 'Retention purge failed (Monitoring)', 'Retention purge completed (Monitoring)'),
        ],
        'Jobs'
      ),
    ],
  },
];

/** High-volume types: published to the bulk stream only when selected (D8). */
export const HIGH_VOLUME_TYPES = new Set(['ALLOW', 'BLOCK_MONITOR']);

type Indexed = { feature: string; event: CatalogEvent };

const byKey = new Map<string, Indexed>();
const byType = new Map<string, Indexed>();
for (const feature of CATALOG) {
  for (const group of feature.groups) {
    for (const event of group.events) {
      if (byKey.has(event.key)) throw new Error(`Event ${event.key} is listed twice in the catalog`);
      byKey.set(event.key, { feature: feature.feature, event });
      // Job types are shared by every job; the per-job key carries the feature.
      if (event.category !== 'job') byType.set(event.type, { feature: feature.feature, event });
    }
  }
}

export function catalogKeys(): string[] {
  return [...byKey.keys()];
}

/** The selection key of an event: its type, or `JOB_*:<job>` for job events. */
export function eventKey(type: string, job?: string | null): string {
  return (type === 'JOB_FAILED' || type === 'JOB_SUCCEEDED' || type === 'JOB_SKIPPED') && job
    ? `${type === 'JOB_SKIPPED' ? 'JOB_SUCCEEDED' : type}:${job}`
    : type;
}

/** The catalog row of an event, or undefined when the catalog does not list it. */
export function catalogEntry(type: string, job?: string | null): Indexed | undefined {
  return byKey.get(eventKey(type, job)) ?? byType.get(type);
}

/** The feature of a scheduled job's events; jobs added without a catalog row fall under Settings · Jobs. */
export function jobFeature(job: string): string {
  return byKey.get(`JOB_FAILED:${job}`)?.feature ?? 'settings';
}

export function featureLabel(feature: string): string {
  return CATALOG.find((row) => row.feature === feature)?.label ?? feature;
}

/** A destination's choice of events (§10.4): whole features, plus single events of partly ticked features. */
export type EventSelection = { features: string[]; events: string[] };

export function recommendedSelection(): EventSelection {
  const features: string[] = [];
  const events: string[] = [];
  for (const feature of CATALOG) {
    const all = feature.groups.flatMap((group) => group.events);
    const chosen = all.filter((event) => event.default);
    if (chosen.length === all.length) features.push(feature.feature);
    else events.push(...chosen.map((event) => event.key));
  }
  return { features, events };
}

export function everythingSelection(): EventSelection {
  return { features: CATALOG.map((feature) => feature.feature), events: [] };
}

/** Keeps known feature names and event keys only, without duplicates. */
export function normalizeSelection(raw: unknown): EventSelection {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { features?: unknown; events?: unknown };
  const features = new Set(CATALOG.map((feature) => feature.feature));
  const pick = (list: unknown, known: (item: string) => boolean) =>
    [...new Set((Array.isArray(list) ? list : []).map(String).filter(known))];
  return {
    features: pick(value.features, (item) => features.has(item)),
    events: pick(value.events, (item) => byKey.has(item)),
  };
}

/** Whether a selection includes an event. A whole feature includes types added to it later. */
export function selects(selection: EventSelection, feature: string, key: string): boolean {
  return selection.features.includes(feature) || selection.events.includes(key);
}

/** Every selection key a selection covers, expanded from its features. */
export function selectedKeys(selection: EventSelection): Set<string> {
  const keys = new Set(selection.events);
  for (const feature of CATALOG) {
    if (!selection.features.includes(feature.feature)) continue;
    for (const group of feature.groups) for (const event of group.events) keys.add(event.key);
  }
  return keys;
}
