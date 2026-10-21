-- 0001_initial: the schema DepGate had when migrations replaced schema sync (2026-10-19).
-- 29 entity tables, the five tables TypeORM cannot declare (UNIQUE NULLS NOT DISTINCT), and the
-- one event_migration row the application reads. Never edited; later changes are new migrations.

CREATE TABLE api_keys (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  key_hash varchar(64) NOT NULL,
  name varchar(256) NOT NULL,
  role varchar(32) DEFAULT 'ServiceAccount' NOT NULL,
  namespace varchar(32),
  expires_at timestamptz,
  last_used_at timestamptz,
  request_count bigint DEFAULT 0 NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_api_keys PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_api_keys_key_hash ON api_keys (key_hash);

CREATE TABLE audit_events (
  id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  type varchar(48) NOT NULL,
  actor_kind varchar(16) NOT NULL,
  actor_id varchar(64),
  actor_name varchar(256),
  actor_ip varchar(64),
  actor_user_agent text,
  actor_auth_method varchar(16),
  actor_metadata jsonb,
  target_kind varchar(32),
  target_id varchar(128),
  target_name varchar(512),
  target_ecosystem varchar(32),
  target_version varchar(128),
  target_repository varchar(128),
  summary varchar(500),
  reasons jsonb,
  details jsonb,
  CONSTRAINT pk_audit_events PRIMARY KEY (id)
);
CREATE INDEX idx_audit_events_actor ON audit_events (actor_name, created_at);
CREATE INDEX idx_audit_events_created ON audit_events (created_at);
CREATE INDEX idx_audit_events_target ON audit_events (target_kind, target_id);
CREATE INDEX idx_audit_events_type ON audit_events (type, created_at);

CREATE TABLE audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  requester_ip varchar(64),
  requester varchar(256),
  user_agent text,
  ecosystem varchar(32) NOT NULL,
  package_name varchar(512) NOT NULL,
  resolved_version varchar(128),
  repository varchar(128),
  decision varchar(32) NOT NULL,
  policy_id uuid,
  policy_name varchar(256),
  condition_reasons jsonb,
  metadata jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_audit_logs PRIMARY KEY (id)
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX idx_audit_logs_decision ON audit_logs (decision);
CREATE INDEX idx_audit_logs_ecosystem_package_name ON audit_logs (ecosystem, package_name);

CREATE TABLE auth_settings (
  id varchar(32) NOT NULL,
  allowed_domains jsonb DEFAULT '[]' NOT NULL,
  allow_unlisted_sso boolean DEFAULT true NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_auth_settings PRIMARY KEY (id)
);

CREATE TABLE auth_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  purpose varchar(16) NOT NULL,
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_auth_tokens PRIMARY KEY (id)
);
CREATE INDEX idx_auth_tokens_user_id ON auth_tokens (user_id);
CREATE UNIQUE INDEX uq_auth_tokens_token_hash ON auth_tokens (token_hash);

CREATE TABLE ci_tokens (
  id uuid NOT NULL,
  name varchar(128) NOT NULL,
  metadata jsonb DEFAULT '{}' NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by varchar(256) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_ci_tokens PRIMARY KEY (id)
);
CREATE INDEX idx_ci_tokens_expires_at ON ci_tokens (expires_at);

CREATE TABLE decision_counts_hourly (
  hour timestamptz NOT NULL,
  ecosystem varchar(32) NOT NULL,
  repository varchar(128),
  decision varchar(32) NOT NULL,
  count bigint DEFAULT 0 NOT NULL,
  CONSTRAINT uq_decision_counts_hourly UNIQUE NULLS NOT DISTINCT (hour, ecosystem, repository, decision)
);
CREATE INDEX idx_decision_counts_hourly_hour ON decision_counts_hourly (hour);

CREATE TABLE decision_ledger (
  id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  decision varchar(32) NOT NULL,
  malware boolean DEFAULT false NOT NULL,
  ecosystem varchar(32) NOT NULL,
  package_name varchar(512) NOT NULL,
  resolved_version varchar(128),
  repository varchar(128),
  policy_id uuid,
  policy_name varchar(256),
  condition_reasons jsonb,
  requester varchar(256),
  requester_ip varchar(64),
  user_agent text,
  actor_kind varchar(16),
  actor_id varchar(64),
  auth_method varchar(16),
  actor_metadata jsonb,
  details jsonb,
  CONSTRAINT pk_decision_ledger PRIMARY KEY (id)
);
CREATE INDEX idx_decision_ledger_created ON decision_ledger (created_at);
CREATE INDEX idx_decision_ledger_decision ON decision_ledger (decision, created_at);
CREATE INDEX idx_decision_ledger_malware ON decision_ledger (created_at) WHERE malware;
CREATE INDEX idx_decision_ledger_package ON decision_ledger (ecosystem, package_name);

