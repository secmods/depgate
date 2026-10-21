# Configuration

DepGate is configured with environment variables. The names are the same in every production setup: `.env` in `deploy/all-in-one/` and `deploy/app-only/` (each has an `.env.example` that lists them with explanations), and the ConfigMap `depgate-config` and Secret `depgate-secrets` in `deploy/kubernetes/`. Restart DepGate to apply a change: `./3-run.sh` with Compose, `kubectl rollout restart deployment/depgate` on Kubernetes.

Settings that Security users change in the web interface (repositories, single sign-on, email, webhooks, log streaming, the artifact cache, the registry token lifetime and the gateway security controls) are stored in the database and need no restart.

## Required

| Variable | Description |
|---|---|
| `GATEWAY_URL` | The address people and package clients use, for example `https://depgate.example.com`. Download links in registry responses are built from it. |
| `JWT_SECRET` | Secret that signs sessions and registry tokens. Generate it with `openssl rand -hex 32` and keep it: changing it signs everyone out and invalidates every registry token. |
| `ADMIN_EMAIL` | The first Security account, created on first start on an empty database only. Changing it later does nothing. |
| `ADMIN_PASSWORD` | Its initial password, read at that first start only. Change it in the web interface afterwards; both variables may then be removed. |
| `DEPGATE_IMAGE`, `DEPGATE_VERSION` | The image and tag to run (Compose setups; `ghcr.io/secmods/depgate` and the release version). On Kubernetes: `images:` in `kustomization.yaml`. |

## Server and HTTPS

| Variable | Default | Description |
|---|---|---|
| `DISABLE_SSL` | `false` | `true` serves plain HTTP only, for TLS on your own proxy or load balancer. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | `/certs/tls.crt`, `/certs/tls.key` | Certificate (full chain) and private key, in PEM. Reloaded automatically when the files change. |
| `HTTPS_PORT`, `HTTP_PORT` | `443`, `80` | Host ports. |
| `HTTP_BIND` | `0.0.0.0` | Host address for the HTTP port. `127.0.0.1` when your proxy runs on the same host. |
| `HTTP_REDIRECT` | `true` | With HTTPS on, redirect HTTP to HTTPS. `false` closes the HTTP port. |
| `TRUST_PROXY` | `1` with `DISABLE_SSL`, otherwise `false` | Which proxies may set `X-Forwarded-For`: `false`, a number of hops, or a list of addresses and CIDR ranges. |
| `UI_URL` | `GATEWAY_URL` | The address of the web interface, used in email links and in the Package check link of block responses. |
| `DOCS_URL` | none | The documentation site linked from **Help → Documentation** in the sidebar, for example an internal copy. Unset hides the link. |
| `MANAGEMENT_PORT` | `9464` in Docker | Private port for `/metrics`, `/healthz` and `/readyz`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `DEPGATE_INSTANCE_NAME` | the host of `GATEWAY_URL` | The installation's name in streamed events. |

## Database (PostgreSQL)

| Variable | Default | Description |
|---|---|---|
| `DB_HOST`, `DB_PORT` | `localhost`, `5432` | Server address. |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `depgate` | Credentials and database. |
| `DB_SSL` | `false` | Encrypt the connection. |
| `DB_SSL_CA_FILE` | none | CA certificate (PEM) to verify the server, for example `/certs/ca.crt`. |
| `DB_POOL_SIZE` | `20` | Connections per replica. |

## Redis

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Cache and job queues. Use `rediss://` for TLS; put the password in the URL. Requires `maxmemory-policy noeviction`. |
| `QUEUE_REDIS_URL` | `REDIS_URL` | Optional separate Redis for the job queues. |
| `QUEUE_PREFIX` | `depgate` | Key prefix, to share one Redis between several installations. |
| `WORKERS` | `all` | Which queues this replica processes: `all`, `none`, or a list of `webhooks`, `scheduled`, `email`, `monitor`. |

## Outbound network

| Variable | Description |
|---|---|
| `NODE_USE_ENV_PROXY` | `1` sends outgoing requests through the proxy below. |
| `HTTP_PROXY`, `HTTPS_PROXY` | The outbound proxy, for example `http://proxy.example.com:3128`. |
| `NO_PROXY` | Hosts reached directly: internal registries, webhook endpoints. |
| `NODE_EXTRA_CA_CERTS` | Extra CA certificates trusted for outgoing TLS. `/certs/ca.crt` in Docker. |

## Authentication and email

| Variable | Default | Description |
|---|---|---|
| `UI_SESSION_EXPIRES_IN` | `1h` | Browser session lifetime. |
| `INVITE_EXPIRY_HOURS` | `168` | How long an invitation link works. |
| `PASSWORD_RESET_EXPIRY_MINUTES` | `60` | How long a password reset link works. |
| `LOGIN_FAILURE_LIMIT_PER_EMAIL`, `LOGIN_FAILURE_LIMIT_PER_IP` | `10`, `100` | Failed password sign-ins per 15 minutes before sign-in waits. `0` removes the limit. |
| `LOGIN_FAILURE_AUDIT_PER_MINUTE` | `20` | Failed sign-ins written to the Audit Log per address and minute; the rest are only counted. |
| `SSO_RATE_LIMIT` | `600` | Requests per address and 10 minutes to the single sign-on endpoints. `0` removes the limit. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | none | Mail server. Settings saved under **Settings → Email** take precedence. |

