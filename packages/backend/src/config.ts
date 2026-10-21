/**
 * Fastify trustProxy: true/false, a hop count, or a comma list of addresses and CIDRs.
 * Unset, it follows how clients arrive: false when the app serves HTTPS itself (clients connect directly),
 * 1 with DISABLE_SSL (one proxy in front), true otherwise (development).
 */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? '').trim();
  if (v === '') {
    if (flag(process.env.DISABLE_SSL, false)) return 1;
    if (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) return false;
    return true;
  }
  if (v.toLowerCase() === 'true') return true;
  if (v.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

function optionalPort(raw: string | undefined): number | undefined {
  const n = parseInt(raw ?? '', 10);
  return n > 0 ? n : undefined;
}

/** A positive number, or null when unset or not a positive number. */
function positiveNumber(raw: string | undefined): number | null {
  const n = parseFloat((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A whole number of at least 0, or the fallback when unset or invalid. */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const v = (raw ?? '').trim();
  if (!/^\d+$/.test(v)) return fallback;
  return parseInt(v, 10);
}

export const config = {
  port: parseInt(process.env.PORT || '3050', 10),
  host: process.env.HOST || '0.0.0.0',
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
  /** Which proxies may set X-Forwarded-For (TRUST_PROXY). See parseTrustProxy for the default. */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  /**
   * HTTPS in the app. With both files (and DISABLE_SSL off), the app serves HTTPS on TLS_PORT and PORT only
   * redirects to it. Otherwise PORT serves everything over plain HTTP.
   */
  tls: {
    /** DISABLE_SSL=true: plain HTTP only, even when certificate files are set. For TLS on your own proxy. */
    disabled: flag(process.env.DISABLE_SSL, false),
    certFile: process.env.TLS_CERT_FILE || '',
    keyFile: process.env.TLS_KEY_FILE || '',
    port: parseInt(process.env.TLS_PORT || '8443', 10),
    /** With HTTPS on, PORT redirects to GATEWAY_URL. HTTP_REDIRECT=false closes PORT instead. */
    redirectHttp: flag(process.env.HTTP_REDIRECT, true),
  },

  /**
   * Internal port for /metrics, /healthz and /readyz over plain HTTP. When set, /metrics is not served on PORT,
   * so only the private network (Prometheus, container health checks) can read it.
   */
  managementPort: optionalPort(process.env.MANAGEMENT_PORT),

  /** Built web UI. The image places it here; in development the UI runs on ng serve and this folder is absent. */
  uiDir: process.env.UI_DIR || '',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'depgate',
    password: process.env.DB_PASSWORD || 'depgate',
    database: process.env.DB_NAME || 'depgate',
    ssl: process.env.DB_SSL === 'true',
    /** CA that signed the database server certificate. Set it to verify the server, not only encrypt. */
    sslCaFile: process.env.DB_SSL_CA_FILE || '',
    /** pg pool max. The default of 10 is the first limit under concurrent installs. */
    poolSize: parseInt(process.env.DB_POOL_SIZE || '20', 10),
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  gateway: {
    baseUrl: process.env.GATEWAY_URL || 'http://localhost:3050',
    npmMetadataTtl: parseInt(process.env.NPM_METADATA_TTL || '300', 10),
    npmNegativeTtl: parseInt(process.env.NPM_NEGATIVE_TTL || '60', 10),
    /** How long a stale npm packument may still be served while one request refreshes it. */
    npmMetadataStaleTtl: parseInt(process.env.NPM_METADATA_STALE_TTL || '3600', 10),
    /** Upstream metadata documents. Defaults to the npm TTL so one knob covers every ecosystem. */
    metadataTtl: parseInt(process.env.METADATA_TTL || process.env.NPM_METADATA_TTL || '300', 10),
    metadataNegativeTtl: parseInt(process.env.METADATA_NEGATIVE_TTL || process.env.NPM_NEGATIVE_TTL || '60', 10),
    metadataStaleTtl: parseInt(process.env.METADATA_STALE_TTL || process.env.NPM_METADATA_STALE_TTL || '3600', 10),
    /** Redis lock so a cache miss is fetched upstream once across replicas. The holder renews it while it fetches. */
    cacheLockTtl: parseInt(process.env.CACHE_LOCK_TTL || '30', 10),
    /** How long a request waits for another replica's fetch before fetching itself, in milliseconds. */
    cacheWaitMaxMs: parseInt(process.env.CACHE_WAIT_MAX_MS || '60000', 10),
    /** How long an upstream failure is remembered so waiters and new misses fail fast, in seconds. */
    cacheErrorTtl: parseInt(process.env.CACHE_ERROR_TTL || '5', 10),
    /** Per-process memory for parsed npm packuments and filtered responses, in megabytes. 0 disables it. */
    npmMemoryCacheMb: parseInt(process.env.NPM_MEMORY_CACHE_MB || '128', 10),
    /** Version license and publish time. Vulnerabilities follow OSV_CACHE_TTL instead. */
    factsCacheTtl: parseInt(process.env.FACTS_CACHE_TTL || '86400', 10),
    /** Policies, settings, webhooks and repositories are reloaded at least this often, in milliseconds. */
    referenceMaxAgeMs: parseInt(process.env.REFERENCE_MAX_AGE_MS || '60000', 10),
    webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
    /** Registry auth is always enforced for package endpoints. */
    registryAuth: true,
  },

  ui: {
    /** Where the web UI is served, for links in API responses such as a 403's Package check link. */
    baseUrl: process.env.UI_URL || process.env.GATEWAY_URL || 'http://localhost:4200',
    /** Documentation site linked from the sidebar's Help section. Unset hides the link. */
    docsUrl: (process.env.DOCS_URL || '').trim(),
  },

  packageCheck: {
    /** Checks per user per minute. A check can fan out to upstream and OSV. */
    rateLimitPerMinute: parseInt(process.env.PACKAGE_CHECK_RATE_LIMIT || '30', 10),
    timeoutMs: parseInt(process.env.PACKAGE_CHECK_TIMEOUT_MS || '10000', 10),
  },

  monitor: {
    /** Recorded versions not downloaded for this many days are purged. 0 keeps them forever. */
    retentionDays: Math.max(parseInt(process.env.MONITOR_RETENTION_DAYS || '90', 10) || 0, 0),
    /** Rows kept per monitoring policy. Beyond it new versions are counted but not stored. */
    maxRowsPerPolicy: parseInt(process.env.MONITOR_MAX_ROWS_PER_POLICY || '50000', 10),
    /** How long an enforced policy's report stays readable on the Recently enforced tab. */
    enforcedRetentionDays: 30,
    /** Later downloads of a recorded version within this window only increment a Redis counter. */
    writeWindowSeconds: 60,
    /** How often the retention purge runs, in minutes. 0 disables the scheduler (tests). */
    purgeIntervalMinutes: parseInt(process.env.MONITOR_PURGE_INTERVAL_MINUTES || '60', 10),
  },

  namespace: {
    /** How often the namespace collision check runs while it is turned on in Settings. 0 disables the scheduler. */
    collisionIntervalHours: parseInt(process.env.NAMESPACE_COLLISION_INTERVAL_HOURS || '24', 10),
  },

  jobs: {
    /** Redis for BullMQ. By default the cache Redis, which must then run with noeviction and AOF. */
    redisUrl: process.env.QUEUE_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6379',
    /** Key prefix, so several installs (or test runs) can share one Redis. */
    prefix: process.env.QUEUE_PREFIX || 'depgate',
    /** `all`, `none`, or a comma list of queue names this replica works on. */
    workers: (process.env.WORKERS || 'all').trim(),
    webhookMaxAttempts: Math.max(parseInt(process.env.WEBHOOK_MAX_ATTEMPTS || '8', 10) || 1, 1),
    webhookDeliveryRetentionDays: Math.max(parseInt(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS || '30', 10) || 1, 1),
    /** Consecutive failed deliveries before a webhook is disabled. 0 never disables. */
    webhookDisableAfterFailures: Math.max(parseInt(process.env.WEBHOOK_DISABLE_AFTER_FAILURES || '20', 10) || 0, 0),
    /** First retry delay of a webhook delivery; later ones double. Tests shorten it. */
    webhookBackoffMs: Math.max(parseInt(process.env.WEBHOOK_BACKOFF_MS || '30000', 10) || 1, 1),
    emailBackoffMs: Math.max(parseInt(process.env.EMAIL_BACKOFF_MS || '60000', 10) || 1, 1),
    jobRunRetentionDays: 90,
    /** How long a worker holds a job before another replica may take it over (it renews while alive). */
    lockDurationMs: Math.max(parseInt(process.env.JOBS_LOCK_DURATION_MS || '30000', 10) || 1000, 1000),
  },

  /** Decision Ledger, Audit Log and Log Streaming (requirements_event_streaming.md §12). */
  events: {
    /** Decision Ledger rows older than this are purged. 0 keeps them forever. */
    ledgerRetentionDays: Math.max(parseInt(process.env.LEDGER_RETENTION_DAYS || '180', 10) || 0, 0),
    /** Audit Log rows older than this are purged. 0 keeps them forever. */
    auditRetentionDays: Math.max(parseInt(process.env.AUDIT_RETENTION_DAYS || '730', 10) || 0, 0),
    /** Approximate length of the bulk stream (ALLOW, BLOCK_MONITOR): the buffer while a destination is down. */
    streamMaxLen: Math.max(parseInt(process.env.EVENT_STREAM_MAX_LEN || '200000', 10) || 1000, 1000),
    /** Identical package_blocked and malware_requested webhooks within this window are sent once plus one follow-up. 0 sends each. */
    webhookCoalesceSeconds: Math.max(parseInt(process.env.WEBHOOK_COALESCE_SECONDS ?? '300', 10) || 0, 0),
    /** Tells several DepGate installations apart in one SIEM. Defaults to the public URL's host. */
    instanceName: (process.env.DEPGATE_INSTANCE_NAME || '').trim(),
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
    /** Browser session. The registry snippet uses the Settings lifetime instead, default 30 days. */
    uiSessionExpiresIn: process.env.UI_SESSION_EXPIRES_IN || '1h',
    defaultAdminEmail: process.env.ADMIN_EMAIL || 'admin@depgate.local',
    defaultAdminPassword: process.env.ADMIN_PASSWORD || 'admin',
    /** Web UI address from UI_URL. Otherwise it is learned from a signed-in admin's browser. Never taken from an email request. */
    publicUrlEnv: (process.env.UI_URL || '').replace(/\/+$/, ''),
    publicUrlDefault: (process.env.GATEWAY_URL || 'http://localhost:4200').replace(/\/+$/, ''),
    inviteExpiryHours: parseInt(process.env.INVITE_EXPIRY_HOURS || '168', 10),
    resetExpiryMinutes: parseInt(process.env.PASSWORD_RESET_EXPIRY_MINUTES || '60', 10),
    /**
     * Single sign-on refuses plain-HTTP identity providers except on localhost. Test setups whose provider
     * runs on another host name (a Keycloak container) turn this on. Never in production.
     */
    ssoAllowInsecureHttp: flag(process.env.SSO_ALLOW_INSECURE_HTTP, false),
    /** Requests per IP per 10 minutes to each single sign-on endpoint (start, callback, exchange). 0 turns the limit off. */
    ssoRateLimit: Math.max(parseInt(process.env.SSO_RATE_LIMIT || '600', 10) || 0, 0),
    /** Failed password sign-ins per 15 minutes before /api/auth/login answers 429. Successful sign-ins do not count. */
    loginFailuresPerIp: Math.max(parseInt(process.env.LOGIN_FAILURE_LIMIT_PER_IP || '100', 10) || 0, 0),
    loginFailuresPerEmail: Math.max(parseInt(process.env.LOGIN_FAILURE_LIMIT_PER_EMAIL || '10', 10) || 0, 0),
    /** Failed sign-ins written to the Decision Ledger per IP per minute; the rest are only counted (requirements_sso.md A1). */
    loginFailureAuditPerMinute: Math.max(parseInt(process.env.LOGIN_FAILURE_AUDIT_PER_MINUTE || '20', 10) || 0, 0),
  },

  /** Outgoing mail for invitations and password resets. Without SMTP_HOST the admin copies the link instead. */
  mail: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: (process.env.SMTP_SECURE ?? '').toLowerCase() === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'DepGate <no-reply@depgate.local>',
  },

  depsDev: {
    apiUrl: process.env.DEPS_DEV_API_URL || 'https://api.deps.dev',
    /** Backup lookup for a missing publish time or SPDX license. Off skips the call. */
    enabled: (() => {
      const v = (process.env.DEPS_DEV_ENABLED ?? 'true').toLowerCase().trim();
      return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
    })(),
    timeoutMs: parseInt(process.env.DEPS_DEV_TIMEOUT_MS || '3000', 10),
    /** How long a 404 or empty lookup is remembered, so a miss is not retried on every install. */
    negativeTtl: parseInt(process.env.DEPS_DEV_NEGATIVE_TTL || '60', 10),
  },

  /** OpenSSF Scorecard rule (requirements_scorecard.md). deps.dev settings above apply to its backup calls. */
  scorecard: {
    /** Off: the rule never matches and makes no calls. */
    enabled: flag(process.env.SCORECARD_ENABLED, true),
    apiUrl: process.env.SCORECARD_API_URL || 'https://api.securityscorecards.dev',
    /** A repository mapping or a project's result. Scorecard re-scans weekly. */
    cacheTtl: parseInt(process.env.SCORECARD_CACHE_TTL || '86400', 10),
    /** "No usable repository", "no result", and a score that came from the deps.dev backup. */
    negativeTtl: parseInt(process.env.SCORECARD_NEGATIVE_TTL || '3600', 10),
    timeoutMs: parseInt(process.env.SCORECARD_TIMEOUT_MS || '3000', 10),
  },

  /** EPSS in the Vulnerability rule (requirements_epss.md). Synced by a job; never fetched on the request path. */
  epss: {
    /** Off: no sync, and every vulnerability's EPSS is unknown. */
    enabled: flag(process.env.EPSS_ENABLED, true),
    /** Full daily file (gzip CSV). Air-gapped installs point this at an internal mirror. */
    feedUrl: process.env.EPSS_FEED_URL || 'https://epss.empiricalsecurity.com/epss_scores-current.csv.gz',
    /**
     * Backup when the feed cannot be downloaded: the dated copies in the empiricalsec/epss_scores GitHub repository,
     * one folder per year. `{year}` and `{date}` (YYYY-MM-DD, UTC) are filled in; today is tried first, then earlier days.
     * Empty disables the backup.
     */
    backupUrlTemplate:
      process.env.EPSS_BACKUP_URL_TEMPLATE ??
      'https://raw.githubusercontent.com/empiricalsec/epss_scores/main/{year}/epss_scores-{date}.csv.gz',
    /** How many days back the backup looks for a file (today counts as the first). */
    backupDays: Math.max(parseInt(process.env.EPSS_BACKUP_DAYS || '3', 10) || 1, 1),
    /** FIRST's API, used only by the admin refresh of a few CVEs. */
    apiUrl: process.env.EPSS_API_URL || 'https://api.first.org/data/v1/epss',
    /** FIRST publishes once a day. 0 disables the schedule. */
    syncIntervalHours: Math.max(parseInt(process.env.EPSS_SYNC_INTERVAL_HOURS || '24', 10) || 0, 0),
    feedTimeoutMs: parseInt(process.env.EPSS_FEED_TIMEOUT_MS || '300000', 10),
    /** After this the UI warns that EPSS data is stale. */
    staleAfterHours: parseInt(process.env.EPSS_STALE_AFTER_HOURS || '72', 10),
  },

  osv: {
    apiUrl: process.env.OSV_API_URL || 'https://api.osv.dev',
    cacheTtl: parseInt(process.env.OSV_CACHE_TTL || '3600', 10),
    /** Vulnerability documents fetched for severity. */
    vulnCacheTtl: parseInt(process.env.OSV_VULN_CACHE_TTL || '86400', 10),
    /** Batch query and severity fetches. */
    timeoutMs: parseInt(process.env.OSV_TIMEOUT_MS || '3000', 10),
    /** Single-version query used by policy simulation. */
    queryTimeoutMs: parseInt(process.env.OSV_QUERY_TIMEOUT_MS || '15000', 10),
  },

  upstream: {
    /**
     * How long each address of a host gets to connect before Node moves to the next (happy eyeballs).
     * Node's 250 ms default gives up on a slow IPv4 connect and fails on an IPv6 address that a
     * container usually cannot reach, so congested egress turned into "fetch failed" (ETIMEDOUT).
     */
    connectAttemptTimeoutMs: parseInt(process.env.UPSTREAM_CONNECT_ATTEMPT_TIMEOUT_MS || '2500', 10),
  },

  circuitBreaker: {
    /** How long an open breaker answers without asking the remote, before one trial request. */
    resetMs: parseInt(process.env.CIRCUIT_BREAKER_RESET_MS || '10000', 10),
  },

  /** Package files from public remotes, kept on each pod's local SSD (requirements_artifact_cache.md). */
  artifactCache: {
    enabled: flag(process.env.ARTIFACT_CACHE_ENABLED, false),
    /** One directory per pod on local disk. Never shared between pods. */
    dir: (process.env.ARTIFACT_CACHE_DIR || '/var/lib/depgate/artifacts').trim(),
    /** Required when enabled. */
    maxSizeGb: positiveNumber(process.env.ARTIFACT_CACHE_MAX_SIZE_GB),
    /** The variable as set, for the start-up message when it is not a usable number. */
    maxSizeGbRaw: (process.env.ARTIFACT_CACHE_MAX_SIZE_GB ?? '').trim(),
    maxFiles: Math.max(nonNegativeInt(process.env.ARTIFACT_CACHE_MAX_FILES, 200000), 1),
    /** 0 turns expiry by age off. */
    maxAgeDays: nonNegativeInt(process.env.ARTIFACT_CACHE_MAX_AGE_DAYS, 30),
    /** 0 turns expiry by idle time off. */
    maxIdleDays: nonNegativeInt(process.env.ARTIFACT_CACHE_MAX_IDLE_DAYS, 7),
    /** Larger files are served but not stored. */
    maxFileMb: Math.max(nonNegativeInt(process.env.ARTIFACT_CACHE_MAX_FILE_MB, 1024), 1),
  },

  malicious: {
    /** Release archive used for a full load. */
    archiveUrl:
      process.env.MALICIOUS_FEED_ARCHIVE_URL ||
      'https://github.com/secmods/malicious-packages/releases/latest/download/malicious-packages.tar.gz',
    /** Raw feed root. Every sync reads manifest.json here; incremental syncs also read *.changes.jsonl. */
    feedUrl:
      process.env.MALICIOUS_FEED_URL ||
      'https://github.com/secmods/malicious-packages/raw/refs/heads/main/malicious-packages',
    syncIntervalHours: parseInt(process.env.MALICIOUS_SYNC_INTERVAL_HOURS || '1', 10),
    /** Outbound feed download timeout. */
    feedTimeoutMs: parseInt(process.env.MALICIOUS_FEED_TIMEOUT_MS || '300000', 10),
    /** Limit per ecosystem (e.g. 10 for local). Omit or 0 = sync all. */
    syncLimitPerEcosystem: (() => {
      const v = process.env.MALICIOUS_SYNC_LIMIT_PER_ECOSYSTEM;
      if (!v) return undefined;
      const n = parseInt(v, 10);
      return n > 0 ? n : undefined;
    })(),
  },
} as const;
