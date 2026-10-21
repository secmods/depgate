# REST API

Everything you can do in the DepGate web interface, you can do through the REST API. Use it to manage policies as code, automate exception handling, feed the Decision Ledger into other tools, or check packages from a pipeline.

## Interactive documentation

Every DepGate installation serves its complete, up-to-date API reference (OpenAPI/Swagger) at:

```text
https://depgate.example.com/api/docs
```

You can read every endpoint, request and response there, and try calls directly from the browser.

## Authentication

Send a token in the `Authorization` header:

```text
Authorization: Bearer <token>
```

| Caller | Token | Obtained from |
|---|---|---|
| A person | Session token | `POST /api/auth/login` |
| A pipeline | Service-account key | **Access → Service accounts → Add service account** |
| A pipeline job | CI token (download and Package check only, at most 1 day) | `POST /api/admin/ci-tokens`, called with a service-account key |

Sign in to get a session token:

```bash
curl -sS -X POST https://depgate.example.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"security-team@example.com","password":"…"}'
```

The response contains `token` (for API calls, valid for one hour) and `registryToken` (for package clients). What a token may do follows the account's [role](/admin/users#roles): administrative endpoints require the Security role.

## Common tasks

### List policies

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://depgate.example.com/api/admin/policies?limit=20&offset=0"
```

### Create a policy

```bash
curl -sS -X POST https://depgate.example.com/api/admin/policies \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "name": "Critical vulnerabilities",
        "decision": "BLOCK",
        "mode": "enforce",
        "priority": 10,
        "conditions": { "cvssMin": 9.0 }
      }'
```

`mode` is `enforce` or `monitor`. `conditions` holds exactly one rule; see [Policy rules → API field names](/admin/policy-rules#api-field-names). Add `"repositoryIds": ["<id>"]` to limit the policy to repositories (IDs from `GET /api/admin/repositories`).

### Enforce a monitoring policy

```bash
curl -sS -X PUT https://depgate.example.com/api/admin/policies/<id> \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"enforce"}'
```

### Add an exception

```bash
curl -sS -X POST https://depgate.example.com/api/admin/exceptions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "ecosystem": "npm",
        "packageName": "lodash",
        "version": "4.17.20",
        "expiresAt": "2026-12-31T23:59:59Z",
        "reason": "Legacy service pinned; upgrade tracked in SEC-1423"
      }'
```

### Check a package

`POST /api/package-check` returns which versions the gateway would serve. It downloads nothing and never counts as a block. People, service accounts and CI tokens can call it.

```bash
curl -sS -X POST https://depgate.example.com/api/package-check \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ecosystem":"pypi","package":"requests","repository":"default","versions":["2.32.0"]}'
```

| Field | Required | Description |
|---|---|---|
| `ecosystem` | Yes | `npm`, `pypi`, `go`, `maven`, `nuget`, `cargo`, `composer` or `rubygems`. |
| `package` | Yes | Maven: `groupId:artifactId`. Composer: `vendor/package`. |
| `repository` | No | Repository key. Default `default`. |
| `versions` | No | Up to 20 specific versions to check. |
| `offset`, `limit` | No | Window over versions, newest first. Default 0 and 10, at most 50. |

The response contains `recommended` (the newest allowed stable version, with its `license`: `null` when none is declared, absent when it could not be loaded) and `versions`, each with `status` (`allowed`, `blocked` or `unknown`), `policyName`, `reasons`, `releaseType`, `publishedAt` and `vulnerabilities`. A `429` answer means the rate limit (30 checks per minute) was reached; `Retry-After` says when to retry.

### Read the Decision Ledger and the Audit Log

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://depgate.example.com/api/admin/decision-ledger?limit=100"
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://depgate.example.com/api/admin/audit-events?feature=policies&limit=100"
```

Both accept the filters of their pages as query parameters, such as `from`, `to`, `ecosystem`, `decision`, `repository`, `actor`, `feature`, `type` and `target`.

## Endpoint groups

| Group | Base path | Purpose |
|---|---|---|
| Auth | `/api/auth` | Sign in, invitations, password reset |
| Policies | `/api/admin/policies` | Create, update, delete and reorder policies |
| Monitoring | `/api/admin/monitor` | Monitoring reports, approvals, CSV export |
| Exceptions | `/api/admin/exceptions` | Exceptions |
| Waiver requests | `/api/waiver-requests` | Request, approve and reject waivers |
| Malware | `/api/admin/malicious-packages` | List, sync, override and add entries |
| Repositories | `/api/admin/repositories` | Remote and virtual repositories |
| Namespaces | `/api/admin/namespaces` | Check reserved names, collision check |
| Users | `/api/admin/users`, `/api/admin/service-accounts` | People and service accounts. Lists are paged like the others: `limit` (1–200), `offset`, `search`; the answer is `{ items, total }` |
| Single sign-on | `/api/admin/sso-providers`, `/api/admin/signin-settings`, `/api/auth/sso`, `/api/auth/saml` | Identity providers, allowed domains, the OIDC and SAML sign-in flows |
| CI tokens | `/api/admin/ci-tokens` | Mint (service accounts) and revoke (Security) |
| Webhooks | `/api/admin/webhooks` | Webhooks, deliveries, redelivery |
| Log streaming | `/api/admin/stream-destinations` | Destinations and test events |
| Artifact cache | `/api/artifact-cache` | Status, settings, purge |
| Jobs | `/api/admin/jobs` | Queues, schedules, failed jobs |
| EPSS | `/api/admin/epss` | EPSS data status and sync |
| Dashboard | `/api/admin/dashboard/stats` | Dashboard figures |
| Events | `/api/admin/decision-ledger`, `/api/admin/audit-events`, `/api/admin/job-runs`, `/api/admin/events/catalog` | Decision Ledger, Audit Log, job runs, and the list of event types |
| Package check | `/api/package-check` | Version check |

## Errors

Errors use standard HTTP status codes with a JSON body:

```json
{ "error": "…", "title": "…", "status": 403, "detail": "…" }
```

| Status | Meaning |
|---|---|
| `400` | The request is invalid. `error` says why. |
| `401` | No token, or the token is invalid or expired. |
| `403` | The token's role may not call this endpoint, or a package is blocked. |
| `404` | Not found. |
| `409` | A conflicting operation is running, such as a sync already in progress. |
| `429` | Rate limited. Wait for `Retry-After`. |

A blocked package download returns `403` with the policy and reasons, and `checkUrl`, a link to Package check for that version.