## Package check

| Variable | Default | Description |
|---|---|---|
| `PACKAGE_CHECK_RATE_LIMIT` | `30` | Checks per user per minute. `0` removes the limit. |
| `PACKAGE_CHECK_TIMEOUT_MS` | `10000` | Time limit of one check. |

## Caching

| Variable | Default | Description |
|---|---|---|
| `NPM_METADATA_TTL` | `300` | Seconds npm metadata is considered fresh. |
| `NPM_METADATA_STALE_TTL` | `3600` | Seconds stale npm metadata may still be served while it is refreshed. |
| `METADATA_TTL`, `METADATA_STALE_TTL` | npm values | The same for the other ecosystems. |
| `NPM_NEGATIVE_TTL`, `METADATA_NEGATIVE_TTL` | `60` | Seconds a "not found" answer is cached. |
| `NPM_MEMORY_CACHE_MB` | `128` | In-process cache per replica. `0` turns it off. |
| `FACTS_CACHE_TTL` | `86400` | Seconds licenses and publish dates are cached. |
| `OSV_CACHE_TTL` | `3600` | Seconds vulnerability results are cached. A newly published vulnerability is enforced within this time. |

Shorter stale windows reduce Redis memory use. See [Requirements → Sizing](/install/requirements#sizing).

## Artifact cache

Package files from public registries, kept on each replica's local disk. See [Artifact cache](/admin/artifact-cache). Every variable except `ARTIFACT_CACHE_DIR` is a default: **Settings → Artifact cache** can change it at runtime.

| Variable | Default | Description |
|---|---|---|
| `ARTIFACT_CACHE_ENABLED` | `false` (`true` in every production setup in `deploy/`) | Turns the cache on. **Settings → Artifact cache** can switch it on or off and overrides this value. |
| `ARTIFACT_CACHE_DIR` | `/var/lib/depgate/artifacts` | Cache directory on local SSD. One directory per replica; never share it. |
| `ARTIFACT_CACHE_MAX_SIZE_GB` | none, required when enabled | Most disk the cache uses on each replica, in GB of 1024³ bytes. DepGate does not start when `ARTIFACT_CACHE_ENABLED` is `true` and no size is set here or in Settings. Never more than the disk's free space. |
| `ARTIFACT_CACHE_MAX_FILES` | `200000` | Most files on each replica. |
| `ARTIFACT_CACHE_MAX_AGE_DAYS` | `30` | Days after which a stored file is downloaded again. `0` turns it off. |
| `ARTIFACT_CACHE_MAX_IDLE_DAYS` | `7` | Days without a download after which a file is removed. `0` turns it off. |
| `ARTIFACT_CACHE_MAX_FILE_MB` | `1024` | Larger files are served but not stored. |

## Data sources

| Variable | Default | Description |
|---|---|---|
| `OSV_API_URL` | `https://api.osv.dev` | Vulnerability data. |
| `DEPS_DEV_ENABLED` | `true` | Fill missing licenses and publish dates from deps.dev, for public packages only. |
| `SCORECARD_ENABLED` | `true` | OpenSSF Scorecard lookups for Project health policies. `false` makes those policies never match. |
| `EPSS_ENABLED` | `true` | Daily EPSS sync. `false` leaves every EPSS score unknown. |
| `EPSS_FEED_URL` | FIRST's daily file | Point it at an internal mirror for air-gapped installations. |
| `EPSS_SYNC_INTERVAL_HOURS` | `24` | How often EPSS syncs. |
| `EPSS_STALE_AFTER_HOURS` | `72` | When the interface warns that EPSS data is old. |
| `MALICIOUS_FEED_URL`, `MALICIOUS_FEED_ARCHIVE_URL` | the public feed | Source of the malware list. Point them at a mirror for air-gapped installations. |
| `MALICIOUS_SYNC_INTERVAL_HOURS` | `1` | Hours between malware feed syncs. `0` disables the schedule. |

## Decision Ledger, Audit Log and log streaming

| Variable | Default | Description |
|---|---|---|
| `LEDGER_RETENTION_DAYS` | `180` | How long Decision Ledger rows are kept. `0` keeps them forever. |
| `AUDIT_RETENTION_DAYS` | `730` | How long Audit Log entries are kept. `0` keeps them forever. |
| `EVENT_STREAM_MAX_LEN` | `200000` | Events kept for a log streaming destination that falls behind. Older events are lost beyond it. |

## Webhooks and jobs

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_COALESCE_SECONDS` | `300` | Window in which identical `package_blocked` and `malware_requested` alerts are grouped. `0` sends each one. |
| `WEBHOOK_MAX_ATTEMPTS` | `8` | Attempts per webhook delivery. |
| `WEBHOOK_BACKOFF_MS` | `30000` | First retry delay; it doubles each attempt. |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | How long delivery history is kept. |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | `20` | Consecutive failures before a webhook is turned off. `0` never. |

## Monitoring and namespace protection

| Variable | Default | Description |
|---|---|---|
| `MONITOR_RETENTION_DAYS` | `90` | A version nobody downloaded for this many days drops out of the monitoring report. `0` keeps everything. |
| `MONITOR_MAX_ROWS_PER_POLICY` | `50000` | Rows kept per monitoring policy. |
| `NAMESPACE_COLLISION_INTERVAL_HOURS` | `24` | How often the namespace collision check runs while it is turned on. |