CREATE TABLE epss_scores (
  cve_id varchar(32) NOT NULL,
  score real NOT NULL,
  percentile real NOT NULL,
  CONSTRAINT pk_epss_scores PRIMARY KEY (cve_id)
);

CREATE TABLE epss_sync_status (
  id varchar(32) NOT NULL,
  state varchar(16) DEFAULT 'idle' NOT NULL,
  trigger varchar(16),
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  score_date varchar(32),
  model_version varchar(64),
  row_count integer,
  last_error text,
  feed_source varchar(512),
  CONSTRAINT pk_epss_sync_status PRIMARY KEY (id)
);

CREATE TABLE event_migration (
  id smallint DEFAULT 1 NOT NULL,
  cursor_created_at timestamptz,
  cursor_id uuid,
  started_at timestamptz DEFAULT now() NOT NULL,
  finished_at timestamptz,
  copied_ledger bigint DEFAULT 0 NOT NULL,
  copied_audit bigint DEFAULT 0 NOT NULL,
  counted bigint DEFAULT 0 NOT NULL,
  CONSTRAINT pk_event_migration PRIMARY KEY (id),
  CONSTRAINT event_migration_single CHECK (id = 1)
);

CREATE TABLE exceptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  package_name varchar(512) NOT NULL,
  ecosystem varchar(32) NOT NULL,
  policy_id uuid,
  repository_ids jsonb DEFAULT '[]' NOT NULL,
  version varchar(128) NOT NULL,
  expires_at timestamptz NOT NULL,
  reason text,
  approved_by varchar(256) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_exceptions PRIMARY KEY (id)
);
CREATE INDEX idx_exceptions_ecosystem_package_name_version ON exceptions (ecosystem, package_name, version);
CREATE INDEX idx_exceptions_expires_at ON exceptions (expires_at);
CREATE INDEX idx_exceptions_policy_id ON exceptions (policy_id);

CREATE TABLE gateway_settings (
  id varchar(32) NOT NULL,
  session_token_days integer DEFAULT 30 NOT NULL,
  namespace_collision_check boolean DEFAULT false NOT NULL,
  artifact_cache_enabled boolean,
  artifact_cache_limits jsonb,
  CONSTRAINT pk_gateway_settings PRIMARY KEY (id)
);

CREATE TABLE job_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  job varchar(64) NOT NULL,
  job_id varchar(128),
  trigger varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result jsonb,
  error varchar(500),
  CONSTRAINT pk_job_runs PRIMARY KEY (id)
);
CREATE INDEX idx_job_runs_job_started_at ON job_runs (job, started_at);

CREATE TABLE mail_settings (
  id varchar(32) NOT NULL,
  host varchar(255) DEFAULT '' NOT NULL,
  port integer DEFAULT 587 NOT NULL,
  secure boolean DEFAULT false NOT NULL,
  smtp_user varchar(255) DEFAULT '' NOT NULL,
  password_enc text DEFAULT '' NOT NULL,
  from_address varchar(255) DEFAULT '' NOT NULL,
  public_url varchar(255) DEFAULT '' NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_mail_settings PRIMARY KEY (id)
);

CREATE TABLE malicious_feed_state (
  id varchar(32) NOT NULL,
  watermark varchar(40) NOT NULL,
  schema_version varchar(16) NOT NULL,
  upstream_repo text,
  upstream_commit varchar(64),
  changes_since varchar(40) NOT NULL,
  changes_window_days integer NOT NULL,
  total_records integer NOT NULL,
  ecosystems jsonb DEFAULT '{}' NOT NULL,
  applied_at timestamptz NOT NULL,
  CONSTRAINT pk_malicious_feed_state PRIMARY KEY (id)
);

CREATE TABLE malicious_packages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name varchar(512) NOT NULL,
  ecosystem varchar(32) NOT NULL,
  lookup_name varchar(512),
  reason text,
  source_url text,
  source varchar(16) DEFAULT 'default' NOT NULL,
  version_range varchar(128),
  override_status varchar(16) DEFAULT 'BLOCK' NOT NULL,
  override_reason text,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_malicious_packages PRIMARY KEY (id)
);
CREATE INDEX idx_malicious_packages_lookup ON malicious_packages (ecosystem, lookup_name);
CREATE UNIQUE INDEX uq_malicious_packages_name_ecosystem ON malicious_packages (name, ecosystem);

CREATE TABLE malicious_sync_status (
  id varchar(32) NOT NULL,
  status varchar(16) DEFAULT 'idle' NOT NULL,
  trigger varchar(16),
  started_at timestamptz,
  finished_at timestamptz,
  last_success_at timestamptz,
  phase varchar(32),
  ecosystem varchar(32),
  mode varchar(16),
  added integer,
  removed integer,
  updated integer,
  total integer,
  error text,
  watermark_before varchar(40),
  watermark_after varchar(40),
  CONSTRAINT pk_malicious_sync_status PRIMARY KEY (id)
);

