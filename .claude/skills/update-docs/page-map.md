# Page map

Which source files each documentation page describes, and which screenshots it shows. Paths are relative to the repository root; pages are under `docs/`. Screenshot files are `docs/public/screenshots/<name>.png`; the "entry" is the key in `docs/scripts/screenshots.mjs` that captures them (run it with `node docs/scripts/screenshots.mjs <entry>`).

Keep this file current when you add a page, a screenshot or a source area.

## Getting started

| Page | Source | Screenshots (entry) |
|---|---|---|
| `index.md` (home) | Product scope as a whole | none |
| `guide/what-is-depgate.md` | Product scope; ecosystem list | `dashboard` (dashboard) |
| `guide/architecture.md` | Product scope, `deploy/`, repository and auth behavior (`routes/repositories.ts`, `plugins/auth.ts`, `services/gateway-config.ts`), real examples checked with Package check | Inline SVG components in `docs/.vitepress/theme/components/` (`ArchitectureOverview`, `DeploymentDiagram`, `FlowDiagram`); no screenshots |
| `guide/how-it-works.md` | `packages/backend/src/services/policy-engine.ts` (order of checks), `auth/roles.ts`, `ui/src/app/navigation.ts` | diagram `public/diagrams/request-flow.svg` (hand-written SVG) |
| `guide/quick-start.md` | `deploy/all-in-one/*.sh`, `deploy/common/*.sh`, starter policies (`migrations/0002_default_policies.sql`), policy form, Registry page | `login` (login), `policy-new-vulnerability` (policy-new-vulnerability), `registry-npm` (registry-npm) |

## Installation

| Page | Source | Screenshots |
|---|---|---|
| `install/requirements.md` | `deploy/README.md`, `deploy/*/.env.example`, default upstreams (`GET /api/admin/repositories`), Redis sizing notes | none |
| `install/docker.md` | `deploy/all-in-one/`, `deploy/app-only/`, `deploy/common/` (compose files, `.env.example`, scripts, READMEs) | none |
| `install/kubernetes.md` | `deploy/kubernetes/` (manifests, README), probes in `deploy/kubernetes/deployment.yaml`, `plugins/health.ts` | none |
| `install/https-and-networking.md` | TLS and proxy settings in `packages/backend/src/config.ts` and `index.ts`, `deploy/README.md` | none |
| `install/build-from-source.md` | `Dockerfile`, root `docker-compose.yml`, root `package.json` scripts, `.nvmrc`, `.env.example` | none |
| `install/database-migrations.md` | `packages/backend/src/db/migrations/` (runner, guards), `packages/backend/migrations/`, `packages/backend/scripts/migration-*.ts` | none |
| `install/operations.md` | `plugins/health.ts`, `plugins/metrics.ts`, job settings, `db/startup.ts` (startup lock), `services/events/retention.ts`, `deploy/*/README.md` | none |

## For developers

| Page | Source | Screenshots |
|---|---|---|
| `developers/connect-package-managers.md` | `ui/.../pages/settings/settings.component.ts` (`snippetFor`, `configureSteps`), proxy routes `routes/{npm,pypi,go,maven,nuget,cargo,composer,rubygems}.ts`, 403 body | `registry-npm`, `registry-pypi` (registry) |
| `developers/package-check.md` | `ui/.../pages/package-check/`, `routes/package-check.ts` | `package-check`, `package-check-blocked` (package-check) |
| `developers/waiver-requests.md` | `ui/.../pages/waivers/waivers.component.ts`, `request-waiver-dialog.component.ts`, `routes/waiver-requests.ts` | `waiver-request`, `waivers-user` (waiver-request) |
| `developers/ci-pipelines.md` | `routes/ci-tokens.ts`, `routes/accounts.ts` (service accounts), `routes/package-check.ts` | none |

## Security policies

