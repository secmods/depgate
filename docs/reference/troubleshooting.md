# Troubleshooting

## Package installs

| Symptom | Likely cause | What to do |
|---|---|---|
| `401 Unauthorized` | The client sends no token, a wrong one, or an expired one. | Copy a fresh snippet from the **Registry** page. For CI, mint a new CI token. |
| `403 Package blocked` | A policy, the malware list or namespace protection blocked the version. | Read the reason in the message. Open [Package check](/developers/package-check) for an allowed version, or [request a waiver](/developers/waiver-requests). |
| `404` for an internal package | Namespace protection allows only internal remotes, and none of them has the package; or the client uses a repository without your internal remote. | Use the repository that includes your internal registry (often `all`). Check that the package is published internally. |
| `502 Upstream … is unavailable` | The upstream registry timed out or refused the connection. DepGate does not fall back to the next remote. | Check the remote with **Test connection** under **Settings → Repositories**, and the outbound proxy settings. |
| `503 Upstream … is unavailable: circuit breaker open` | The remote failed repeatedly, so DepGate stops calling it for a short time (`CIRCUIT_BREAKER_RESET_MS`, 10 seconds by default). `Retry-After` says when it tries again. | Retry after that time. If it keeps happening, check the remote as for a `502`. |
| Certificate errors (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SSL: CERTIFICATE_VERIFY_FAILED`, `PKIX path building failed`) | The client does not trust your CA. | See [Trusting your CA in package clients](/install/https-and-networking#trusting-your-ca-in-package-clients). |
| Go refuses the proxy URL | `go` sends credentials only over HTTPS. | Put DepGate behind TLS. |
| A new release is not available | A release age policy (cool-down) blocks it. | It becomes available automatically. Package check shows when. |

## Signing in

| Symptom | What to do |
|---|---|
| Forgot password | Use **Forgot password?** on the sign-in page. The link works once, for 60 minutes. |
| No invitation or reset email arrives | Check **Settings → Email** and send a test email. See [Email troubleshooting](/admin/email#troubleshooting). |
| The invitation link says *Link not valid* | It was already used or has expired. Ask a Security user to resend it. |
| Everyone was signed out and registry tokens stopped working | `JWT_SECRET` changed. Restore the previous value, or have everyone sign in again and copy new snippets. |
| Single sign-on refuses someone | The sign-in page says why. The **Sign in** entries in the [Audit Log](/admin/audit-log) have the details, and **Test sign-in** on the provider shows what DepGate receives. |
| An identity provider is saved but turned off | DepGate could not reach it, or no sign-in domain is allowed. The reason is shown on the provider; fix it and turn the provider on. |

## Installation

| Symptom | What to do |
|---|---|
| `docker compose up` stops with *Set … in .env* | A required setting is missing. See [Configuration → Required](/reference/configuration#required). |
| The container never becomes healthy | Run `docker compose logs app`. Most often the database or Redis is unreachable from the container; with the bundled stack, use `host.docker.internal` as the host. |
| `/readyz` reports an eviction policy other than `noeviction` | Set `maxmemory-policy noeviction` on Redis, or use a separate `QUEUE_REDIS_URL`. |
| HTTPS does not start | Check that `certs/tls.crt` and `certs/tls.key` exist, match, and are readable by user ID 1000. |
| Client IP addresses in the ledger are all the proxy's | Set `TRUST_PROXY` to the number of proxies in front of DepGate. |
| A log streaming destination shows **Auth failed** or **Retrying** | The row shows the destination's last answer. Fix the token or URL, then send a test event. Events are kept meanwhile. |

## Data feeds

| Symptom | What to do |
|---|---|
| A banner says EPSS data is stale | Open **Settings → Jobs**, check the last run of **EPSS scores sync**, then choose **Run now** on that row. Check outbound access to the EPSS feed. |
| The malware list is empty or old | Check the **Malicious feed sync** schedule under **Settings → Jobs**, and outbound access to github.com. |
| Package check shows *vulnerability data unavailable* | DepGate could not reach OSV. Check outbound access to `api.osv.dev`. |

## Getting help

When you report a problem, include the DepGate version, the relevant log lines (`docker compose logs app`), and for a blocked or failed install, the full error message and the time it happened, so the matching Decision Ledger entry can be found.