CREATE TABLE monitor_hits (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  policy_id uuid NOT NULL,
  ecosystem varchar(32) NOT NULL,
  package_name varchar(512) NOT NULL,
  version varchar(256) NOT NULL,
  reason_key varchar(512) NOT NULL,
  reasons jsonb DEFAULT '[]' NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  repositories jsonb DEFAULT '[]' NOT NULL,
  hit_count integer DEFAULT 1 NOT NULL,
  CONSTRAINT pk_monitor_hits PRIMARY KEY (id)
);
CREATE INDEX idx_monitor_hits_last_seen_at ON monitor_hits (last_seen_at);
CREATE INDEX idx_monitor_hits_policy_id_ecosystem_package_name ON monitor_hits (policy_id, ecosystem, package_name);
CREATE INDEX idx_monitor_hits_policy_id_reason_key ON monitor_hits (policy_id, reason_key);
CREATE UNIQUE INDEX uq_monitor_hits_policy_id_ecosystem_package_name_version ON monitor_hits (policy_id, ecosystem, package_name, version);

CREATE TABLE namespace_collisions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ecosystem varchar(32) NOT NULL,
  name varchar(512) NOT NULL,
  policy_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_checked_at timestamptz NOT NULL,
  public_latest_version varchar(256),
  CONSTRAINT pk_namespace_collisions PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_namespace_collisions_policy_id_ecosystem_name ON namespace_collisions (policy_id, ecosystem, name);

CREATE TABLE package_counts_hourly (
  hour timestamptz NOT NULL,
  ecosystem varchar(32) NOT NULL,
  package_name varchar(512) NOT NULL,
  decision varchar(32) NOT NULL,
  count bigint DEFAULT 0 NOT NULL,
  CONSTRAINT uq_package_counts_hourly UNIQUE NULLS NOT DISTINCT (hour, ecosystem, package_name, decision)
);
CREATE INDEX idx_package_counts_hourly_hour ON package_counts_hourly (hour, decision);

CREATE TABLE package_repositories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ecosystem varchar(32) NOT NULL,
  key varchar(64) NOT NULL,
  type varchar(16) NOT NULL,
  upstream_url varchar(2048),
  source varchar(16) DEFAULT 'public' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  all_position integer,
  is_enabled boolean DEFAULT true NOT NULL,
  is_reserved boolean DEFAULT false NOT NULL,
  "timeoutMs" integer DEFAULT 30000 NOT NULL,
  "retryCount" integer DEFAULT 3 NOT NULL,
  auth_type varchar(32),
  auth_encrypted text,
  description varchar(512),
  upstream_registry_id uuid,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_package_repositories PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_package_repositories_ecosystem_key ON package_repositories (ecosystem, key);

CREATE TABLE package_repository_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  virtual_id uuid NOT NULL,
  member_id uuid NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  CONSTRAINT pk_package_repository_members PRIMARY KEY (id)
);
CREATE INDEX idx_package_repository_members_virtual_id_position ON package_repository_members (virtual_id, "position");
CREATE UNIQUE INDEX uq_package_repository_members_virtual_id_member_id ON package_repository_members (virtual_id, member_id);

CREATE TABLE package_usage (
  ecosystem varchar(32) NOT NULL,
  package_name varchar(512) NOT NULL,
  version varchar(128) NOT NULL,
  repository varchar(128),
  source_repository varchar(256),
  source_type varchar(16),
  decision varchar(32) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  CONSTRAINT uq_package_usage UNIQUE NULLS NOT DISTINCT (ecosystem, package_name, version, repository, source_repository, source_type, decision)
);
CREATE INDEX idx_package_usage_ecosystem ON package_usage (ecosystem, decision, last_seen_at);
CREATE INDEX idx_package_usage_last_seen ON package_usage (last_seen_at);

CREATE TABLE policies (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name varchar(256) NOT NULL,
  description text,
  decision varchar(16) DEFAULT 'BLOCK' NOT NULL,
  conditions jsonb DEFAULT '{}' NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  mode varchar(16) DEFAULT 'enforce' NOT NULL,
  mode_changed_at timestamptz,
  repository_ids jsonb DEFAULT '[]' NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_policies PRIMARY KEY (id)
);

CREATE TABLE sso_providers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  type varchar(16) NOT NULL,
  name varchar(128) NOT NULL,
  button_label varchar(128) NOT NULL,
  enabled boolean DEFAULT false NOT NULL,
  config jsonb NOT NULL,
  client_secret_enc text DEFAULT '' NOT NULL,
  sp_private_key_enc text DEFAULT '' NOT NULL,
  last_error text,
  last_success_at timestamptz,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_sso_providers PRIMARY KEY (id)
);