| Page | Source | Screenshots |
|---|---|---|
| `admin/dashboard.md` | `ui/.../pages/dashboard/`, `routes/dashboard.ts` | `dashboard` (dashboard) |
| `admin/policies.md` | `ui/.../pages/policies/policies.component.ts`, `policy-view-dialog.component.ts`, `routes/policies.ts`, `services/repository-scope.ts`, `migrations/0002_default_policies.sql` | `policies` (policies), `policy-view` (policy-view) |
| `admin/create-policy.md` | `ui/.../pages/policies/policy-form.component.ts`, `policy-rules.ts`, `namespace-rule.component.ts` | `policy-new`, `policy-new-vulnerability`, `policy-new-license`, `policy-new-namespace` (policy-new) |
| `admin/policy-rules.md` | `policy-rules.ts`, `policy-form.component.ts`, `services/policy-engine.ts`, `cvss.ts`, `epss-rule.ts`, `license-expression.ts`, `scorecard.ts`, release type and age services | none |
| `admin/monitoring.md` | `ui/.../pages/monitoring/`, `routes/monitor.ts`, `services/monitor-service.ts` | `monitoring` (monitoring), `monitoring-report`, `monitoring-approve`, `monitoring-enforce` (monitoring-report) |
| `admin/exceptions.md` | `ui/.../pages/exceptions/` (incl. `add-exception-dialog`, `review-waiver-dialog`), `routes/exceptions.ts`, `routes/waiver-requests.ts` | `exceptions`, `exception-add` (exceptions); `waivers-review`, `waiver-approve` (waivers) |
| `admin/malware.md` | `ui/.../pages/malicious/`, `routes/malicious-packages.ts`, `services/malicious-sync.ts` | `malicious`, `malware-override` (malicious) |
| `admin/namespace-protection.md` | `namespace-rule.component.ts`, `services/namespace-*.ts`, `routes/namespaces.ts`, `routes/namespace-guard.ts` | `policy-new-namespace` (policy-new-namespace) |
| `admin/decision-ledger.md` | `ui/.../pages/audit/audit.component.ts`, `shared/event-labels.ts`, `shared/event-banners.component.ts`, `routes/events.ts`, `services/events/` (catalog, retention) | `ledger`, `ledger-detail` (ledger) |
| `admin/audit-log.md` | `ui/.../pages/audit/audit-log.component.ts`, `shared/event-labels.ts`, `routes/events.ts`, `services/events/catalog.ts`, `services/events/retention.ts`, `services/login-audit.ts` | `audit-log`, `audit-log-detail` (audit-log) |

## Administration

| Page | Source | Screenshots |
|---|---|---|
| `admin/repositories.md` | `settings.component.ts` (Repositories tab, Gateway security card), `repository-form.component.ts`, `routes/repositories.ts`, `routes/config.ts` | `settings-repositories`, `repository-add` (repositories) |
| `admin/artifact-cache.md` | `settings/artifact-cache-settings.component.ts`, `routes/artifact-cache.ts`, `services/artifact-cache/` | `settings-artifact-cache` (artifact-cache) |
| `admin/users.md` | `pages/access/` (`access.component.ts`, `users-tab`, `create-user-dialog`, `service-accounts-tab`, `create-service-account-dialog`), `routes/accounts.ts`, `auth/roles.ts` | `access-users`, `user-add` (users); `access-service-accounts`, `service-account-add` (service-accounts) |
| `admin/sso.md` | `pages/access/` (`signin-settings`, `sso-settings`, `sso-provider-page`, `sso-provider-view`, `sso-test-dialog`), `pages/login/login.component.ts`, `routes/sso-admin.ts`, `routes/sso.ts`, `services/sso-*.ts` | `access-sso` (sso), `sso-provider-new` (sso-provider-new), `sso-provider-saml` (sso-provider-saml), `sso-test` (sso-test, needs the Keycloak from `docs/scripts/docker-compose.yml`), `login` (login) |
| `admin/email.md` | `mail-settings.component.ts`, `routes/mail-settings.ts`, `services/mailer.ts` | `settings-email` (email) |
| `admin/webhooks.md` | `settings.component.ts` (Webhooks tab), `webhook-form-dialog`, `webhook-deliveries-dialog`, `services/webhook.service.ts` (event groups), `routes/webhooks.ts`, `services/webhook-delivery.ts` | `settings-webhooks`, `webhook-add` (webhooks) |
| `admin/log-streaming.md` | `settings/log-streaming.component.ts`, `settings/stream-destination-form.component.ts`, `routes/stream-destinations.ts`, `services/events/` (catalog, envelope, consumer, destinations) | `settings-log-streaming`, `log-streaming-add` (log-streaming) |
| `admin/jobs.md` | `jobs-settings.component.ts`, `pages/audit/jobs-feeds.component.ts`, `routes/jobs.ts`, `routes/epss.ts`, `services/jobs/scheduled.ts` | `settings-jobs` (jobs), `jobs-feeds` (jobs-feeds) |

## Reference

| Page | Source | Screenshots |
|---|---|---|
| `reference/configuration.md` | `packages/backend/src/config.ts`, `.env.example`, `deploy/*/.env.example`, `deploy/*/docker-compose.yml`, `deploy/kubernetes/configmap.yaml` | none |
| `reference/api.md` | `routes/*.ts` (schemas and tags), Swagger at `/api/docs` | none |
| `reference/troubleshooting.md` | Error messages in routes and proxy handlers | none |
| `reference/glossary.md` | Terms used across the docs | none |

## Diagrams

Architecture diagrams are Vue components (inline SVG) in `docs/.vitepress/theme/components/`, registered in `theme/index.ts` and styled by the `.dg-*` classes in `theme/custom.css`, so they follow light and dark mode and use the site fonts. Wrap each in `<DiagramFrame caption="…">` (caption and click-to-enlarge). Use `FlowDiagram` (`columns`, `labels`, `label` props) for simple left-to-right chains. Keep text at 12.5 px or larger in the 880-wide viewBox. Check both themes after a change.

## Shared UI

Changes to these affect almost every screenshot (recapture all):
`ui/src/app/app.component.html`, `components/sidebar.component.ts`, `navigation.ts`, `styles.scss`, `shared/*` components, the login page (`pages/login/`).