CREATE TABLE stream_destinations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name varchar(128) NOT NULL,
  type varchar(16) NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  settings jsonb DEFAULT '{}' NOT NULL,
  secrets_enc text,
  selection jsonb DEFAULT '{"events": [], "features": []}' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_stream_destinations PRIMARY KEY (id)
);

CREATE TABLE summary_flushes (
  key varchar(128) NOT NULL,
  flushed_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT pk_summary_flushes PRIMARY KEY (key)
);

CREATE TABLE upstream_registries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  ecosystem varchar(32) NOT NULL,
  url varchar(2048) NOT NULL,
  priority integer DEFAULT 0 NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  "timeoutMs" integer DEFAULT 30000 NOT NULL,
  "retryCount" integer DEFAULT 3 NOT NULL,
  auth_type varchar(32),
  auth_encrypted text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_upstream_registries PRIMARY KEY (id)
);
CREATE INDEX idx_upstream_registries_ecosystem_priority ON upstream_registries (ecosystem, priority);

CREATE TABLE user_identities (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  subject varchar(255) NOT NULL,
  email_at_link varchar(254) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  last_used_at timestamptz,
  CONSTRAINT pk_user_identities PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_user_identities_provider_id_subject ON user_identities (provider_id, subject);
CREATE UNIQUE INDEX uq_user_identities_user_id_provider_id ON user_identities (user_id, provider_id);

CREATE TABLE users (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email varchar(254) NOT NULL,
  password_hash varchar(128),
  role varchar(32) DEFAULT 'User' NOT NULL,
  source varchar(16) DEFAULT 'local' NOT NULL,
  disabled_at timestamptz,
  session_version integer DEFAULT 0 NOT NULL,
  last_login_at timestamptz,
  last_login_method varchar(16),
  last_login_provider_id uuid,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_users PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_users_email ON users (email);

CREATE TABLE waiver_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  package_name varchar(512) NOT NULL,
  ecosystem varchar(32) NOT NULL,
  version varchar(128) NOT NULL,
  repository_ids jsonb DEFAULT '[]' NOT NULL,
  requested_expires_at timestamptz NOT NULL,
  approved_expires_at timestamptz,
  reason text NOT NULL,
  status varchar(16) DEFAULT 'pending' NOT NULL,
  requested_by varchar(256) NOT NULL,
  requested_by_id varchar(256) NOT NULL,
  reviewed_by varchar(256),
  review_note text,
  exception_id uuid,
  created_at timestamp DEFAULT now() NOT NULL,
  reviewed_at timestamptz,
  CONSTRAINT pk_waiver_requests PRIMARY KEY (id)
);
CREATE INDEX idx_waiver_requests_ecosystem_package_name ON waiver_requests (ecosystem, package_name);
CREATE INDEX idx_waiver_requests_requested_by_id_status ON waiver_requests (requested_by_id, status);
CREATE INDEX idx_waiver_requests_status ON waiver_requests (status);

CREATE TABLE webhook_deliveries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  event_id varchar(36) NOT NULL,
  target_id uuid NOT NULL,
  event varchar(64) NOT NULL,
  payload jsonb DEFAULT '{}' NOT NULL,
  status varchar(16) NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  last_status_code integer,
  last_error varchar(500),
  created_at timestamp DEFAULT now() NOT NULL,
  delivered_at timestamptz,
  next_attempt_at timestamptz,
  CONSTRAINT pk_webhook_deliveries PRIMARY KEY (id)
);
CREATE INDEX idx_webhook_deliveries_created_at ON webhook_deliveries (created_at);
CREATE INDEX idx_webhook_deliveries_target_id_created_at ON webhook_deliveries (target_id, created_at);

CREATE TABLE webhook_targets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  url varchar(512) NOT NULL,
  secret text,
  events jsonb DEFAULT '[]' NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  consecutive_failures integer DEFAULT 0 NOT NULL,
  last_error varchar(500),
  last_failure_at timestamptz,
  disabled_at timestamptz,
  disabled_reason varchar(500),
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT pk_webhook_targets PRIMARY KEY (id)
);

-- Foreign keys
ALTER TABLE exceptions ADD CONSTRAINT fk_exceptions_policy_id FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE;
ALTER TABLE monitor_hits ADD CONSTRAINT fk_monitor_hits_policy_id FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE;
ALTER TABLE namespace_collisions ADD CONSTRAINT fk_namespace_collisions_policy_id FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE;
ALTER TABLE webhook_deliveries ADD CONSTRAINT fk_webhook_deliveries_target_id FOREIGN KEY (target_id) REFERENCES webhook_targets(id) ON DELETE CASCADE;

-- The event migration cursor the application reads (readMigrationState); removed with the table before 1.0.
INSERT INTO event_migration (id) VALUES (1);
