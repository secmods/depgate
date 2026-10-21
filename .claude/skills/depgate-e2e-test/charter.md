# DepGate End-to-End Test Charter

You are the tester. Cover **every customer workflow** of DepGate for both roles: a **User**, the developer who installs packages and asks for waivers, and **Security**, who writes policies, reviews and administers. Run every case below, write the report described in [Report](#report), and when a case fails, find the likely cause and document it so that another agent can fix it. **Don't fix anything and don't make code changes** ([Section 7](#7-recording-failures)). A run is not finished while a failure is undocumented.

A run usually takes several sessions. Its state lives in `TEST_STATUS.md` in the repo root. `SKILL.md` says how to start a run or resume one; follow it every session, and never start again from case 0 on a resume.

Fixture versions were checked against the public registries on 2026-10-09. The charter was brought up to date on 2026-10-17 for the event split (Decision Ledger, Audit Log, Jobs & Feeds), Log Streaming, the new webhook alerts, the Access page, single sign-on (OIDC and SAML), EPSS, Project health and the repository form page (cases 38 to 44, and changes to earlier cases).

---

## 1. Ground rules

### 1.1 Three surfaces, and what each may prove
| Surface | Use it for | Counts as proof? |
|---|---|---|
| **Web UI** at `http://localhost:3050` | Every customer workflow in the [workflow matrix](#8-customer-workflow-matrix), at least once, signed in as the role that does it in real life | Yes. This is the primary proof. |
| **Package-manager clients** via `test_apps` ([Section 4](#4-how-to-download)) | Every download, which is how customers meet DepGate | Yes, for download results |
| **REST API** (`http://localhost:3050/api/...`, signed-in session token, a service-account key or a CI token) | (a) cases that test the API itself (case 3, the API half of case 4, case 25, case 34, the API steps of cases 38 to 43); (b) setup and teardown that repeats, **after** that workflow's UI path has passed once in this run (for example the per-ecosystem policies in cases 5, 7 and 8, and cleanup); (c) extra read-only checks next to a UI check; (d) diagnosing a failure | Only for (a). For everything else the result shown in the UI or the client decides. |

- Never edit the database or Redis directly.
- When you use the API for setup (b), say so in that case's report entry.
- Every row of the workflow matrix must be ticked by a UI step before the run counts as complete.

### 1.2 Keep the machine clean
- Downloads run inside the `test_apps` Docker images, so no package manager is installed on the host and no global config file (`~/.npmrc` and the like) is touched.
- Run every download from a fresh copy of `test_apps` with only the dependency under test ([Section 4](#4-how-to-download)). Each container starts with an empty cache, so a cached copy can never hide the gateway.

### 1.3 Test data
- Name every policy you create `qa-<rule>-<ecosystem>-<case>[letter]`, for example `qa-packages-npm-05` or `qa-license-npm-11b`. Rule slugs are `packages`, `release-type`, `release-age`, `vuln`, `license`, `namespace` and `health` (Project health). A Vulnerability policy with an EPSS condition is still `vuln`.
- **Policies are not limited to the ones the cases list.** Create any policy you judge useful to exercise a rule, a scope, a mode, an ordering or an edge case, in the UI or (where the charter allows the API) through the API. Extra policies still follow the `qa-<rule>-<ecosystem>-<case>[letter]` naming and are deleted at the end of the case.
- **Never create a policy that conflicts with what the run itself needs.** Before saving a Block policy, work out which packages the package-manager client needs in order to run at all, and keep those out of its scope. Examples: the Maven client and its plugins pull in `org.apache.commons:commons-*`, `org.codehaus.plexus:*` and similar, so a Packages policy must not name `commons-lang3` (the maven-dependency-plugin needs exactly 3.12.0), `commons-io` or other Apache Commons artifacts, and the Maven fixture is `jackson-databind`; a Maven-wide Release type policy also blocks the client's own pre-release plugin dependencies, so prove Maven for it with the direct request of section 4.3; the same goes for npm's own dependencies, pip's `setuptools`/`wheel`, Composer's `composer/*` packages and the like. A Packages policy blocks only the fixture under test, preferably as an exact package and version rather than a wildcard or an All-ecosystems policy. Do not stack a Block and an Allow on the same package unless the case is about priority order.
- **Ecosystem-wide rules and the client's own dependencies.** Release type, Release age, Vulnerability and License rules cannot be limited to a package name, so on Maven they also catch the artifacts `maven-dependency-plugin` needs (for example sisu `0.3.0.M1`, aether `0.9.0.M2`, plexus-i18n `1.0-beta-10`, xml-apis `1.0.b2`, which are pre-release, old, or carry no license), and `mvn` fails before it requests the fixture. That is DepGate working as designed, not a defect. Handle it as in [Section 4.3](#43-maven-with-ecosystem-wide-rules). The same applies to any other ecosystem whose client fetches its own tooling through the gateway.
- If a download fails with a policy named that you did not intend to be the cause (a client dependency was caught), treat it as a mistake in the test setup, not a product failure: change the setup, wait 6 seconds and run the step again.
- Give anything else you create a name or note starting with `qa-`: exceptions, waiver reasons, malware entries, webhooks, Log Streaming destinations (`qa-stream-<type>-<case>`), identity providers (`qa-oidc-42`, `qa-saml-43`), users, service accounts, CI tokens and repositories. Repositories made for repository scope are `qa-scope-<ecosystem>` (case 35); the stand-in internal registries of case 36 are `qa-ns-<ecosystem>`. A user's email is `qa-<name>-<case>@example.com`; nothing is delivered, Mailpit catches it. The standing fixture `user@depgate.local` is the only user without `qa-`, apart from the single sign-on people below.
- **Single sign-on people.** The Keycloak test realm has fixed accounts (`alice@acme.test`, `bob@acme.test`, `carol@acme.test`, `dave@acme.test`, `eve@gmail.com`, password `Passw0rd!`; see `SSO_TESTING.md`). Their names cannot carry `qa-`. Cases 42 and 43 create the DepGate rows for them and the allowed domain `acme.test`, and delete both at the end. Before case 42, any `*@acme.test` person or `acme.test` domain recorded at baseline is left alone and the case records that it reused it.
- **Wrong passwords.** Ten wrong passwords for one email within 15 minutes make that account wait 15 minutes ([rule 12](#3-product-rules-the-cases-enforce)). Never send more than 3 wrong passwords for `admin` or `user` within 15 minutes; test the limit only on a `qa-` account (case 41).
- **Reading email.** Read every message in the Mailpit web inbox (`http://localhost:8025`) and screenshot it; that is the proof. To copy a link out of a message you may use its API: `curl -s http://localhost:8025/api/v1/messages` (list) and `curl -s http://localhost:8025/api/v1/message/<ID>` (the `Text` field holds the link). Take the link from the message; never build one yourself. Before a case that counts messages, note the inbox count, and count only messages addressed to that case's `qa-` address. At the end of the case delete only your own messages: `curl -s -X DELETE 'http://localhost:8025/api/v1/search?query=to:qa-'`. Never use "Delete all" in Mailpit, because other messages in the inbox are not yours.
- Cases 29 to 32 change the Email settings. Record the original values first (case 29 step 1) and restore them exactly.
- Each case deletes what it created at the end of the case, unless the case says otherwise. Data left behind changes the result of later cases.
- After every policy save, edit, enable, disable or delete, **wait 6 seconds before the next download**. Downloads read a policy cache that can lag up to 5 seconds. Package check does not lag. Case 14 measures the lag on purpose.
- Change Settings (Registry, Repositories, Gateway security, Email, Jobs, Webhooks, Log streaming) and Access (Users, Single sign-on, Service accounts) only in the cases that say so, and put every setting back exactly as you found it.
- Never run `docker compose down -v`, never delete the `pgdata` volume, never purge the Decision Ledger or the Audit Log, never change `LEDGER_RETENTION_DAYS` or `AUDIT_RETENTION_DAYS`, and never revoke, disable or delete anything that does not start with `qa-` (the single sign-on people above excepted).

### 1.4 When something does not match
| Situation | What to do |
|---|---|
| The product behaves differently from the charter | **Fail.** Record it, do not fix it ([Section 7](#7-recording-failures)). |
| The charter contradicts the documented behaviour in the docs site (`docs/admin/*.md`, `docs/guide/*.md`, `docs/developers/*.md`, `docs/reference/*.md`), `test_apps/README.md`, `SSO_TESTING.md` or `requirements_*.md` | Do not change the product. Record **Charter discrepancy** with both texts quoted and continue. |
| The expected behaviour needs a product decision that no doc answers | Record **Blocked: needs decision**, list the options, continue with the cases that do not depend on it, and list the decision in the report. |
| An upstream registry or OSV is down or slow | Retry once after 60 seconds. If it is still down, record **Not run (upstream)**. Never count a missing upstream as a pass. |
| A fixture version no longer exists upstream | Pick the nearest equivalent and record the substitution. |

---

## 2. Environment

| Item | Value |
|---|---|
| Web UI | `http://localhost:3050` (the backend container serves the UI, the API and the registries on one port) |
| Backend and package registries | `http://localhost:3050` (Docker) |
| Start or rebuild | `docker compose up -d --build --remove-orphans backend` from the repo root, then wait until the UI loads and `docker compose ps` shows the services healthy |
| Security account | `admin@depgate.local` / `admin`. In this charter `admin` means this account. |
| User account | `user@depgate.local` / `usertest123` (passwords need at least 8 characters, so it is not `user`). In this charter `user` means this account. People sign in with an **email address**, never a username. It is created through the invitation flow (case 30 step 1) if it does not exist. |
| People and sign-in | **Access** in the sidebar (`/access`), tabs **Users**, **Single sign-on**, **Service accounts**. Old links `/settings?tab=users` and `?tab=sso` redirect there. |
| Mail inbox | Mailpit at `http://localhost:8025` (SMTP `1025`). DepGate (Docker) reaches it as `host.docker.internal:1025`, no TLS, no login, set under Settings → Email. Start it with `docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit` if it is not running. See `docs/admin/email.md`. |
| Identity provider (cases 42, 43) | Keycloak: `docker compose --profile sso up -d keycloak` (about 15 seconds to start). Issuer `http://keycloak.localhost:8180/realms/depgate`, OIDC client `depgate` / `depgate-dev-secret`, admin console `http://keycloak.localhost:8180/admin` (`admin` / `admin`), SAML metadata `http://keycloak.localhost:8180/realms/depgate/protocol/saml/descriptor`. No hosts-file entry is needed in Chrome; the backend reaches it by the same name. See `SSO_TESTING.md` parts 2 and 4. Stop it with `docker compose stop keycloak` when the case ends. |
| Event receiver (cases 39, 40) | `test_apps/log-receiver/server.mjs` (no dependencies): `TOKEN=qa-recv-token PORT=8099 node test_apps/log-receiver/server.mjs`, run in the background. The backend reaches it as `http://host.docker.internal:8099/ingest` (Bearer `qa-recv-token`). `GET /events` (same Bearer) lists what arrived, `DELETE /events` clears it. Any other token gets 401. |
| API docs | `/api/docs` (Swagger UI), linked from the sidebar's Help section for both roles |
| Documentation | `DOCS_URL` from `.env`, linked from the sidebar's Help section for both roles; hidden when `DOCS_URL` is unset |
| Download harness | `test_apps/` (Docker only; see [Section 4](#4-how-to-download)) |
| Evidence folder | `test-results/charter/` (screenshots, client output, webhook captures, CSV exports) |
| Report | `TEST_REPORT.md` in the repo root |

Before case 0, record `git rev-parse HEAD`, `git status --short`, the date and time, `docker --version`, and which `depgate-test-*` images already exist. The first build of the .NET and Rust images downloads about 1 GB each, so build all eight in case 0.

---

## 3. Product rules the cases enforce

1. **Roles.** Security's sidebar has four groups: *Overview* (Dashboard), *Security* (Malware Packages, Policies, Package check, Monitoring, Exceptions), *Audit* (Decision Ledger, Audit Log, Jobs & Feeds) and *System* (Registry, Access, Settings): twelve entries. User's has *Packages* (Package check), *Setup* (Registry) and *Access* (Waiver requests): three entries. Both roles also have a *Help* section at the bottom of the sidebar: Documentation (opens `DOCS_URL` in a new tab; absent when `DOCS_URL` is unset) and API docs (opens Swagger UI at `/api/docs`). Settings has the tabs Registry, Repositories, Email, Jobs, Webhooks and Log streaming; people, single sign-on and service accounts are under Access.
2. **One rule per policy.** A policy has one ecosystem (or All) and exactly one rule: Packages, Release type, Release age, Vulnerability (optionally with an EPSS condition), License, Namespace protection or Project health. The UI and the API both refuse a policy with no rule or with two rules. A Namespace protection policy needs exactly one ecosystem.
3. **Actions.** The Packages rule allows Allow or Block. Release type, Release age, Vulnerability, License, Namespace protection and Project health allow Block only.
4. **Mode.** A Block policy runs in Enforce mode or Monitor mode. An Allow policy cannot be set to Monitor.
5. **Versions.** In the UI, a version is either an exact version or a range with a start and an end (both inclusive), or a range open at one end. Free-form syntax such as `[3.0,3.13.0)`, `~> 2.2`, `^1.2` or `1.x` cannot be typed into the form. The API validates the same way and returns 400 for text it cannot evaluate. Ranges follow each ecosystem's own version ordering.
6. **Order.** Enabled, enforced policies are evaluated in priority order, lowest number first. The first match wins and is the only policy named as the reason.
7. **Package check changes nothing.** Each check writes exactly **one** Audit Log event, *Package checked* (`PACKAGE_CHECKED`, with the actor, IP and user agent), and nothing else: no Decision Ledger row, no monitoring hit, no dashboard count, no webhook call, and no Log Streaming event other than `PACKAGE_CHECKED` itself (only to a destination that selects it).
8. **Blocked download.** HTTP 403, with the deciding policy (or malware) named in the response, which the client prints, and a `checkUrl` to Package check.
9. **Allowed download.** The artifact is received. No resolved URL or redirect in the client's log contains an upstream host: `registry.npmjs.org`, `files.pythonhosted.org`, `pypi.org`, `proxy.golang.org`, `repo1.maven.org`, `repo.maven.apache.org`, `api.nuget.org`, `static.crates.io`, `index.crates.io`, `repo.packagist.org`, `codeload.github.com`, or `rubygems.org`. `sum.golang.org` is allowed, because the Go harness checks module checksums there on purpose.
10. **Monitor mode.** A matching monitor policy never blocks. The download is served and a hit is recorded on the Monitoring report.
11. **Licenses.** An approved-list policy and a deny-list policy are separate. One policy cannot hold both lists. For `A OR B`, one approved choice is enough, and a ban needs every choice banned. For `A AND B`, every part must pass. A package with no license counts as not approved unless "Allow packages with no license info" is selected.
12. **Accounts.** A person's identity is their email address (stored lower-case; `Ada@Corp.com` and `ada@corp.com` are one account). Security adds a person with an email and a role only and **never sees or sets a password**. DepGate emails an invitation link that works once and expires in 7 days; the person chooses their own password (8–128 characters). Until then the user list shows **invited** and they cannot sign in. A password reset link works once and expires in 1 hour; asking for a new link cancels the older one. "Forgot password" gives the same answer whether or not the address has an account. If mail is not set up or fails, Add user shows the admin the invitation link to pass on. Service accounts have no email and are unchanged. **Resetting a password ends every session signed in with the old one**, browser and registry token alike (this replaced the earlier documented limitation). Add user has a **Send a password invitation** box, ticked by default and unticked while single sign-on is on; unticked, the person is listed **Not signed in yet** instead of **Invited** and no email is sent. On the Users tab, **⋮** offers *Make Security* / *Make User* (signs the person out everywhere), *Disable* / *Enable* (a disabled person cannot sign in by any method, and their sessions and registry tokens stop at once), *Sign out everywhere*, *Resend invitation* and *Delete*. Nobody can change their own role or delete themselves, and the last Security user who can sign in cannot be demoted or deleted. Ten wrong passwords for one email within 15 minutes, or a hundred from one address, make sign-in wait 15 minutes. An account that **single sign-on created** (source *SSO*) has no password: password sign-in answers *This account signs in with single sign-on.*, Forgot password sends it nothing (the answer to the requester is unchanged), and Resend invitation answers 409. See `docs/admin/users.md`.
13. **Links in emails** start with `UI_URL` when it is set, otherwise with the address a signed-in Security admin signed in from. They are never built from the request that asks for the email.
14. **Repository scope.** A policy, an exception and a waiver apply to **All repositories** (the default, and how every existing policy behaves) or to **Selected repositories**: *Sources (remotes)* and *Team entry points (custom virtual repositories)*; **`all` is never offered** and the API refuses it. A policy on a **remote** applies to every package that remote **serves**, through its own URL, through `all` and through any custom virtual containing it; a policy on a **custom virtual** applies to everything downloaded through that URL. Exceptions follow the same rule. When the serving remote cannot be determined, every member's policies apply and member-limited exceptions do not. Scope does not change priority order; the first matching policy among those that apply to the repository wins. The malicious packages list ignores scope. Deleting a repository that is the **last** one a policy is limited to **disables** the policy (it never widens to every repository); an exception limited only to it is deleted and a pending waiver limited only to it is rejected. See `requirements_policy_scoping.md`.
15. **Namespace protection (dependency confusion).** Each remote repository has a Source, *Public registry* (the default for every remote) or *Internal registry*; `default` is always public. A name in a reserved namespace of an enforced Namespace protection policy is fetched **only from internal remotes**, through every repository including `all`: with no internal remote in the repository it is **blocked** (403, reason *… is in reserved namespace "X" and repository "eco/key" has no internal remote*); when no internal remote has it, the client gets **404** and the ledger a BLOCK row (*… was not found in internal remotes (…). Public remotes were not consulted.*). A higher-priority Allow policy and a global exception do **not** bypass it; Names under *Exceptions: allow from any remote* (`publicPackages`) and an exception **scoped to the namespace policy** do. Monitor mode changes nothing for clients and records a Monitoring hit when a public remote served a reserved name. Every allowed download's `ALLOW` event carries the remote that served it (`details.source`, for example `npm/qa-ns-npm`, type internal), which the allow tap shows ([Section 4.4](#44-the-allow-tap)); a blocked row in the Decision Ledger shows it as **Source**. A refusal by the namespace guard also raises `DEPENDENCY_CONFUSION_BLOCKED` (rule 18). Creating the policy takes effect at once, even for names already cached. The optional collision check is off by default. See `docs/admin/namespace-protection.md`.
16. **Repository security.** A virtual repository (`all` or custom) asks its remotes in its **search order** and moves to the next **only on a 404**; a remote that times out or refuses the connection stops the search with **502** (*Upstream eco/key is unavailable: …*), one whose circuit breaker is open with **503** and a `Retry-After` header, and an `UPSTREAM_UNAVAILABLE` ledger row; the next remote is never asked. The order of `all` is set in Settings → Repositories → Edit `all` (new remotes join the end). The form and the repositories list warn when a public remote comes before an internal one. A Namespace protection policy's **Serve only from** list ticks every internal remote by default; ticking any other set binds the names to exactly those remotes (public ones included). Package check shows *Searched in order* and *Served by*. See `docs/admin/repositories.md`.
17. **Background jobs.** Webhook deliveries, password reset emails, Monitoring rechecks and the five scheduled jobs (*Namespace collision check*, *Malicious feed sync*, *Monitoring and history retention*, *EPSS scores sync*, *Ledger and audit retention*) run on a job queue shared by every backend replica. A webhook event has one **event ID**, the same in every attempt and in a redelivery (`id` in the body, `X-DepGate-Event-Id`); a 5xx, 408, 425, 429 or timeout is retried (honouring `Retry-After`), any other 4xx fails at once. Settings → Webhooks → **Deliveries** shows each delivery's status and attempts and offers **Redeliver**. After 20 consecutive failed deliveries a webhook is **disabled automatically** (audited, a Dashboard notice); later events are *Skipped*. `policy_violation` and `integrity_violation` are no longer offered or sent. Webhook events are `package_blocked` (group *Packages*), `malware_requested`, `dependency_confusion_blocked` (group *Malware and attacks*) and `namespace_collision` (group *Namespace*); a new webhook starts with `package_blocked` and the two alert events ticked. **Identical** `package_blocked` or `malware_requested` events (same webhook, ecosystem, package, version, policy, repository) within `WEBHOOK_COALESCE_SECONDS` (default 300) are sent **once at once, plus one follow-up** at the end of the window carrying `occurrences`, `firstSeen` and `lastSeen`. Package payloads carry an optional `actor` (`name`, `ip`, `userAgent`, `metadata`). "Run now" and Sync are queued (202) and answer 409 while a run is queued or running; each scheduled job runs once per interval for the cluster. **Settings → Jobs** (Security only) shows queue health and schedules and links to **Jobs & Feeds**, which holds the run history. Downloads never wait on the queue and keep working when it is down. See `requirements_job_queue.md`, `docs/admin/jobs.md` and `docs/admin/webhooks.md`.
18. **Three event pages (event split).** The **Decision Ledger** (`/audit`, `GET /api/admin/decision-ledger`) stores only `BLOCK_ENFORCE` and `UPSTREAM_UNAVAILABLE` rows, plus an `ALLOW` row for an allowed download of a **malware-listed** version (red *Malware* tag). Artifact integrity checks were removed on 2026-10-18: older `INTEGRITY_VIOLATION` rows show as *Integrity violation (before 2026-10-18)*. **Allowed downloads are never stored row by row**, and Monitor-mode matches stay on the Monitoring page. The **Audit Log** (`/audit/log`, `GET /api/admin/audit-events`) holds every action by a person, API key or CI token: policies, exceptions, waivers, malware entries and overrides, users and access, sign-ins (password, OIDC, SAML), password resets, settings, repositories, webhooks, stream destinations, Package check, and Run now / Retry / Discard. **Jobs & Feeds** (`/audit/jobs`, `GET /api/admin/job-runs`) shows the job runs and the malware feed and EPSS status; feed syncs are no longer ledger rows. All three share one table: filters, a time range (24 h / 7 d / 30 d / custom), expandable rows, **Copy as JSON** (the event envelope `depgate.event/1`), paging (Rows per page, Go to page); the ledger and the Audit Log also have **Export CSV**. The ledger has a **Build** column (CI token metadata `buildId`, `build`, `pipeline` or `runId`, else the CI token's name). `GET /api/admin/audit-logs` remains for one release as an alias that returns **ledger** rows in the old shape. The Dashboard's figures come from hourly counts and reach it within about a minute; an allowed Maven download counts only the artifact (`.jar`, `.war`, …), not its POM or checksums, and Go only the module `.zip`; a refused POM or `.info` still counts as a block. `AUDIT_LOG_ALLOWS` is gone. See `requirements_event_streaming.md` §2, §4, §10 and `docs/admin/dashboard.md`.
19. **Log Streaming.** Settings → **Log streaming** sends any catalog event, `ALLOW` included, to destinations of type Splunk, Datadog, Elastic / OpenSearch, Sumo Logic, Syslog, **HTTP** (any endpoint: URL, POST or PUT, NDJSON or JSON array, gzip, CA, up to 20 headers each optionally **secret**) or **Container output (stdout)** (API type `jsonl`, one envelope per line with `"log":"depgate.event"`, at most one such destination). Add and Edit are pages (`/settings/log-streaming/new`, `/settings/log-streaming/<id>/edit`). **Events to send** is the catalog grouped by feature in sidebar order, tri-state per feature (and per tab for Access and Settings), with *Recommended* (everything except `ALLOW`, `BLOCK_MONITOR` and "completed" job runs), *Everything* and *Clear* presets and a search; `ALLOW` and `BLOCK_MONITOR` carry a *High volume* badge and selecting them shows a banner with the expected volume. **Send test event** works before saving and shows the receiver's status and reply. The list shows **Healthy**, **Retrying**, **Auth failed** (on 401 or 403, resuming by itself) or **Disabled**, events sent and dropped in 24 h, lag and last success. Secrets are write-only (`{"set": true}`) and never appear in the API, the Audit Log or logs. Every event has one `id` in every destination and on every retry; a destination that comes back gets the backlog. Webhooks are separate (signed alerts); the HTTP destination is unsigned. Creating, changing or deleting a destination writes `STREAM_DESTINATION_*` to the Audit Log. Security only. See `requirements_event_streaming.md` §9, §10.3, §10.4.
20. **Single sign-on.** Access → **Single sign-on** holds *Who may sign in* (**Allowed sign-in domains**, exact match; **Add new people automatically**, on by default) and the **Identity providers** (OIDC and SAML 2.0; Add and Edit are pages, `/access/sso/new`, `/access/sso/<id>/edit`, with a Summary showing the Redirect URI, or for SAML the SP entity ID and ACS URL). A provider cannot be turned on while the domain list is empty, and the domain list cannot be emptied while a provider is on. **The role always comes from Access → Users**, never from the provider: a listed person gets their role, an unlisted person in an allowed domain joins as User (source *SSO*) when automatic adding is on and is refused otherwise; another domain, a disabled person, an unverified email (OIDC with *Require email_verified*), a missing required claim or attribute, an answer that fails validation, or a replayed SAML response are refused with a plain message on the login page. The account is tied to the provider account (subject), not to the email. **Test sign-in** shows the claims and each check and signs nobody in. Password sign-in keeps working when the provider is down. Every attempt is an Audit Log event, *Sign-in succeeded* / *Sign-in failed*, with method (password, OIDC, SAML), provider and reason; at most 20 failed sign-ins a minute from one address are written. See `docs/admin/sso.md`, `SSO_TESTING.md` and `requirements_sso.md`.
21. **EPSS and Project health.** A Vulnerability policy may add an exploit-likelihood condition: **EPSS score at least N %** or **EPSS percentile at least P**, and *When a vulnerability has no EPSS score* (Block, the default, or Ignore). CVSS and EPSS apply to the **same** vulnerability. EPSS data comes from the daily *EPSS scores sync* (Settings → Jobs shows the score date, CVE count and source); Package check shows `EPSS n % · Pth` next to each vulnerability. A **Project health** policy blocks packages whose source repository has an OpenSSF Scorecard below **Overall score at least** (optionally individual checks), with *When a package has no Scorecard result* and *When Scorecard can't be reached* (Allow by default, or Block); the form starts in Monitor mode and the API refuses Allow, the `Webhooks` check and scores outside 0 to 10. See `docs/admin/policy-rules.md`.

---

## 4. How to download

Use the harness in `test_apps/`. Read `test_apps/README.md` first. Each ecosystem directory runs the official client inside Docker, signs in with the credentials you pass, takes the registry token from the sign-in (the same token the Registry page shows), and installs each listed dependency on its own. After each one it prints `RESULT ALLOWED`, `RESULT BLOCKED` or `RESULT ERROR`.

### 4.1 One download
```bash
RUN=test-results/charter/dl/<case>-<eco>-<n>
mkdir -p "$RUN"
rsync -a --exclude node_modules --exclude target --exclude vendor --exclude bin --exclude obj --exclude .nuget test_apps/ "$RUN/apps/"
# edit the manifest in $RUN/apps/<eco>/ so it lists ONLY the dependency under test (see table)
"$RUN/apps/<eco>/install_packages.sh" http://localhost:3050 'user@depgate.local:usertest123' 2>&1 | tee "$RUN/output.txt"
```
- Use `'admin@depgate.local:admin'` when the case says the download is made as Security, and `'<email>:<password>'` for the users created in case 25.
- For a repository other than `default`, pass its URL instead, for example `http://localhost:3050/npm/qa-repo/` (case 24).
- To rebuild a harness image, set `DEPGATE_REBUILD=1`.

| Ecosystem | Manifest to edit | Line format |
|---|---|---|
| npm | `npm/package.json` → `dependencies` | `"lodash": "4.17.20"` |
| PyPI | `pypi/requirements.txt` | `requests==2.25.0` |
| Go | `go/go.mod` → `require ( … )` | `github.com/pkg/errors v0.8.1` |
| Maven | `maven/pom.xml` → `<dependencies>` | `<groupId>…</groupId><artifactId>…</artifactId><version>…</version>` |
| NuGet | `nuget/Depgate.Nuget.Test.csproj` | `<PackageReference Include="Newtonsoft.Json" Version="12.0.1" />` |
| Cargo | `cargo/Cargo.toml` → `[dependencies]` | `serde = "=1.0.100"` |
| Composer | `composer/composer.json` → `require` | `"monolog/monolog": "2.0.0"` |
| RubyGems | `rubygems/Gemfile` | `gem "rack", "2.2.3"` |

To test several different packages in one run, list them all. Each one is installed and reported on its own. To test two versions of the **same** package, do one run per version, because most manifests can name a package only once.

### 4.2 What to check
1. **Blocked:** `RESULT BLOCKED`, the log shows HTTP 403, and the printed reason names the expected policy (or malware). Look for the `checkUrl` in the log. If the client does not print it, record "client does not show checkUrl" as an observation. Then confirm the `checkUrl` once per ecosystem with a direct API request for the same artifact (surface (c)).
2. **Allowed:** `RESULT ALLOWED`, the log shows the requested version, and no upstream host appears in the log (rule 9). Search for them: `grep -Ei 'registry.npmjs.org|pythonhosted|proxy.golang.org|repo1.maven|repo.maven.apache|api.nuget.org|crates.io|packagist.org|codeload.github|rubygems.org' output.txt`.
3. **`RESULT ERROR`** is never a pass. A 401 means a token or authentication problem. "from versions: none" from pip means the index is broken. Investigate both as failures.
4. **Transitive dependencies:** Composer, Maven and others may fetch dependencies of the package you asked for. Record them. Expect Decision Ledger rows only for those that were blocked; allowed ones show on the allow tap.
5. **Ledger (blocked downloads):** open **Decision Ledger** as Security and find the row for this download: package, version, ecosystem or repository, event *Block · Enforce*, and policy or malware as the reason. Also record, once per ecosystem, whether a refused metadata request alone writes a ledger row. It is not a failure either way, but case 20 needs to know when counting rows.
6. **Allowed downloads are not in the ledger** (rule 18). Where a step says what an allowed download records (the allowing policy, an exception, the repository, the serving remote), read its `ALLOW` event from the allow tap ([Section 4.4](#44-the-allow-tap)). An `ALLOW` row in the Decision Ledger for a version that is **not** malware-listed is a **Fail**. Only a malware-listed version allowed by an override or exception appears there, tagged *Malware*.

`test_apps/README.md` describes what each client does with blocked versions:
- npm, NuGet, Composer, Cargo and RubyGems keep a blocked version listed and return 403 on download.
- pip shows it as yanked with the policy sentence, then returns 403.
- Go and Maven leave it out of the version list, and return 403 when that exact version is requested.

Any difference from that description is a finding.

### 4.3 Maven with ecosystem-wide rules
Applies when a Maven (or All-ecosystems) policy uses Release type, Release age, Vulnerability or License, and also when case 13's All-ecosystems policy is enabled during a Maven download. Do this for each such step:
1. **Package check (UI)** decides the expected result for the fixture, as usual.
2. **Download the artifact directly** as the download check instead of `mvn` (this is API surface (b), say so in the case's report entry). Sign in as the case's role to get the registry token, then request the jar:
   ```bash
   TOKEN=$(curl -s -X POST http://localhost:3050/api/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"user@depgate.local","password":"usertest123"}' | sed -n 's/.*"registryToken" *: *"\([^"]*\)".*/\1/p')
   curl -s -u "_:$TOKEN" -o /dev/null -w '%{http_code}\n' \
     http://localhost:3050/maven/default/org/apache/logging/log4j/log4j-core/2.14.1/log4j-core-2.14.1.jar
   curl -s -u "_:$TOKEN" http://localhost:3050/maven/default/org/apache/logging/log4j/log4j-core/2.14.1/log4j-core-2.14.1.jar | head -c 2000
   ```
   Blocked: 403 with the expected policy and a `checkUrl` in the body. Allowed: 200 and a jar. Save the output in the case's `dl/` folder. The Decision Ledger checks in 4.2 apply unchanged.
3. Run `mvn` (the harness) **once** for the first such Maven step in the run, and record the result as the observation "Maven-wide <rule> blocks the client's own plugin dependencies", listing the artifacts and reasons from the Decision Ledger. Do not record it as a defect, do not repeat it in later cases, and do not add exceptions or approvals to work around it.
4. A `RESULT ERROR` from `mvn` in this situation is not a failure of the case. A wrong result from the direct request is.

Packages-rule policies on Maven (cases 5, 6, 7, 12, 14, 16, 17 and the like) still use `mvn` through the harness, as they name only the fixture.

### 4.4 The allow tap
Allowed downloads are only visible as `ALLOW` events on Log Streaming. The run keeps one destination for that, the **allow tap**, from case 0 to case 28:
1. **UI:** Settings → **Log streaming** → **Add destination**, type **Container output (stdout)**, name `qa-stream-jsonl-tap`. Under **Events to send** choose **Clear**, then tick only **Decision ledger → Allow** (it shows *High volume*) and **Monitoring → Block · Monitor**. Read the volume banner and save. The list shows it enabled.
2. If a Container output destination already exists at baseline (only one is allowed), do not change it. If it is enabled and already selects **Allow**, use it as the tap (filter by time and package when reading, because it also carries other events) and create nothing. Otherwise use an **HTTP** destination `qa-stream-http-tap` to the event receiver instead ([Section 2](#2-environment); URL `http://host.docker.internal:8099/ingest`, header `Authorization` = `Bearer qa-recv-token` marked secret, NDJSON), and restart the receiver at the start of every session. Record which tap the run uses in the Baseline.
3. **Read it** after a download (allow up to 5 seconds):
   ```bash
   docker compose logs --no-log-prefix --since 2m backend | grep '"log":"depgate.event"' \
     | jq -c 'select(.type=="ALLOW") | {time, target, policy, reasons, source: .details.source, actor: .actor.name}'
   ```
   For the HTTP tap: `curl -s -H 'Authorization: Bearer qa-recv-token' http://localhost:8099/events | jq '.list[].events[]'`. Save what you read in the step's `dl/` folder. The event names the package, version and repository (`target`), the allowing policy if any (`policy`), an exception that let it through (in `reasons` or `details`; record where the first time), and the serving remote and its type (`details.source`).
4. The tap is a `qa-` item that is **kept** between cases (Section 2 of the skill lists the carry-overs) and deleted in case 28. Cases that count Log Streaming events (39) account for it.

---

## 5. Fixtures

All of these exist upstream (checked 2026-10-09). In case 0, open each one in Package check to confirm it before the run starts.

| Purpose | Ecosystem | Package | Versions |
|---|---|---|---|
| Sample (old / newer stable) | npm | `lodash` | 4.17.20 / 4.17.21 (latest stable 4.18.1; 4.17.19 also exists) |
| | PyPI | `requests` | 2.25.0 / 2.32.3 |
| | Go | `github.com/pkg/errors` | v0.8.1 / v0.9.1 |
| | Maven | `com.fasterxml.jackson.core:jackson-databind` | 2.17.2 / 2.18.0 |
| | NuGet | `Newtonsoft.Json` | 12.0.1 / 13.0.3 |
| | Cargo | `serde` | 1.0.100 / 1.0.210 |
| | Composer | `monolog/monolog` | 2.0.0 / 3.8.0 |
| | RubyGems | `rack` | 2.2.3 / 3.1.8 |
| Pre-release | npm | `typescript` | 5.0.0-beta (stable: 5.6.3) |
| | PyPI | `django` | 5.0rc1 (stable: 5.0) |
| | Go | `google.golang.org/grpc` | v1.28.0-pre (stable: v1.28.0) |
| | Maven | `org.apache.logging.log4j:log4j-core` | 3.0.0-beta3 (stable: 2.24.3) |
| | NuGet | `Newtonsoft.Json` | 13.0.4-beta1 (stable: 13.0.3) |
| | Cargo | `serde` | 0.9.0-rc1 (stable: 1.0.210) |
| | Composer | `monolog/monolog` | 3.0.0-RC1 (stable: 3.8.0) |
| | RubyGems | `rack` | 3.0.0.rc1 (stable: 3.1.8) |
| Dev | PyPI | `requests` | 2.34.0.dev1 |
| | Composer | `monolog/monolog` | dev-main |
| Pseudo | Go | `github.com/pkg/errors` | v0.9.2-0.20260327151000-87f8819acf6d |
| Snapshot | Maven | none on Maven Central | Package check only; see case 8 |
| Critical vulnerability | npm | `minimist` | 1.2.5 and 1.2.0 (CVE-2021-44906, CRITICAL); 1.2.8 clean |
| | Maven | `org.apache.logging.log4j:log4j-core` | 2.14.1 (CVE-2021-44228, CRITICAL); 2.24.3 moderate only |
| High, not critical | npm | `lodash` | 4.17.20 (worst is HIGH) |
| Licenses | npm | `lodash` MIT, `typescript` Apache-2.0, `semver` 7.6.3 ISC, `jszip` 3.10.1 `(MIT OR GPL-3.0-or-later)`, `pako` 2.1.0 `(MIT AND Zlib)` | |
| Unmaintained | npm | `is-number` | last release 7.0.0 on 2018-07-04 |
| Recently released | npm | `@types/node` | releases every few days; read the newest version's publish date at run time |
| On npm and PyPI | npm, PyPI | `requests` | npm 0.3.0, PyPI 2.32.3 |
| On npm only | npm | `jszip` | not on PyPI (404) |
| Custom malware target | npm | `is-odd` | 3.0.1 |

Avoid `left-pad` (the dev database already holds an approval for it) and the npm `debug` and `chalk` packages (on the public malware feed).

---

## 6. Cases

For every case, record the fields listed in [Report](#report). "Check X" means open Package check in the UI for X and read the row for that version. **UI** marks a step that must be done in the UI. **API** marks a step done against the API on purpose.

### Case 0. Setup and baseline (Security)
Run once per run. Write everything it records into the **Baseline** section of `TEST_REPORT.md`; later sessions read it from there.
1. Record the environment details from [Section 2](#2-environment). Build the eight harness images: run each `test_apps/<eco>/install_packages.sh http://localhost:3050 'user@depgate.local:usertest123'` once, unchanged, and save the output. Record any ecosystem that does not reach `RESULT ALLOWED` for its unchanged dependencies. That is a baseline finding: investigate it as a failure before you rely on that ecosystem.
2. **UI:** Sign in as `admin`. **Access → Users**. Confirm that `user@depgate.local` with role User exists and can sign in with `usertest123`. If it does not, case 30 step 1 creates it through the invitation flow; do that first and record it. Also write down the other existing users with their role, status and source (they are not `qa-` data: leave them alone), and **Access → Single sign-on**: the allowed domains, *Add new people automatically*, and each identity provider with its protocol and whether it is turned on.
3. **UI:** Policies. Screenshot the list and write down every existing policy with its name, priority, ecosystem, rule, action, mode and enabled state. **Delete every enabled `qa-` policy** left by an earlier interrupted run (record each one). Then **disable every other policy that is enabled** (enforced and monitor alike), so that only this run's `qa-` policies decide. Case 28 turns them back on.
4. **UI:** Write down the existing Exceptions, Waiver requests, Malware custom entries, Webhooks (with their events and whether each is on), **Log streaming** destinations (type, events selected, status, enabled), Repositories (with each remote's Source and the order of each `all`), service accounts and legacy API keys, Gateway security values (including Namespace collision check), and Settings → Jobs schedules. Do not change them, and avoid their packages.
5. **UI:** Write down the Dashboard totals (24 hours), the newest Decision Ledger row (time and package), the newest Audit Log entry and the newest Jobs & Feeds run. This is the starting point for counting.
6. **UI:** Open each package and version in [Section 5](#5-fixtures) in Package check. Each must be listed, and with no `qa-` policies yet, Allowed. Substitute any version that is missing or flagged as malware, and record the substitution.
7. **UI:** Set up the allow tap ([Section 4.4](#44-the-allow-tap)) and record which one the run uses. Download npm `lodash` 4.17.21 as `user`: the tap shows its `ALLOW` event and the Decision Ledger has **no** row for it.

### Case 1. Sign in and sign out (UI)
1. The sign-in form asks for **Email** and Password (no Username field) and has a **Forgot password?** link. Wrong password for `admin`: you stay on the login page and see an error. A username-style entry such as `admin` is refused.
2. `admin` lands on Dashboard. Sign out returns to login. Pressing Back shows no Security content.
3. `user` lands on Registry after a plain sign-in (see `docs/admin/users.md`, Roles), and on the return URL when one was given (step 4).
4. Signed out, open a bookmarked Package check URL for npm `lodash`. Sign in as `user`: you land back on that check, already run.
5. Signed out, open `/policies`: you are sent to login. After signing in as `admin` you reach Policies.
6. Open a 403 `checkUrl` taken from case 5 while signed out. After sign-in you land on that package and version. Run this step right after case 5; until then case 1 is **Waiting (case 5)**.

### Case 2. Navigation and page access (UI)
1. As `admin`, open every sidebar entry. Each shows its title and either a list or an empty state. None shows an error banner, a blank page or a console error. Screenshot each.
2. As `admin`, the sidebar lists exactly the twelve entries in the four groups of [Section 3](#3-product-rules-the-cases-enforce) rule 1, and no others, then the Help section. **Documentation** opens the documentation site. **API docs** opens Swagger UI at `/api/docs` and lists the admin endpoints. **Settings** shows the tabs Registry, Repositories, Email, Jobs, Webhooks and Log streaming, and no Users tab; `/settings?tab=users` and `/settings?tab=sso` land on the matching **Access** tab.
3. As `user`, the sidebar lists only Package check, Registry and Waiver requests, then Help (Documentation, API docs). Each one loads.
4. As `user`, type each of these addresses directly: `/dashboard`, `/policies`, `/policies/new`, `/monitoring`, `/monitoring/1`, `/exceptions`, `/audit`, `/audit/log`, `/audit/jobs`, `/malicious`, `/access`, `/access/sso/new`, `/settings`, `/settings/repositories/new`, `/settings/log-streaming/new`. None of them shows Security content, not even for a moment. Record where each lands.
5. As `admin`, open `/waivers` and record what happens (it is a User-only page).

### Case 3. API access control (API)
The API is a customer surface too: service accounts and CI pipelines call it directly.
1. With no `Authorization` header: a policy list, a package-check request and an npm package document all return **401**.
2. With `user`'s session token (from `POST /api/auth/login`), each of these returns **403**:
   - create, update and delete a policy
   - create and delete an exception
   - create, update and delete a malware entry
   - approve or reject a waiver
   - list or change webhooks, users and service accounts; `POST /api/admin/users/<id>/revoke-sessions`
   - read or change Log Streaming destinations (`/api/admin/stream-destinations`, including `POST …/test`) and identity providers and sign-in settings (`/api/admin/sso-providers`, `/api/admin/signin-settings`)
   - change (create, edit, delete, PATCH) repositories and gateway settings; reading them is allowed, as the Registry page needs it
   - read the Decision Ledger (`/api/admin/decision-ledger` and the old `/api/admin/audit-logs`), the Audit Log (`/api/admin/audit-events`), Jobs & Feeds (`/api/admin/job-runs`, `/api/admin/jobs`), the event catalog (`/api/admin/events/catalog`), the Dashboard and the Monitoring endpoints
3. With `user`'s token, Package check, the Registry configuration and the user's own waiver requests work (2xx). `GET /api/auth/providers` (the login page's provider list) works with no token and lists only providers that are turned on, with no client secret, certificate key or issuer secret in the body.
4. With an invalid or expired npm tarball token, the tarball download is refused (no artifact).

### Case 4. Policy form and validation
**UI**, on npm, opening **New policy** once for each rule:
1. The action choices offered are exactly: Packages, Allow or Block; every other rule, Block only.
2. With the chosen rule's fields left empty, Create is blocked with a clear message. Saving with no rule chosen is also blocked.
3. Switching rules does not keep the old rule's values. Each saved policy shows exactly one rule.
4. Mode: Block can be set to Monitor. Allow cannot.
5. License: the form will not save an approved list and a deny list in the same policy.
6. Release type on npm: Snapshot, Dev and Pseudo are disabled and labelled "Not in npm". On All ecosystems they are enabled.
7. Versions: the field offers only Exact and Range (with start and end). Typing `[3.0,3.13.0)`, `~> 2.2`, `^1.2` or `1.x` into a version box marks it invalid and blocks Create. A range with only one end filled shows "Each range needs both a start and an end version", or is saved as open-ended (record which).
8. Create one valid policy per rule, named `qa-<rule>-npm-04`:
   - Packages, Block `is-odd`
   - Release type, pre-release
   - Release age, newer than 24 hours
   - Vulnerability, Critical
   - License, approved list MIT and Apache-2.0
   - Namespace protection, reserved `@qa-ns-acme` (ecosystem npm; with no internal remote yet the form warns that every reserved name will be blocked, and the summary says so)
   - Project health, overall score at least 5 (`qa-health-npm-04`; the form starts in Monitor mode: record that, then choose Enforce)

   Before confirming each one, record its summary sentence. After saving, the list shows the right name, action, ecosystem, rule text, mode and enabled state. Open **View** on each: it matches.
9. Edit one of them (change its priority and name), save, and confirm the list updates. Edit it again, change a field and leave the page by the sidebar: the form asks before discarding (*Discard changes?*); cancel stays, confirm leaves without saving.
9a. **UI:** Audit Log, Feature *Policies*: one *Policy created* per policy of step 8 and one *Policy updated* for step 9 with a summary of what changed, actor `admin@depgate.local`. The Decision Ledger has none of them.

**API** (as `admin`), each of these returns **400**, with nothing saved:
10. A policy with no rule.
11. A policy with two rules (for example a package list and release types).
12. Allow on Release type, Release age, Vulnerability, License, Namespace protection and Project health (six requests).
13. Mode Monitor with action Allow.
14. A License policy holding both an approved list and a deny list.
15. Release type `snapshot` with ecosystem npm.
16. Version ranges `[2.17,2.18)` on Maven (jackson-databind), `~> 2.2` on RubyGems and `1.x` on npm. **If the API accepts any of them**, Package check must evaluate it correctly (jackson-databind 2.17.2 Blocked, rack 2.2.3 Blocked). A range that is saved but matches nothing is a **Fail**.
16a. Project health with `scorecardMinScore: 11`, and with `scorecardChecks: [{"name":"Webhooks","minScore":5}]`. A Vulnerability policy with `epssMin: 1.5` (the score is a fraction from 0 to 1; record the message).
17. Delete every policy this case created. The Audit Log has a *Policy deleted* for each.

### Case 5. Packages rule, Block, all eight ecosystems
For each ecosystem's sample package (create npm's policy in the UI; the other seven may use the API):
1. `qa-packages-<eco>-05`: Block, exact old version, ecosystem set to that one ecosystem, priority 10. Wait 6 seconds.
2. **UI:** Check: the old version is **Blocked**, naming `05`; the newer version is **Allowed**.
3. As `user`, download the old version: `RESULT BLOCKED`, 403, policy named. Download the newer version: `RESULT ALLOWED`, with no upstream host in the log.
4. **npm only:** download `lodash@^4` (put `"lodash": "^4"` in the manifest). It resolves to an allowed version, not 4.17.20. Read `latest` on the npm package document (API (c)): it is not the blocked version.
5. **Composer only:** the downloaded `monolog/monolog` version in the log, and the version in the blocked ledger row and in the allowed tap event, all equal the version requested. This is a known open defect (download tokens can carry the wrong version).
6. **Maven only:** use `groupId:artifactId` in the policy and in Package check.
7. **UI:** Decision Ledger: one *Block · Enforce* row per blocked download, with the policy matching what the client printed, and **no** row for the allowed downloads (their `ALLOW` events are on the allow tap, [Section 4.4](#44-the-allow-tap)). No rows appeared at the times of the Package checks; the Audit Log has one *Package checked* per check instead.
8. Delete the policy.

### Case 6. Allow versus Block, and changing the order
Run on npm `lodash` (in the UI) and Maven `com.fasterxml.jackson.core:jackson-databind` (API setup allowed).
1. `qa-packages-<eco>-06a`: Allow, exact old version, priority 10. `qa-packages-<eco>-06b`: Block, all versions, priority 20.
2. Check: the old version is Allowed (through `06a`). Every other version is Blocked, naming `06b`.
3. Download the old version (served; its `ALLOW` event on the allow tap names policy `06a`) and the newer version (403, naming `06b`).
4. **UI:** On Policies, use the **move up / move down** controls to put `06b` above `06a`. The priorities update in the list. Wait 6 seconds, then repeat steps 2 and 3: now every version is blocked by `06b`.
5. **UI:** Toggle `06b` off from the list: the old version is allowed again. Delete both.

### Case 7. Version ranges and each ecosystem's version order
1. **UI**, npm: `qa-packages-npm-07a`: Block `lodash`, range 4.17.0 to 4.17.20, priority 10. `qa-packages-npm-07b`: Block `lodash`, exact 4.17.21, priority 20. Check and download:
   - 4.17.20: blocked, naming **only** `07a` (the end of the range is included).
   - 4.17.21: blocked, naming **only** `07b`.
   - 4.18.1: allowed.
2. **UI**, npm: edit `07a` to have two constraints, exact 4.17.15 **and** range 4.17.19 to 4.17.20. Check: 4.17.15, 4.17.19 and 4.17.20 are blocked, and 4.17.16 is allowed. Then make the range open-ended: from 4.18.0 only. 4.18.1 is blocked and 4.17.21 is not blocked by `07a`. Delete both.
3. For each other ecosystem, create a Block range (API setup allowed) and confirm with Package check:

| Ecosystem | Range | Blocked | Allowed |
|---|---|---|---|
| PyPI `requests` | 2.25.0 to 2.31.0 | 2.25.0 | 2.32.3 |
| Go `github.com/pkg/errors` | v0.8.0 to v0.8.1 | v0.8.1 | v0.9.1 |
| Maven `jackson-databind` | 2.17.0 to 2.17.2 | 2.17.2 | 2.18.0 |
| NuGet `Newtonsoft.Json` | 12.0.0 to 12.0.3 | 12.0.1 | 13.0.3 |
| Cargo `serde` | 1.0.0 to 1.0.150 | 1.0.100 | 1.0.210 |
| Composer `monolog/monolog` | 2.0.0 to 2.9.9 | 2.0.0 | 3.8.0 |
| RubyGems `rack` | 2.2.0 to 2.2.9 | 2.2.3 | 3.1.8 |

   Also download one blocked and one allowed version for Maven and RubyGems.
4. Pre-release ordering inside a range: RubyGems `rack` range 3.0.0.beta1 to 3.0.0.rc1 blocks 3.0.0.rc1 and does not block 3.0.0. Composer `monolog/monolog` range 3.0.0-RC1 to 3.0.0 blocks 3.0.0-RC1 and 3.0.0. Record any ordering that disagrees with the ecosystem's own client.
5. Delete every policy from this case.

### Case 8. Release type
1. For each ecosystem, `qa-release-type-<eco>-08`: Block pre-release (npm in the UI). Check the pre-release fixture: Blocked, and the reason names the release type. Check the stable fixture: Allowed. Download both. The blocked ledger row's reason names the release type. Delete the policy.
2. PyPI and Composer, Dev: `requests` 2.34.0.dev1 and `monolog/monolog` dev-main are Blocked with a dev reason. Download the PyPI one (403). For Composer dev-main, record what the client does.
3. Go, Pseudo: `github.com/pkg/errors` at the pseudo version is Blocked. Download it (403). v0.9.1 is served.
4. Maven, Snapshot: record the form and Package check behaviour only. The download is **Not run (no upstream snapshot)**. Do not repoint a repository to test it.
5. **UI:** **Select all** selects every type that applies to the chosen ecosystem, and only those.

### Case 9. Release age (UI for npm)
1. Check `@types/node` and record its newest version and publish date. `qa-release-age-npm-09a`: Block versions newer than N hours or days, with N chosen so that the newest version falls inside the window.
   - The newest version is Blocked. The reason mentions its age, and the row says "Can be checked again after <publish time + N>".
   - An older version outside the window is Allowed.
   - The recommended version is not the blocked one.
   - Download both. Delete the policy.
2. `qa-release-age-npm-09b`: Block packages with no release in 365 days. `is-number`: every version is Blocked by `09b`, and the download of 7.0.0 is 403. `lodash` is not blocked by `09b`. Delete the policy.
3. Composer `monolog/monolog` with step 1's policy (API setup allowed). If Package check reports the publish time as unknown or incomplete, record that **separately**. A version with no date must not show as plainly Allowed with nothing noted.

### Case 10. Vulnerability (UI for npm)
1. `qa-vuln-npm-10a`: Block Critical.
   - `minimist` 1.2.5 is Blocked. The CVE link (CVE-2021-44906) opens the OSV advisory.
   - `minimist` 1.2.8 is Allowed, and `lodash` 4.17.20 (HIGH only) is Allowed.
   - Download 1.2.5 (403, naming `10a`) and 1.2.8 (served). Delete the policy.
2. `qa-vuln-maven-10b`: Block `CVE-2021-44228` only. `log4j-core` 2.14.1 is Blocked by `10b`, and 2.24.3 is Allowed. Download both. Delete the policy.
3. OSV unavailable: **Not run (requires network fault)**, unless the environment offers a documented way to simulate it.

### Case 11. License (UI, npm)
1. `qa-license-npm-11a`: approved list MIT and Apache-2.0, priority 20. `lodash` and `typescript` are Allowed. `semver` 7.6.3 (ISC) is Blocked by `11a`. Download `semver` 7.6.3 (403) and `lodash` 4.17.21 (served).
2. `qa-license-npm-11b`: deny list `GPL-3.0-or-later`, priority 10. `jszip` 3.10.1 `(MIT OR GPL-3.0-or-later)` is not banned by `11b`, then MIT is approved by `11a`, so it is **Allowed**.
3. Edit `11b` so its deny list is `Zlib`. `pako` 2.1.0 `(MIT AND Zlib)` is Blocked by `11b`. Download it (403).
4. No license: find an npm package and version that declares none (record which). With `11a` it is Blocked. Select "Allow packages with no license info", and it is Allowed. If you cannot find one, **Not run (no fixture)**.
5. Delete both policies.

### Case 12. Rules of different types: priority (UI)
On npm `minimist` 1.2.5:
1. `qa-packages-npm-12a`: Allow `minimist` 1.2.5, priority 1. `qa-vuln-npm-12b`: Block Critical, priority 2. `qa-license-npm-12c`: approved list Apache-2.0 only, priority 3.
2. Check and download 1.2.5: served, with `12a` as the reason. Neither `12b` nor `12c` is named anywhere.
3. Disable `12a`: blocked, naming `12b` only. Disable `12b`: blocked, naming `12c` only. Disable `12c`: Allowed with no policy.
4. Re-enable all three: `12a` wins again. Delete all three.

### Case 13. All-ecosystems policy (UI)
1. `qa-packages-all-13`: ecosystem All, Packages, Block `requests`. npm `requests` 0.3.0 and PyPI `requests` 2.32.3 are both Blocked by `13`. Download both: 403.
2. Change the package name to `jszip`. npm `jszip` 3.10.1 is Blocked. PyPI `jszip` shows not found in Package check, and pip reports not found, not a policy 403.
3. Delete the policy.

### Case 14. Disable, edit and how fast changes reach downloads (UI)
1. `qa-packages-npm-14`: Block `lodash` 4.17.20. Check: Blocked.
2. Disable it. Package check shows Allowed **immediately**. Download right away (under 1 second) and again at 6 seconds. The 6-second download must be served. Record the observed lag.
3. Re-enable it: Package check Blocked immediately. The download is 403 by 6 seconds.
4. Edit the version to 4.17.21: by 6 seconds, 4.17.20 is served and 4.17.21 is 403.
5. Package check and the download agree at every step after the 6-second wait. Delete the policy.

### Case 15. Malware (UI)
1. Malware Packages: **Add** a custom entry for npm `is-odd` with reason `qa-malware-15`. **View** it, then **Edit** its reason and confirm the change shows.
2. Check `is-odd` as `admin` and as `user`: the malicious banner shows, no version is Allowed, no install command is offered, and there is no waiver or exception action.
3. Download 3.0.1 as `user`: 403. The ledger row attributes it to malware, not to a policy, and carries the red **Malware** tag; the **Malware** filter shows it.
4. **Override** (mark as a false positive) if the UI offers it on custom entries, or apply it to a feed entry. Record the result. Then **Delete** the custom entry. `is-odd` is Allowed and the download is served.
5. **Sync**: run a manual feed sync. It is queued, then finishes without an error, and the page shows the last-sync time and status (reload until it does). A second **Sync** while it runs is refused (the button is disabled, or the API answers 409). **Jobs & Feeds** lists the run (job *Malicious feed sync*, trigger *manual*, status *Succeeded*) and the feed's last success and entry count; the Decision Ledger has **no** sync row (rule 18). The Audit Log has *Job run requested* for it.

### Case 16. Exceptions (UI, Security)
1. `qa-packages-npm-16`: Block `lodash` 4.17.20.
2. Add an exception for npm `lodash` 4.17.20, reason `qa-exception-16`, from the **Exceptions page**. Delete it. Add it again from the **Package check row's Add exception** action. `user` does not see Add exception.
3. Check: Allowed, with the exception noted. Download: served; its `ALLOW` event on the allow tap names the exception. The Audit Log has *Exception added* (twice, step 2) and later *Exception revoked*. Open the exception's **detail** view: it shows who created it, why, its scope and its expiry.
4. Revoke the exception. By 6 seconds, the download is 403 naming `16` again.
5. Keep `qa-packages-npm-16` for case 17.

### Case 17. Waiver requests (UI: User asks, Security reviews)
1. As `user`, Package check `lodash`: on the 4.17.20 row, **Request waiver**. The form is prefilled with the ecosystem, package and version. Submit with reason `qa-waiver-17a`. Waiver requests lists it as Pending.
2. As `user`, on Waiver requests, use **Request waiver** from the page itself (not from Package check) for `lodash` 4.17.20 with reason `qa-waiver-17b`. Record whether a duplicate is allowed or refused, and confirm the message is clear. **View** one request.
3. As `user`, there is no way to approve a request, and `/exceptions` does not show the review screen.
4. As `admin`, Exceptions → the waiver queue: approve `qa-waiver-17a`. As `user`, the request shows Approved, the next check shows Allowed, and the download is served.
5. Edit `16` to the range 4.17.0 to 4.17.20. As `user`, request a waiver for 4.17.19 (`qa-waiver-17c`). As `admin`, reject it with a reason. As `user`, the request shows Rejected with that reason, and 4.17.19 stays blocked (403).
6. As `user`, cancel or withdraw any pending `qa-` request, if the UI allows that.
7. Delete `qa-packages-npm-16` and revoke the exception the approval created.

### Case 18. Monitor mode (UI)
1. `qa-vuln-npm-18`: Block Critical, Mode **Monitor**. Policies marks it as monitoring, and the sidebar Monitoring badge goes up by one.
2. As `user`, check `minimist`: 1.2.5 shows "Allowed · would be blocked by "qa-vuln-npm-18" (monitoring)".
3. As `user`, download `minimist` 1.2.5 and 1.2.0: both are **served**. The Decision Ledger has no row for them; the allow tap shows two `ALLOW` events and, because it selects *Block · Monitor*, two `BLOCK_MONITOR` events naming `18`.
4. As `admin`, open Monitoring: the list shows the policy with its counts. Sort the table by a column. Open **View** for the policy. The report lists `minimist` with the downloaded versions (counts may lag about 60 seconds; reload). Hits equal downloads, not Package check runs. Expand the row.
5. **Approve** 1.2.5 only (approve one version, with a reason). Confirm that `*` and ranges are refused for a vulnerability policy. **Approve checked** (bulk) is also offered. The approval appears under the report's approved packages and on Exceptions.
6. **Export** the report as CSV: it matches the rows shown.
7. **Edit policy** / **Edit rule** from the report opens the policy page (`/policies/<id>/edit`) with this policy loaded; Edit rule shows the suggested change, so Cancel asks *Discard changes?*. Discard: you are back on this report.
8. **Enforce** (read the dialog), then wait 6 seconds. 1.2.5 is served (approved). 1.2.0 is 403 naming `18`. Package check agrees.
9. Switch the policy back to Monitor, then **Restart** from the report's menu: the counts reset.
10. Delete the policy and the approval. The badge returns to its starting value.

### Case 19. Package check page (UI)
1. npm `lodash` as `user`:
   - The URL can be bookmarked, and reloading it runs the check again.
   - The last five checks appear as chips, and clicking one re-runs it.
   - **Allowed only**, **Hide pre-releases** and the version search each filter the table.
   - **Load more** fetches the next page with no duplicate rows.
   - `lodash` 99.0.0 shows a warning, not an error page.
2. `qa-packages-npm-19`: Block `lodash` 4.18.1. The recommended version becomes the newest allowed stable version. The copy button copies a working install command. Delete the policy.
3. The happy path for every other ecosystem: PyPI `requests`, Go `github.com/pkg/errors`, Maven `org.apache.commons:commons-lang3`, NuGet `Newtonsoft.Json`, Cargo `serde`, Composer `monolog/monolog`, RubyGems `rack`. The recommended version is stable, never a pre-release. Maven `log4j-core` must not recommend 3.0.0-beta3, even though Maven Central's metadata calls it the release. The install command matches the ecosystem's client syntax.
4. `admin` sees Add exception on blocked rows. `user` sees Request waiver.

### Case 20. Decision Ledger (UI)
Product rule 18. The ledger holds blocks, upstream outages and allowed malware only.
1. Filter by **Ecosystem**, **Event** (Block · Enforce, Upstream unavailable, Malware), **Repository**, **Auth** (CI token, API key, Registry token, Password, OIDC, SAML), **Policy**, **Actor or IP** and **Search by package**: only matching rows appear. Each row from this run matches what the client printed: package, version, repository, event, and policy or malware and reason. Open a row: **Reasons**, **Request** (Entry ID, Source, Policy, Actor, IP address, User agent, Auth method, Token metadata).
2. **Copy as JSON** on an open row: the clipboard holds one envelope (`"schema":"depgate.event/1"`, the row's `id`, `type` `BLOCK_ENFORCE`, `target`, `policy`, `actor`). Save it as evidence.
3. **Time range**: 24 h, 7 d, 30 d and a custom range each change the rows; a custom range with no data shows an empty state, not an error. **Clear filters** restores every row. Paging: **Rows per page** (10, 20, 50, 100) and **Go to page** work; the choice is remembered after a reload.
4. **Export CSV** with a filter applied: the file contains exactly the filtered rows.
5. Count the rows added since case 0 and compare with the number of **blocked** downloads made (including refused transitive and metadata requests you recorded). There must be **no** `ALLOW` row except for a malware-listed version, no admin change (policy, exception, user, setting), no sign-in, no feed sync and no row at Package-check times. Those are in the Audit Log and Jobs & Feeds (case 38).
6. **API (c):** `GET /api/admin/decision-ledger?limit=5` and the old `GET /api/admin/audit-logs?limit=5` return the same newest rows (the old path in the old shape). Record both.

### Case 21. Dashboard (UI)
Product rule 18: the figures come from hourly counts and reach the Dashboard within about a minute.
1. The totals (time range *24 hours*) have grown since the baseline by the allowed and blocked downloads of this run. **Allowed** grows for allowed downloads although the ledger has no row for them. Decisions by ecosystem, Top blocked and Top allowed name this run's packages. The refresh button reloads the data.
2. Package check runs are not counted (compare with case 20 and with the Audit Log's *Package checked* entries).
3. **Side files.** Note the Maven and Go **Allowed** figures. As `user`, download Maven `jackson-databind` 2.18.0 and Go `github.com/pkg/errors` v0.9.1 once each. After a minute: Go Allowed grew by exactly 1 (the `.zip`, not `.info` or `.mod`); Maven Allowed grew by the number of **jar** files the harness log fetched (record it), not by the POMs, checksums or parent POMs. Top allowed is not led by a parent POM.
4. Switch **Time range** to 7 days and 30 days: the figures are at least the 24-hour ones. If a range shows no data, it is an empty state, not an error.
5. If any webhook was turned off automatically, a notice at the top links to Settings → Webhooks (record whether one is shown; do not cause one).

### Case 22. Webhooks (UI, Settings)
Product rule 17.
1. Start a local receiver that writes each POST body and its `X-DepGate-Event-Id` and `X-DepGate-Delivery-Attempt` headers to `test-results/charter/webhooks/` (a few lines of Python with `http.server` and a `do_POST` handler). It answers **503 with `Retry-After: 1` to its first call** and 200 afterwards. It must be reachable from the backend container at `http://host.docker.internal:<port>/qa`.
2. Settings → Webhooks: **Add**. The form offers four events in three groups: *Packages* (`package_blocked`), *Malware and attacks* (`malware_requested`, `dependency_confusion_blocked`) and *Namespace* (`namespace_collision`), and **not** `policy_violation` or `integrity_violation`. A new webhook starts with `package_blocked`, `malware_requested` and `dependency_confusion_blocked` ticked (record it). Add `qa-webhook-22` pointing at the receiver with every event and signing secret `qa-whsec-22`. If the list shows a one-time hint about the new events, record it. **Send test event**: the toast reports the receiver's answer (the first call gets 503, so it reports a failure; send it again for *delivered*). Test events do not appear under Deliveries.
3. `qa-packages-npm-22`: Block `lodash` 4.17.20. Run Package check 5 times: the receiver gets **nothing**.
4. Download 4.17.20: the receiver gets a `package_blocked` call naming the package, version and policy. If the step 2 test calls used up the receiver's first answer, restart the receiver so this event meets the 503. Then within a few seconds the same event again with `attempt: 2`: **the same `id`** in both bodies and headers. The body has `actor.name` `user@depgate.local` with an IP and user agent. `X-DepGate-Signature` is the HMAC-SHA256 of the raw body with `qa-whsec-22` (check one with `python3 -c 'import hmac,hashlib,sys;print(hmac.new(b"qa-whsec-22",open(sys.argv[1],"rb").read(),hashlib.sha256).hexdigest())' <body file>`). Download 4.17.21: no call.
4a. **Coalescing** (rule 17): download 4.17.20 twice more within a minute. The receiver gets **no** new call at once. About 5 minutes after the first event of step 4, it gets **one** follow-up `package_blocked` for the same package with `occurrences` 3, `firstSeen` and `lastSeen` (record the exact values and time). Package check runs in between add nothing.
5. Webhook **Deliveries** (history icon): the event is *Delivered* with 2 attempts; filter *Failed* shows nothing; the payload view shows `id` and `attempt`, no signature. **Redeliver** it: the receiver gets the event again with the **same `id`**, and Deliveries has a new row.
6. **API (b):** `POST /api/admin/webhooks` with `events: ["policy_violation","package_blocked"]` answers with `events: ["package_blocked"]` and a `deprecations` note. Delete that webhook.
7. **Delete** `qa-webhook-22` and the policy, then stop the receiver. Automatic disabling (20 failures in a row) is covered by the integration tests; do not try to reach it here.

### Case 23. Registry page and client setup (UI)
1. As `admin` and as `user`, Registry lists all eight ecosystems. Switch between ecosystems and repository tabs. Every snippet points at this gateway, never a public host, and shows the signed-in role's token (masked or shown, as designed). **Copy URL** copies the gateway URL.
2. Follow the npm snippet **exactly as written** inside the npm harness image, with your own `.npmrc` made from the snippet rather than the harness's: `docker run --rm -it --entrypoint bash --add-host=host.docker.internal:host-gateway depgate-test-npm`, then install `lodash@4.17.21`. It works with no extra steps. Repeat for one Basic-auth ecosystem (PyPI). Record any step the snippet leaves out.

### Case 24. Repositories (UI, Settings)
1. Settings → Repositories → **Add repository** opens a page (`/settings/repositories/new?eco=npm`), not a dialog, with a **Summary** panel that shows the client URL. Add an npm repository `qa-repo` whose upstream is the public npm registry (the same as the existing default). **Test connection** succeeds. After **Create** the page becomes the edit page with a *Repository added* note and an **Open client setup** button; it opens `/registry?eco=npm&key=qa-repo` with that repository's snippet selected. The Repositories tab also has a **Client setup** button next to Add repository. Leaving the form with unsaved changes asks first.
2. Registry shows `qa-repo` with its own URL. Download `lodash` 4.17.21 through `http://localhost:3050/npm/qa-repo/`: served, and its `ALLOW` event on the allow tap has repository `qa-repo`.
3. `qa-packages-npm-24`: Block `lodash` 4.17.20, **Applies to: All repositories** (the default). The download through `qa-repo` is 403: a policy for all repositories applies to every repository of its ecosystem, including ones created after it. Repository scope itself is case 35.
4. **Edit** `qa-repo` (change its description or name) and confirm the change shows. The Audit Log has *Repository created* and *Repository updated* for it. **Delete** it. Downloads through its URL then fail as not found. Delete the policy.
5. **Remote credentials are stored encrypted and never shown.** Add npm remote `qa-repo-auth` (upstream as `default`), **Authentication** *Basic (username/password)*, username `qa-user-24`, password `qa-secret-24`. Save. **API (c):** `GET /api/admin/repositories` and the repository's own GET show the auth type (and the username if shown) but never `qa-secret-24`. **UI:** Edit: the password field is empty with a note that one is saved; save with it empty, then **API (c)** again: still set. The Audit Log entries for it, `docker compose logs backend | grep -c qa-secret-24` (0) and the Copy-as-JSON of its *Repository created* entry never contain the secret. Switch it to *Bearer token* `qa-token-24`, save, and check the same. Download `lodash` 4.17.21 through `http://localhost:3050/npm/qa-repo-auth/`: record the result (the public registry may ignore or refuse the stand-in credentials; a 401 from upstream must not be shown as a policy block). Delete `qa-repo-auth`.

### Case 25. Users and access (UI, Access, plus API for token use)
1. **People:** Access → Users → **Add user** `qa-user-25@example.com` with role User (an invitation, no password; finish it as in case 30 steps 2 and 6, password `qa-pass-25a`). Sign in as `qa-user-25@example.com`: you see the User sidebar. Request a waiver as `qa-user-25@example.com`: it appears only in that user's Waiver requests, not in `user`'s. **⋮ → Delete** `qa-user-25@example.com`. Signing in as it is refused, and its session (if still open) is refused on the next action. The Audit Log has *User created*, *Invitation accepted*, *Sign-in succeeded* and *User deleted* for it.
2. **Service accounts:** Access → **Service accounts** → **Add service account** `qa-sa-25`. The key is shown once, so copy it. The list later shows when it was last used. **API:** with `Authorization: Bearer <key>`:
   - `POST /api/admin/ci-tokens` with `{"name":"qa-ci-25","expiresIn":"1h","metadata":{"build_number":"qa-25","repository":"qa/charter"}}` returns a CI token (shown once). `expiresIn: "2d"` is refused (at most 1 day).
   - Package check works.
   - A policy request returns 403, and `POST /api/auth/login` cannot be used with it.
   - The npm `lodash` package document with the key itself: record the result (the docs say the key only mints CI tokens).
3. **CI token:** download through the npm harness image with the CI token in a hand-written `.npmrc`: `lodash` 4.17.21 is served, and its `ALLOW` event on the allow tap has `actor.kind` `ci_token`, `actor.name` `qa-ci-25` and the metadata. With `qa-packages-npm-25` (Block `lodash` 4.17.20, wait 6 seconds) the CI token's download of 4.17.20 is 403; **UI:** its Decision Ledger row shows **Build** `qa-ci-25` (or the build number; record which), Auth *CI token*, and Token metadata in the detail; the Auth filter *CI token* finds it. Delete the policy.
4. **Revoke:** **API:** `GET /api/admin/ci-tokens` lists `qa-ci-25`; `DELETE /api/admin/ci-tokens/<id>`: the CI token now gets 401 on the npm document. Mint a second one, then **Delete** `qa-sa-25`: the key now gets 401; record what the second CI token gets. The Audit Log has *Service account created*, *CI token created*, *CI token revoked* and *Service account revoked*.
5. **Legacy API keys:** on the Service accounts tab, confirm the *Legacy API keys* card lists the baseline keys (or is absent when there are none). Do not revoke any key that is not `qa-`.

### Case 26. Gateway security (UI, Settings)
Record the original values first, and restore each one immediately after its step.
1. **Token lifetime in days:** change it, save, reload: the new value is kept. Restore it.
2. The Gateway security card has no **Strict token mode** and no artifact integrity settings (both removed 2026-10-18). Download links in PyPI, Composer and RubyGems metadata carry no token and no upstream address (`/pypi/<repo>/files/<package>/<file>`, `/composer/<repo>/dist/<vendor>/<name>/<version>`, `/rubygems/<repo>/gems/<file>.gem`): download one of each twice, at least 20 minutes apart; both work.
3. After restoring, downloads behave exactly as at baseline (one npm and one PyPI download).
4. **Settings → Jobs** (product rule 17): Queues lists webhook deliveries, scheduled jobs, email and Monitoring rechecks with counts; Schedules lists the five jobs of rule 17 (*Namespace collision check*, *Malicious feed sync*, *Monitoring and history retention*, *EPSS scores sync*, *Ledger and audit retention*) with an interval and next run; the *EPSS scores sync* row shows the score date, the number of CVEs (over 100,000) and the source file. **Run now** on *Monitoring and history retention*: after **Refresh** its last run is *succeeded*, trigger *manual*, and **Jobs & Feeds** lists the run with its duration; the page links there. Press **Run now** twice quickly on one job: the second says it is already running (or both queue one run; record which). Failed jobs either says *No failed jobs* or lists them without any email address in full or any token. As `user`, `GET /api/admin/jobs` is 403 and the Settings page has no Jobs tab.

### Case 27. Package check writes only its audit event
Product rule 7. As `user`, run Package check 10 times across 3 ecosystems, against a blocked package (`qa-packages-npm-27`), a monitored one (`qa-vuln-npm-27b`, Monitor mode) and an allowed one, with the case 22 receiver running and a `qa-` webhook added (every event). Compared with counts taken just before:
- No new Decision Ledger rows.
- Dashboard totals are unchanged (wait a minute before reading them).
- No new hits on the Monitoring report.
- The webhook receiver gets nothing, and the allow tap gets no `ALLOW` or `BLOCK_MONITOR` event.
- **UI:** the Audit Log (Feature *Package check*) has exactly **10** new *Package checked* entries, actor `user@depgate.local`, each with the package, ecosystem, IP and **user agent** in the expanded row. Copy one as JSON: `type` `PACKAGE_CHECKED`, `category` `audit`.
- **API (c):** the same 10 checks with a CI token from a `qa-` service account (case 25 step 2): 10 more entries with `actor.kind` `ci_token`.

Clean up the policies, the webhook and the service account.

### Case 28. Cleanup and final regression
Run this case **last**, after case 44 (it numbers 28 for history only).
1. Delete every `qa-*` policy, exception, malware entry, webhook, Log Streaming destination (the allow tap last, after step 4), identity provider, user, service account, CI token, repository (including every `qa-scope-<ecosystem>` from case 35 and every `qa-ns-<ecosystem>` from case 36) and pending waiver. Settings → Gateway security → Namespace collision check is back at its case 0 value. Each page shows none. Cases 29 to 34 and 38 to 44 clean up after themselves; check that no `qa-` user, no `*@acme.test` person or `acme.test` domain that was not there at baseline, no changed Email or sign-in setting, no `qa-` message in Mailpit and no running Keycloak or event receiver is left.
2. Re-enable exactly the policies disabled in case 0, with the same priority, mode and enabled state. Compare with the case 0 screenshot.
3. Settings → Gateway security (including Namespace collision check), Repositories (including every remote's Source and the order of each `all`), Webhooks, Log streaming and Access → Single sign-on match the case 0 record.
4. Check npm `lodash` 4.17.20 and download it: same result as baseline.
5. The Decision Ledger and the Audit Log still hold this run's entries; Jobs & Feeds still lists this run's job runs.
6. If any code changed during the run (another agent fixing recorded defects), rebuild and **re-run cases 1–5, 12, 18, 19, 20, 22, 23, 27, 29–34, 36 and 38–42 in full**, plus every case that failed at any point. Then run `test_apps/run-all.sh http://localhost:3050 'user@depgate.local:usertest123'` and compare it with the case 0 baseline. Record all of this as the regression pass (row **28R** in `TEST_STATUS.md`; list the cases already re-run in its Last step done, so a resumed session does not repeat them).

### Case 29. Email settings (UI, Settings → Email, Mailpit)
Prerequisite: Mailpit is running ([Section 2](#2-environment)).
1. **UI:** As `admin`, Settings → **Email**. Record the saved values (host, port, TLS, username, whether a password is saved, From address). The tab has no "Address people use to open DepGate" field. Screenshot. Note the Mailpit inbox count.
2. **Send test email to me**: a success message names `admin@depgate.local`, and Mailpit shows one message to that address, subject `DepGate test email`.
3. Validation: a host with a space or `!` is refused; a port of 0 or 70000 is refused; a host with an empty From address is refused (Save is disabled or an error shows). Nothing is saved by a refused attempt (reload and compare with step 1).
4. Save again with the password field **empty**: "has a saved password" stays as it was and **Send test email** still works. No page, API response (**API** `GET` and `PUT /api/admin/mail-settings`) or message ever contains the password.
5. **Unreachable server:** set host `127.0.0.1`, port `1`, save. **Send test email** fails within about 30 seconds with a readable error (for example "Could not send: …"), not a blank page or a hang.
6. **User access:** as `user`, `/settings` does not show the Email tab, and the three Email endpoints (GET, PUT, POST test) return 403 (**API**); with no token they return 401.
7. **Restore** the step 1 values exactly. **Send test email** works again.

### Case 30. Add a person by invitation (UI: Security adds, the person accepts)
1. **Fixture:** if `user@depgate.local` does not exist, create it through steps 2 to 7 below with password `usertest123`, and keep it (it is not deleted in cleanup). Then use `qa-invitee-30@example.com` for the rest of the case.
2. **UI:** Access → Users → **Add user**. The dialog asks for **Email**, Role and a **Send a password invitation** box (ticked, unless single sign-on is on: record its state), and no password field. Add `qa-invitee-30@example.com`, role User, box ticked, **Send invitation**. The dialog says the invitation was sent. The list shows the person with status **Invited** and **⋮ → Resend invitation**. The create response (**API** check next to the UI step) has no password and no password hash.
3. **Mailpit:** exactly one new message, To `qa-invitee-30@example.com`, subject `You have been invited to DepGate`, with a **Set your password** button. Its link starts with the web UI address (`http://localhost:3050/set-password?token=`) and the text says it works once and expires in 7 days.
4. **Not yet active:** signing in as `qa-invitee-30@example.com` with any password is refused with the same error as a wrong password (nothing says the account is waiting).
5. **Duplicates and bad input:** adding the same email again, and the same email in capitals, are refused with a clear message. `not-an-email` is refused.
6. **Resend:** choose **⋮ → Resend invitation** on the invited row. A second message arrives. The **first** link now shows "Link not valid"; the second works. Open the second link (signed out, fresh session): the page names the email and says to set up the account. A password under 8 characters is refused; two different passwords are refused; after loading, the address bar no longer contains the token. Set `qa-pass-30a`: "Password saved" and a button to sign in.
7. **Sign in** as `qa-invitee-30@example.com` / `qa-pass-30a`: you land on the User pages with the User sidebar. Any other password is refused.
8. **Single use:** open the same link again: "Link not valid" with a way to request a new link. In the user list the person is **Active**, the Sign-in column shows *Password* and the time, and Resend is gone. **API:** `POST /api/admin/users/<id>/resend-invite` for this person returns 409.
9. **Security role:** add `qa-invitee-30b@example.com` with role Security, accept the invitation (`qa-pass-30b`), sign in: the Security sidebar shows. Sign out.
10. **Not run (record it):** an expired invitation link, because links last 7 days and the tester must not edit the database. Say so in the case details.
11. **Pending person deleted:** add `qa-invitee-30c@example.com`, do not accept, then delete the person. Their link now shows "Link not valid".
12. **No invitation:** add `qa-invitee-30d@example.com` with **Send a password invitation** unticked (**Add user**): status *Not signed in yet*, Mailpit receives nothing. **⋮ → Resend invitation** (if offered) sends one; record it. Delete the person.
13. **Audit:** the Audit Log (Feature *Access*, tab Users, and *Sign in*) has *User created*, *Invitation resent*, *Invitation accepted* and *User deleted* for this case's people, and no entry contains a token or a password.
Keep `qa-invitee-30@example.com` for case 31. Delete `qa-invitee-30b` now (`30c` and `30d` are already gone).

### Case 31. Forgot password and reset by email (UI)
1. **UI:** signed out, the sign-in page has **Forgot password?**; it opens a page asking for an email. An empty email is refused.
2. Enter `qa-invitee-30@example.com`: the page says that if the address has an account a link was sent. Mailpit has one new message, subject `Reset your DepGate password`, with a **Choose a new password** button; the text says it works once and expires in 1 hour.
3. **No leak:** enter `qa-nobody-31@example.com` (no account). The page shows exactly the same wording and Mailpit receives **nothing**. **API:** both `POST /api/auth/forgot-password` responses are identical. The real address in capitals reaches the real account.
4. **Reset:** open the link. The page names `qa-invitee-30@example.com` and says to choose a new password. Mismatch and a short password are refused. Set `qa-pass-31b`. Sign in with `qa-pass-30a` is refused; `qa-pass-31b` works.
5. **Single use, newest wins:** the link just used says "Link not valid" when opened again. Request two resets in a row: the **first** link is "Link not valid", the **second** works (set `qa-pass-31c`).
6. **Bad link:** `http://localhost:3050/set-password?token=garbage` and the page with no token both say "Link not valid".
7. **Sessions end on reset** (rule 12): sign in as `qa-invitee-30@example.com` in one browser session and take its registry token (`POST /api/auth/login` returns it; the npm `lodash` document answers 200 with it). Reset the password in another session through the link. The first browser session is sent to the login page on its next action, and the old registry token now gets 401. The Audit Log has *Sessions revoked* or the reset entry says so (record which).
8. **Pending invitation:** add `qa-pending-31@example.com` (do not accept). Use Forgot password with that address: the message is an **invitation** (`You have been invited to DepGate`), not a reset, and it works.
9. **Rate limit:** with a fresh address `qa-rate-31@example.com` (add it first; leave it pending), request a reset 6 times. The page answers the same each time, but Mailpit holds at most 5 messages for that address. Do this step last, because the limit lasts an hour for that address.
10. **Audit:** the **Audit Log** (Feature *Sign in*, or `GET /api/admin/audit-events?feature=signin`) has *Password reset requested*, *Password reset email sent* and *Password reset completed* naming the email, and the request for `qa-nobody-31` as well; none of the entries (or API responses, or Copy as JSON) contains the token or a password. The Decision Ledger has none of them.
Delete `qa-invitee-30@example.com`, `qa-pending-31@example.com` and `qa-rate-31@example.com` at the end of the case.

### Case 32. Add a person when email cannot be sent (UI)
1. **UI:** Settings → Email: set host `127.0.0.1`, port `1`, save.
2. Access → Users → **Add user** `qa-nomail-32@example.com`, role User. The dialog does **not** say the invitation was sent. It warns that the email could not be sent, shows the invitation link, and has **Copy link**. Mailpit receives nothing for this address.
3. Open the link from the dialog (fresh session), set `qa-pass-32a`, sign in: it works, exactly as with an emailed link.
4. Add `qa-nomail-32b@example.com`, close the dialog, then use **⋮ → Resend invitation** on the invited row: the dialog shows the link again. Settings → Jobs → Failed jobs and Jobs & Feeds: record whether the failed invitation email shows there, and that any email address in it is masked.
5. **Forgot password** for `qa-nomail-32@example.com` still shows the normal "if that address has an account" wording (no error to the requester) and Mailpit receives nothing.
6. Restore the Email settings from case 29 step 1. **Send test email** works. Delete both `qa-nomail-32*` users.

### Case 33. Where email links point (UI + API)
1. With the Email settings restored, links in the messages of cases 30 and 31 started with `http://localhost:3050`. Confirm in one new message.
2. **API (forged request):** `curl -s -X POST http://localhost:3050/api/auth/forgot-password -H 'Content-Type: application/json' -H 'Host: evil.example' -H 'Origin: https://evil.example' -d '{"email":"qa-invitee-33@example.com"}'` for an existing `qa-` user (add one first). The link in the message does **not** contain `evil.example`.
3. **API (the admin address is learned):** sign in as `admin` with `Origin: http://127.0.0.1:3050` (`curl` to `/api/auth/login`). A new reset message for the `qa-` user now links to `http://127.0.0.1:3050`. Sign in as `user` with `Origin: https://user.example`: the address does not change. Then sign in as `admin` with `Origin: http://localhost:3050` to put it back, and confirm the next message links to `http://localhost:3050`.
Skip steps 2 and 3 only if `UI_URL` is set on the backend, and note that (then it always wins). Delete the `qa-` user.

### Case 34. Account and mail endpoints: access control and leaks (API)
1. No `Authorization`: `POST /api/admin/users`, `POST /api/admin/users/<id>/resend-invite`, `GET` and `PUT /api/admin/mail-settings` and `POST /api/admin/mail-settings/test` return **401**. With `user`'s token they return **403**.
2. The public endpoints work without a token: `POST /api/auth/forgot-password` (200), `GET /api/auth/token-info?token=bad` (404 with a message), `POST /api/auth/set-password` with a bad token (400, the same message as an expired one) and with a 3-character password (400).
3. `POST /api/auth/login` for an invited person, for an unknown email and for a wrong password return the same status and message.
4. `POST /api/admin/users` with a `password` in the body: the password is ignored, and the person still has to accept the invitation.
5. Service accounts are unchanged (case 25 still passes): they have no email, cannot sign in, and cannot use any endpoint above.
Create the `qa-` user this case needs and delete it afterwards.

### Case 35. Policy scoping per repository (UI: Security, then User; all eight ecosystems)
Requirement: `requirements_policy_scoping.md`. Product rule 14. Fixtures: the sample old and newer versions of [Section 5](#5-fixtures). A repository `qa-scope-<eco>` is a **remote** whose upstream is the same public registry as that ecosystem's `default` (copy the upstream URL from the `default` row).

**Setup**
1. **UI:** Settings → Repositories → npm: **Add** `qa-scope-npm` (remote, upstream as `default`, description `qa-scope`). **Test connection** succeeds. **API** (surface (b), say so): create `qa-scope-<eco>` the same way for the other seven ecosystems.

**Scoped policy, npm (UI)**
2. Policies → **New policy** `qa-packages-npm-35`, ecosystem npm, priority 10. The **Applies to** field offers *All repositories* (selected) and *Selected repositories*. Choose *Selected repositories*: only npm repositories are listed, under **Sources (remotes)** (with *public* / *internal*) and **Team entry points (virtual)**. **`npm/all` is not listed.** Tick `qa-scope-npm`.
3. No warning about virtual repositories appears (a policy on a remote covers its packages through them). Untick everything: Create is blocked with "Select at least one repository, or All repositories." Tick `qa-scope-npm` again. **API:** `POST /api/admin/policies` with `repositoryIds` = the ID of `npm/all` returns **400** naming *npm/all cannot be chosen*.
4. Change the ecosystem to PyPI and back to npm: the form says it removed `npm/qa-scope-npm` (not in PyPI); tick it again. Record the wording.
5. Packages rule, Block `lodash`, exact 4.17.20. The Summary beside the form ends `…, in npm/qa-scope-npm.` and **Applies to** shows the `npm/qa-scope-npm` chip. Record the sentence. Save. The list's **Scope** column shows `npm/qa-scope-npm`; **View** shows it under Repositories. Wait 6 seconds.
6. **UI:** Package check, npm `lodash`, repository `qa-scope-npm`: 4.17.20 is **Blocked** by `35` with "Scoped to npm/qa-scope-npm"; 4.17.21 is Allowed. Repository `default`: 4.17.20 is **Allowed** and `35` is not named. Repository `all`: the page shows *Searched in order* with `npm/default` before `npm/qa-scope-npm` and *Served by npm/default*; 4.17.20 is **Allowed** (the package came from `default`, which `35` does not name).
7. As `user`, download `lodash` 4.17.20 three times: through `http://localhost:3050/npm/qa-scope-npm/` → `RESULT BLOCKED`, 403 naming `35`; through `http://localhost:3050` (default) → `RESULT ALLOWED`; through `http://localhost:3050/npm/all/` → `RESULT ALLOWED` (served by `default`).
7a. **Policies follow the serving remote.** Create `qa-packages-npm-35f`: Block `lodash` 4.17.20, *Selected repositories* → **`npm/default`**. Wait 6 seconds. Package check on `all`: 4.17.20 Blocked by `35f` with "Scoped to npm/default". Download through `http://localhost:3050/npm/all/` → `RESULT BLOCKED`, 403 naming `35f`; through `default` → 403; through `qa-scope-npm` → `RESULT ALLOWED` (that remote is not named). Delete `35f`.
8. **UI:** Decision Ledger, filter **Repository** `qa-scope-npm`: the 403 row names `35` and repository `qa-scope-npm`. Filter `default`: no row from step 7 (it was allowed). The allow tap's `ALLOW` events for the `default` and `all` downloads name no policy.

**All other ecosystems** (API setup allowed after step 5 passed, say so)
9. For PyPI, Go, Maven, NuGet, Cargo, Composer and RubyGems: `qa-packages-<eco>-35`, Block the sample **old** version, ecosystem `<eco>`, `repositoryIds` = the ID of `qa-scope-<eco>`. Wait 6 seconds. For each:
   - **UI:** Package check with repository `qa-scope-<eco>`: old version Blocked by `35` with "Scoped to <eco>/qa-scope-<eco>"; with repository `default`: Allowed.
   - Download the old version through `http://localhost:3050/<eco>/qa-scope-<eco>/` → `RESULT BLOCKED` (or, for Maven, the direct request of [Section 4.3](#43-maven-with-ecosystem-wide-rules) with `qa-scope-maven` in the path → 403), and through `http://localhost:3050` → `RESULT ALLOWED`.
   - Edit the policy (API) to `repositoryIds` = the ID of **`<eco>/default`**, wait 6 seconds, and download the old version through `http://localhost:3050/<eco>/all/` → **`RESULT BLOCKED`** (served by `default`, so its policy applies).
   - Record per ecosystem whether the client printed the policy and `checkUrl` for the scoped repository.
   Delete the seven policies afterwards.

**Policies list (UI)**
10. The toolbar **Repository** filter: *Applies to npm/qa-scope-npm* lists `35` and every enabled policy for All repositories that covers npm; *Applies to npm/default* does not list `35`. Move up / move down on `35` still works with the filter on (record the priorities).
11. **Edit** `35`: *Selected repositories* is preselected with `qa-scope-npm`. Switch to *All repositories*, review shows **All repositories** and the sentence has no "in npm/…" part. Save, wait 6 seconds: Package check on `default` now shows 4.17.20 Blocked by `35` and the download through `default` is 403. Edit it back to *Selected repositories* → `qa-scope-npm` and save. The **Audit Log** (Action *Policy updated*, or `GET /api/admin/audit-events?type=POLICY_UPDATED`) has "Scope changed from npm/qa-scope-npm to all repositories" and back.

**Exceptions and waivers**
12. **UI:** Exceptions → **Add exception** npm `lodash` 4.17.20, reason `qa-exception-35`, **Applies to** *Selected repositories* → `qa-scope-npm` (`npm/all` is not offered). The Exceptions list's **Repositories** column and the detail view show `npm/qa-scope-npm`. Temporarily create `qa-packages-npm-35b` (Block lodash 4.17.20, All repositories). Wait 6 seconds. Package check: `qa-scope-npm` → Allowed (exception); `default` → Blocked by `35b`. Download through both: served / 403. Then add a second exception `qa-exception-35g` limited to **`npm/default`**: the download through `http://localhost:3050/npm/all/` is **served** (the exception follows the serving remote). Revoke both exceptions and delete `35b`.
13. As `user`, Package check npm `lodash` on repository `qa-scope-npm`, 4.17.20 row → **Request waiver** (W27): **Applies to** is preselected with *Selected repositories* → `qa-scope-npm`. Submit with reason `qa-waiver-35a`. The request's view shows Repositories `npm/qa-scope-npm`.
14. As `admin`, Exceptions → waiver queue → `qa-waiver-35a` → **Approve**: the **Applies to** field is prefilled with `qa-scope-npm`. Approve as is. The created exception shows `npm/qa-scope-npm`. Wait 6 seconds: the download through `qa-scope-npm` is served; through `default` it is unaffected by the exception (record the result). Revoke the exception.
15. As `user`, request another waiver from Package check on `qa-scope-npm` for 4.17.19 (`qa-waiver-35b`). As `admin`, approve it with **Applies to** changed to *All repositories*. The exception shows All repositories. Revoke it.

**Repository deletion**
16. Create `qa-packages-npm-35c` (Block `lodash` 4.17.19) limited to `qa-scope-npm` **and** `default`, and an exception `qa-exception-35d` for `lodash` 4.17.18 limited to `qa-scope-npm` only. Settings → Repositories → `qa-scope-npm` → **Edit**: **Effective policies** lists `35` and `35c` ("This repository") and the enabled All-repositories npm policies ("All repositories"), in priority order. Cancel.
17. **Delete** `qa-scope-npm`. The confirmation names what changes: `35` will be disabled (only repository), `35c` will no longer apply to it, the exception `lodash@4.17.18` will be deleted. Confirm.
18. Policies: `35` is **Disabled** and its Scope shows **Deleted repository**; `35c` is enabled and scoped to `npm/default` only. Exceptions: `qa-exception-35d` is gone. The **Audit Log** has "Disabled: its only scoped repository "npm/qa-scope-npm" was deleted". **Enable** `35` from the list, wait 6 seconds: Package check on `default` does **not** name `35` (it never widened to every repository). **Edit** `35`: the form says the repository it was limited to was deleted and Create/Update is blocked until a repository or All repositories is chosen. Cancel.
19. Delete `35`, `35c`, every `qa-scope-<eco>` repository (Settings, or API for the seven non-npm ones), and any `qa-` waiver left pending.

**Monitor mode**
20. Recreate `qa-scope-npm`. `qa-vuln-npm-35e`: Block Critical, **Monitor**, limited to `qa-scope-npm`. Download `minimist` 1.2.5 through `qa-scope-npm` and through `default` (both served). Monitoring → `35e`: the report lists `minimist` 1.2.5 **only** from the `qa-scope-npm` download, with "Seen on qa-scope-npm"; the **Repository** filter `default` shows no rows. Delete `35e` and `qa-scope-npm`.


### Case 36. Namespace protection rule: dependency confusion (UI: Security, then User; all eight ecosystems)
Docs: `docs/admin/namespace-protection.md`. Product rule 15. The gateway has no private registry, so each ecosystem gets a stand-in **internal** remote `qa-ns-<eco>` whose upstream is the same public registry as `default` (copy the URL from the `default` row). DepGate cannot tell the two apart by content, so what proves the rule is **which remote served the request** (ledger *Source*), the 403 through `default`, and the 404 for a reserved name that exists nowhere. Reserved names and fixtures:

| Ecosystem | Reserved: exact sample name | Reserved: namespace that matches nothing | Ghost name (404) | Publicly published on purpose |
|---|---|---|---|---|
| npm | `lodash` | `@qa-ns-acme` | `@qa-ns-acme/billing` 1.0.0 | `@qa-ns-acme/eslint-config` |
| PyPI | `requests` | `qa-ns-acme-*` | `qa-ns-acme-auth` 1.0.0 | |
| Go | `github.com/pkg/errors` | `example.com/qa-ns-acme` | `example.com/qa-ns-acme/svc` v1.0.0 | |
| Maven | `com.fasterxml.jackson.core:jackson-databind` | `com.qansacme` | `com.qansacme:core` 1.0.0 | |
| NuGet | `Newtonsoft.Json` | `QaNsAcme.*` | `QaNsAcme.Billing` 1.0.0 | |
| Cargo | `serde` | `qa-ns-acme-*` | `qa-ns-acme-core` 1.0.0 | |
| Composer | `monolog/monolog` | `qa-ns-acme/*` | `qa-ns-acme/billing` 1.0.0 | |
| RubyGems | `rack` | `qa-ns-acme-*` | `qa-ns-acme-billing` 1.0.0 | |

Reserving an exact sample name keeps the client's own dependencies (Section 1.3) out of the namespace: only the fixture is reserved. Record each ecosystem's client output for the ghost name; a not-found error is the pass, a 403 or a download is a **Fail**.

**Setup: internal remotes**
1. **Before any policy:** as `user`, download npm `lodash` 4.17.21 through `http://localhost:3050/npm/all/`: `RESULT ALLOWED`. Its `ALLOW` event on the allow tap has `details.source` `npm/default`, type public, and the Decision Ledger has no row for it (`all` asks `default` first; this also warms the `all` cache with the public copy for step 10).
2. **UI:** Settings → Repositories → npm → **Add**: `qa-ns-npm`, remote, upstream as `default`, description `qa-ns`, **Source: Internal registry**. The form warns *"This looks like a public registry"* (expected here: the stand-in really is a public host; record the wording). Save. The list's **Source** column shows `qa-ns-npm` *Internal* with a warning mark and `default` *Public (fixed)*. **Edit** `default`: Source shows *Public (fixed)* and offers no choice; Cancel.
3. **UI:** Edit `qa-ns-npm`, set Source *Public registry*, save, then *Internal registry* again. The **Audit Log** (Action *Repository updated*, or `GET /api/admin/audit-events?type=REPOSITORY_UPDATED`) has *Source changed from internal to public* and back. **API (a):** `PUT /api/admin/repositories/<default id>` with `{"source":"internal"}` → 400 (*always public*); the same on `all` → 400. **API (b), say so:** create `qa-ns-<eco>` the same way for the other seven ecosystems with `"source":"internal"`.

**Policy form, npm (UI)**
4. Policies → **New policy** `qa-namespace-npm-36`, priority 10, ecosystem **All**, rule **Namespace protection**. The action offers **Block** only; the form says to choose one ecosystem and Create is blocked. Choose npm. The form suggests monitoring first.
5. **Your package names**: type `@qa-ns-acme-*`: it is marked invalid (*a scope is reserved whole*). Replace it with `@qa-ns-acme` and `lodash` (two tags). **Serve only from** lists the enabled npm remotes under **Internal registries** and **Public registries**: `npm/qa-ns-npm` is ticked, `npm/default` (under Public registries) is not, the help reads *Default: every internal remote, including ones added later*, and there is no "blocked" warning. *Exceptions* are folded away: click **Add exceptions** and add `@qa-ns-acme/eslint-config`.
6. Click **Test a name** (the unsaved policy, through `npm/all`): `@qa-ns-acme/billing` → *Downloaded only from npm/qa-ns-npm*, reason naming `npm/default` as not consulted; `@qa-ns-acme/eslint-config` → *Not one of your names*, *published publicly on purpose*; `lodash-es` → not one of your names (an exact name reserves only itself). Record each line. (The `default` repository's block is checked in Package check, step 9.)
7. Choose **Enforce**. The Summary beside the form lists *@qa-ns-acme* and *or lodash* under *Packages named:*, then *Served only from: internal remotes (qa-ns-npm)*, *Other remotes: blocked* and *From any remote: @qa-ns-acme/eslint-config*. Save. The list's rule text reads *Internal only: @qa-ns-acme, lodash · public: @qa-ns-acme/eslint-config*. **View** shows the reserved namespaces, the public package, and **Namespace collisions** *None found*. Wait 6 seconds.
8. **API (a)**, each returns **400** and saves nothing: ecosystem `["npm","pypi"]`; no ecosystem; `@acme-*` on npm; `github.com` on Go; `com` on Maven; `acme*` on PyPI; Allow; `publicPackages: ["left-pad"]` with reserved `@qa-ns-acme`; a policy with `reservedNamespaces` **and** `packageBlockList`.

**Package check and downloads, npm**
9. **UI:** Package check, npm `lodash`, repository `all`: the **Reserved internal namespace lodash** panel names `qa-namespace-npm-36`, *Served only from* `npm/qa-ns-npm`, *Not consulted* `npm/default`; 4.17.21 is Allowed. Repository `default`: *Blocked: internal namespace*, reason *… repository "npm/default" has no internal remote*, policy `36`, no version table. `@qa-ns-acme/billing` on `all`: *Not found in internal remotes … Public remotes were not consulted.* (no "Package not found" error page).
10. As `user`: download `lodash` 4.17.21 through `http://localhost:3050/npm/all/` → `RESULT ALLOWED`; through `http://localhost:3050` (default) → `RESULT BLOCKED`, 403 naming `36` with the reason (record whether npm prints it and the `checkUrl`); `@qa-ns-acme/billing@1.0.0` through `all` → npm reports not found (E404).
11. The allow tap: the step 10 `ALLOW` event has `details.source` `npm/qa-ns-npm`, type internal (step 1 showed `npm/default`, public, for the same name and repository: the policy took effect for a cached name at once). **UI:** Decision Ledger: the 403 row names `36` and its detail shows **Source**; the allow is not in the ledger. The 404 row is **Block** with *… was not found in internal remotes (npm/qa-ns-npm). Public remotes were not consulted.* Request the ghost three more times within a minute (API (c)): at most **one** more ledger row (D6 rate limit). Package check runs added no rows (rule 7).
12. **Bypass attempts (D4):** create `qa-packages-npm-36b` **Allow** `lodash`, priority 1, and a global exception `qa-exception-36` for npm `lodash` 4.17.21 (all policies). Wait 6 seconds. Download through `default`: still **403** naming `36`. Then add an exception for npm `lodash` `*` **scoped to policy `qa-namespace-npm-36`**: the Add exception dialog has no policy field, so use **API (b)** `POST /api/admin/exceptions` with `policyId` of `36`, `version: "*"`, reason `qa-exception-36b` (say so), then **UI:** View `36` → **Approved packages** lists it. Wait 6 seconds. Package check on `default` shows lodash no longer reserved; the download through `default` is served and its ledger Source is `npm/default (public)`. Revoke both exceptions and delete `36b`. Wait 6 seconds; `default` is 403 again.

**All other ecosystems** (API setup allowed after step 7 passed, say so; create **Go** in the UI)
13. **UI, Go:** create `qa-namespace-go-36` with `github.com/pkg/errors` and `example.com/qa-ns-acme`. The form shows *Go clients:* `GONOSUMDB=github.com/pkg/errors,example.com/qa-ns-acme`; its (i) tooltip says not to use GOPRIVATE. Record it. **API (b):** create `qa-namespace-<eco>-36` for PyPI, Maven, NuGet, Cargo, Composer and RubyGems with the two reserved entries from the table. Wait 6 seconds.
14. For each of the seven: **UI** Package check of the sample on `all` shows the panel with `<eco>/qa-ns-<eco>`, and on `default` the namespace block. Download the sample **newer** version through `http://localhost:3050/<eco>/all/` → `RESULT ALLOWED`, allow tap `details.source` `<eco>/qa-ns-<eco>` (internal); through `http://localhost:3050` → `RESULT BLOCKED` naming `36` (Maven: the direct request of [Section 4.3](#43-maven-with-ecosystem-wide-rules) with `/maven/default/…` → 403, and `/maven/all/…` → 200). The ghost through `all` → the client's not-found result, and a ledger Block row *not found in internal remotes*. Record per ecosystem whether the client printed the reason and `checkUrl`, and what it printed for the ghost.

**Monitor mode**
15. **UI:** edit `qa-namespace-npm-36` to **Monitor only**; the review sentence starts *Would serve npm packages in …*. Save, wait 6 seconds. As `user`, download `lodash` 4.17.21 through `default` → **served** (`RESULT ALLOWED`). Package check on `default` shows the panel *(monitor only)* and lists versions. **UI:** Monitoring → `36`: `lodash` 4.17.21 under the group *Reserved namespace lodash, served from a public remote*, reason *Served from public remote npm/default; enforcing would block it*. A download through `http://localhost:3050/npm/qa-ns-npm/` (served by the internal remote) adds no hit; one through `all` does, because `all` still asks `default` first in monitor mode. Switch `36` back to **Enforce** (read the dialog), wait 6 seconds: `default` is 403 again.

**Simulation (API (c))**
16. `POST /api/admin/policies/simulate` with the candidate `{ "name": "qa-namespace-npm-36", "decision": "BLOCK", "priority": 10, "conditions": { "ecosystem": ["npm"], "reservedNamespaces": ["lodash"] } }`: the figures now come from the package usage table (distinct package, version, repository and serving remote, flushed about every 30 seconds; wait a minute after step 15): `namespace.servedPublic` includes the step 1 and step 12 downloads, `servedInternal` the step 10 one, and `groups` names `npm/default` and `npm/qa-ns-npm`. Record the numbers; they may include `lodash` downloads from earlier runs within 90 days, but must never be lower than this case's distinct allowed downloads.

**Collision check**
17. **UI:** Settings → Repositories → Gateway security → **Namespace collision check** is at its case 0 value (off on a fresh install); its help says it sends internal names to public registries. Start the case 22 receiver and add webhook `qa-webhook-36` with event `namespace_collision`. Turn the check **on**. **API (b):** `POST /api/admin/namespaces/collisions/run` → **202** `{ queued: true, jobId }`; poll `GET /api/admin/namespaces/collisions/run/<jobId>` until `status` is `succeeded`: `checked` ≥ 1, `created` ≥ 1. A second run while one is queued answers 409. **UI:** View `36` → **Namespace collisions** lists `lodash` with the public latest version. The receiver got exactly one `namespace_collision` call naming `lodash` and `36`. Run it again: no new call. With the check **off**, the run's result is `skipped: "off"`. Restore the case 0 value; delete the webhook and stop the receiver.

**Cleanup**
18. Delete every `qa-namespace-*-36` policy, `36b`, the exceptions, the webhook and every `qa-ns-<eco>` repository. As `user`, `lodash` 4.17.21 through `default` is served again.

### Case 37. Repository security: search order, outages, order warning, bound namespaces (UI: Security, then User; all eight ecosystems)
Docs: `docs/admin/repositories.md`. Product rule 16. The gateway has no private registry, so `qa-sec-internal` is a second npm remote on the public registry marked **Internal registry** (the form warns that it looks public; record it and continue). `qa-sec-dead-<eco>` is a remote whose upstream is `http://127.0.0.1:9` (nothing listens there: a registry that is down). Name policies `qa-sec-<rule>-<eco>-37[letter]`.

**Search order of all (UI, R2)**
1. Settings → Repositories → npm: **Add** `qa-sec-internal` (upstream `https://registry.npmjs.org`, Source *Internal registry*). The repositories list shows the `all` row with its members in order, `default → qa-sec-internal` (or the order recorded at baseline with `qa-sec-internal` last), and a **warning icon** on `all`. Record the tooltip.
2. **Edit** `all`: a **Search order** list shows every enabled npm remote with move up / move down, and the warning *"Public registry default is searched before internal qa-sec-internal. A package published on registry.npmjs.org under one of your internal names would be taken from it. Move internal remotes first."* Move `qa-sec-internal` to the top: the warning disappears. **Update**. The row now reads `qa-sec-internal → default` and has no warning icon. **Audit Log** (Action *Repository updated*, or `GET /api/admin/audit-events?type=REPOSITORY_UPDATED`): *Order changed from … to …*.
3. **UI:** Package check npm `lodash` on repository `all`: *Searched in order: npm/qa-sec-internal → npm/default*, *Served by npm/qa-sec-internal*. Download `lodash` 4.17.21 through `http://localhost:3050/npm/all/` → `RESULT ALLOWED`; its `ALLOW` event on the allow tap has `details.source` `npm/qa-sec-internal`, type internal.
4. **Add** another npm remote `qa-sec-appended` (public): in `all` it is listed **last**. Delete it.
5. **API:** `PUT /api/admin/repositories/<all id>` with `memberKeys` missing an enabled remote → 400 *List every enabled remote of npm. Missing: …*; with a key twice → 400; with an unknown key → 400.
6. **Custom virtual order (UI):** Add a virtual `qa-sec-virt` with members `default` and `qa-sec-internal` (in that order): the **Search order** list and the same public-before-internal warning appear; reorder and save. Delete `qa-sec-virt`. Put `all` back to the baseline order (Edit → move) and record it.

**Outage: the search stops (R1, all eight ecosystems)**
7. **UI** for npm, API for the other seven (say so): create `qa-sec-dead-<eco>` (upstream `http://127.0.0.1:9`, timeout 3000, retries 0) and a virtual `qa-sec-out-<eco>` with members `qa-sec-dead-<eco>`, `default` in that order.
8. For each ecosystem, request the sample package's metadata through `http://localhost:3050/<eco>/qa-sec-out-<eco>/…` (npm packument, PyPI `simple/<name>/`, Go `@v/list`, Maven `maven-metadata.xml`, NuGet flat-container `index.json`, Cargo `api/v1/crates/<name>`, Composer `p2/<vendor>/<name>.json`, RubyGems `api/v1/versions/<name>.json`) → **502** with *Upstream <eco>/qa-sec-dead-<eco> is unavailable*. It is **not** served by `default`. One install through the harness (npm) → `RESULT ERROR` with the 502 (record the client's message).
9. **UI:** Decision Ledger, Event *Upstream unavailable*: a row names `qa-sec-dead-<eco>` per ecosystem (one per minute per remote, not one per request).
10. The same package through `default` is still served. Delete the eight virtuals, then the eight dead remotes.

**Policies follow the serving remote through all (R5, all eight ecosystems; API setup allowed)**
11. For each ecosystem: `qa-sec-packages-<eco>-37a`, Block the sample **old** version, limited to the `<eco>/default` remote. Wait 6 seconds. Download through `http://localhost:3050/<eco>/all/` (Maven: the direct request of [Section 4.3](#43-maven-with-ecosystem-wide-rules) with `all` in the path) → **403** naming `37a`. **UI** Package check on `all` for npm and one more ecosystem: Blocked with *Scoped to <eco>/default*. Delete the policies.

**Namespace bound to a remote (R6)**
12. **UI:** Settings → Repositories → npm → **Add** `qa-sec-bound` (upstream `https://registry.npmjs.org`, Source *Public registry*), standing in for a scope published on a second public registry. New policy `qa-sec-namespace-npm-37b`, rule **Namespace protection**, ecosystem npm, name `is-number`. In **Serve only from**, `npm/qa-sec-internal` (under Internal registries) is ticked by default. Untick it: the warning reads *Select at least one remote to download these names from.* and Create is blocked with the same text. Tick `npm/qa-sec-bound` (under Public registries) only: the *Default: every internal remote* help disappears. **Test a name** `is-number` → *Downloaded only from npm/qa-sec-bound*, reason *Served only from the remotes the policy allows (npm/qa-sec-bound); … not consulted*. Enforce; the Summary reads *Served only from: qa-sec-bound* and *Other remotes: blocked*. Save. **View**: *Served from: Only the remote the policy allows.*
13. As `user`: Package check `is-number` on `default` shows the block (*… has none of the remotes allowed to serve it*); download 7.0.0 through `default` → `RESULT BLOCKED`; through `all` → `RESULT ALLOWED` (served by `qa-sec-bound`, although `qa-sec-internal` is internal).
14. **API:** a policy with `allowedRemotes` containing the `npm/all` ID → 400 (*virtual repository*); with a PyPI remote's ID → 400 (*is not a npm remote*).
15. Settings → Repositories → **Delete** `qa-sec-bound`: the confirmation says namespace policy `37b` *allows only this remote: its names will be blocked everywhere until another remote is allowed*. Confirm. Download `is-number` through `all` → `RESULT BLOCKED` (never opened to every remote, nor to the internal `qa-sec-internal`). Delete `37b`, then `qa-sec-internal`.

### Case 38. Audit Log, Jobs & Feeds and the event split (UI: Security; API)
Product rules 7 and 18. Docs: `requirements_event_streaming.md` §10.2, §11, `docs/admin/jobs.md`. Note the newest Audit Log entry and Jobs & Feeds run first.
1. **UI:** **Audit Log** (`/audit/log`). Columns Time, Actor (name and IP), Action, Target (kind and name), Summary. Filters **Feature** (the catalog features in sidebar order), **Action** (follows the feature), **Target** kind, **Target name**, **Actor or IP**, and the time range. Screenshot.
2. **Make known events.** As `admin`: create `qa-packages-npm-38` (Block `lodash` 4.17.20, priority 10), change its priority to 5, disable it, delete it; add and revoke exception `qa-exception-38` (npm `lodash` 4.17.19); Settings → Gateway security: change the token lifetime and restore it; Settings → Jobs → **Run now** on *Monitoring and history retention*. As `user` (fresh sign-in): one wrong password, then the right one; one Package check of npm `lodash`.
3. Each step 2 action is one Audit Log entry with the right Action (*Policy created*, *Policy updated* twice, *Policy deleted*, *Exception added*, *Exception revoked*, *Gateway settings changed* twice, *Job run requested*, *Sign-in failed* with reason wrong password, *Sign-in succeeded* method password, *Package checked*), Target and Actor. The policy update's Summary says what changed (for example *Changed priority from 10 to 5*). Open one entry: Event ID, Reasons or Details, IP address, User agent, Auth method. **Copy as JSON**: `"schema":"depgate.event/1"`, `category` `audit`, `feature`, `type`, `actor`, `target`, the same `id` as the Event ID.
4. Filters: Feature *Policies* shows only policy events; Target name `qa-packages-npm-38` shows exactly its four; Feature *Sign in* shows the two sign-ins; Actor `user@depgate.local` shows the sign-ins and the check. **Clear filters**, time range and paging work as on the ledger (case 20 step 3). **Export CSV** with Target name `qa-packages-npm-38`: exactly four rows.
5. **None** of the step 2 events is in the Decision Ledger (filter the time window; rule 18).
6. **UI:** **Jobs & Feeds** (`/audit/jobs`): the malware feed card (Last success, Entries, Last error) and the EPSS card (Scores from, CVEs, Last success, Last error). The runs table shows Time, Job, Trigger, Status, Duration, Summary; filters **Job**, **Status** (Succeeded, Failed, Skipped, Running) and **Trigger**. The step 2 run is listed with trigger *manual* and status *Succeeded*; scheduled runs show their own trigger (record the word). Open a run: Run ID, result counts, queue job ID. **Copy as JSON**: `category` `job`. Settings → Jobs links here.
7. **API (a):** `GET /api/admin/audit-events?feature=policies&target=qa-packages-npm-38` returns the four entries; `?type=PACKAGE_CHECKED&actor=user@depgate.local` the check; `GET /api/admin/job-runs?job=monitor-retention-purge` the run; `GET /api/admin/events/<id>` returns the envelope for an audit entry and for a ledger row; `GET /api/admin/events/catalog` lists the features in sidebar order and every event type once (record the count); `GET /api/admin/events/status` (record the migration and retention state).
8. If the Decision Ledger or Audit Log shows a retention banner (*On <date>, <n> entries older than … days will be deleted*) or *Copying older entries: n %*, record it. Neither is a failure.

### Case 39. Log Streaming (UI: Security; event receiver)
Product rule 19. Docs: `requirements_event_streaming.md` §9.6, §9.7, §10.3, §10.4, §17. Start the event receiver ([Section 2](#2-environment)) and clear it (`DELETE /events`).
1. **UI:** Settings → **Log streaming**: the list shows the baseline destinations and the allow tap with name, type, status, sent and dropped (24 h), lag and last success. **Add destination** opens `/settings/log-streaming/new` with seven type cards: Splunk, Datadog, Elastic / OpenSearch, Sumo Logic, Syslog, HTTP, Container output. Record what the Container output card says when one already exists.
2. **HTTP destination** `qa-stream-http-39`: URL `http://host.docker.internal:8099/ingest`, method POST, body NDJSON, gzip on, headers `Authorization` = `Bearer qa-recv-token` marked **secret** and `X-Custom` = `qa-tenant-39` (not secret). Validation: a header named `Content-Type` is refused (DepGate sets it); a header name with a space is refused; URL `ftp://example.com` is refused. The form says in one line that this is not a webhook (unsigned, batched).
3. **Events to send:** choose **Recommended** and record the count line (*N of M events selected · K features*): Allow, Block · Monitor and the "completed" job events are unticked. Each feature row is tri-state with a count; Access and Settings show their tab names as sub-headings with their own boxes; each event shows its type in monospace. Search `SIGNIN` opens *Sign in*. **Everything** ticks all and shows the high-volume banner with an estimate per day (record it). Back to **Recommended**, then tick the whole *Decision ledger* feature (Allow included): the preset now shows *Custom*.
4. **Send test event** before saving: the form shows the receiver's status (200) and the start of its reply; the receiver holds one `STREAM_TEST` event. Save. Within a minute the status is **Healthy**.
5. **Events arrive.** As `user`: download `lodash` 4.17.21 (allowed); as `admin`: create `qa-packages-npm-39` (Block `lodash` 4.17.20), wait 6 seconds; as `user`: download 4.17.20 (403) and run one Package check. Within 10 seconds the receiver has `ALLOW`, `POLICY_CREATED`, `BLOCK_ENFORCE` (policy `39`) and `PACKAGE_CHECKED`. Each envelope has `schema`, `id`, `time`, `category`, `type`, `feature`, `severity`, `summary`, `actor`, `target` and `depgate.instance`. The request headers show `content-encoding: gzip` and `x-custom: qa-tenant-39`. The `BLOCK_ENFORCE` `id` equals the ledger row's Entry ID; the `POLICY_CREATED` `id` equals the Audit Log entry's Event ID; the `ALLOW` `id` equals the allow tap's event for the same download (same event, two destinations). The list's *sent* count grew.
6. **Secrets are write-only.** **API (c):** `GET /api/admin/stream-destinations/<id>` shows `header:authorization` as `{"set": true}` and `X-Custom`'s value. **UI:** Edit: the secret value is empty with a note that it is saved; save without it: delivery still works. No Audit Log entry (or its Copy as JSON), API response or `docker compose logs backend` line contains `qa-recv-token` (`grep -c` is 0).
7. **Auth failed and recovery.** Edit the secret header to `Bearer qa-wrong-39`, save, then run two Package checks. Within one batch the status is **Auth failed** (the receiver answers 401). Put `Bearer qa-recv-token` back and save: the status returns to **Healthy** by itself and the events made while it failed arrive (same `id`s; record how many and whether any came twice).
8. **Outage, no loss.** Stop the receiver. Create and delete `qa-packages-npm-39b` and download `lodash` 4.17.21 twice. The status becomes **Retrying** and the lag grows. After 2 minutes start the receiver again with the same `TOKEN`: within 5 minutes every event from the outage arrives (duplicates only with the same `id`), and *dropped* stays 0. Record the timeline.
9. **Selection is exact.** Edit: **Clear**, then tick only *Monitoring → Block · Monitor*. Create `qa-vuln-npm-39c` (Block Critical, **Monitor**), wait 6 seconds, download `minimist` 1.2.5 as `user`: the receiver gets `BLOCK_MONITOR` naming `39c` and nothing else (no `ALLOW`, no `POLICY_CREATED`). Delete the policy.
10. **Body format.** Edit: body **JSON array**, method **PUT**, gzip off. The next batch arrives as one JSON array, method PUT, without `content-encoding`. Record the `content-type`.
11. **Disable, enable, test from the list.** Turn the destination off: status **Disabled**; a Package check sends nothing. Turn it on; the row action **Send test event** works.
12. **Container output.** If the run's allow tap is the Container output destination, its `docker compose logs` lines start with `"log":"depgate.event"` and carry the same `id`s as the receiver for the step 5 `ALLOW`. Adding a second Container output destination is refused (UI or API; record the message).
13. **Delete** `qa-stream-http-39` and `qa-packages-npm-39`: the receiver gets nothing more. The Audit Log (Feature *Settings*, tab Log streaming) has *Destination created*, *Destination updated* (each edit) and *Destination deleted*. Stop the receiver unless the run's allow tap is the HTTP one.

### Case 40. Malware and dependency-confusion alerts (UI: Security, then User)
Product rules 17 and 18; `requirements_event_streaming.md` §8.5. Start the case 22 receiver, this time answering 200 to every call, and add webhook `qa-webhook-40` with **all four** events.
1. **Malware blocked.** Malware Packages → **Add** custom entry npm `is-odd` 3.0.1 (`qa-malware-40`). As `user`, download 3.0.1: 403. The receiver gets a `package_blocked` **and** a `malware_requested` (decision `BLOCK`, `malware` with the entry ID and source *custom*, `actor`). The Decision Ledger has **one** row for the download, with the *Malware* tag and the *Malware entry* in its detail.
2. **Malware allowed.** Use the entry's **Change decision / Override** action to allow 3.0.1 with reason `qa-override-40` (record the dialog). Wait 6 seconds. Download 3.0.1: served. The receiver gets `malware_requested` with decision `ALLOW` and **no** `package_blocked`. The Decision Ledger has an **`ALLOW`** row for `is-odd` 3.0.1 with the red *Malware* tag, and the **Malware** filter shows it (the only allowed download the ledger keeps, rule 18). The Audit Log has *Override · Allow*. Remove the override and delete the entry.
3. **Dependency confusion.** Create `qa-namespace-npm-40`: Namespace protection, npm, reserved `lodash` (no internal remote exists, so every reserved name is blocked; the form says so). Wait 6 seconds. Download `lodash` 4.17.21 through `default`: 403. The receiver gets `package_blocked` **and** `dependency_confusion_blocked` with the reserved pattern (`namespace`) and the policy. One ledger row. Delete the policy.
4. **Coalescing of alerts.** Recreate the step 1 entry; download `is-odd` 3.0.1 three times within a minute. The receiver gets one `malware_requested` and one `package_blocked` at once, and about 5 minutes later one follow-up of each with `occurrences` 3. Record the payloads. Delete the entry.
5. Webhook **Deliveries** for `qa-webhook-40` lists every event above as *Delivered*. Delete the webhook and stop the receiver.

### Case 41. Access: roles, disable, sign out everywhere, sign-in limit (UI: Security)
Product rule 12. Docs: `docs/admin/users.md`. Create, through the invitation flow of case 30, `qa-life-41@example.com` (User, password `qa-pass-41a`).
1. **The list.** Access → Users: columns Email, Role, Sign-in, Status. Search by part of an email filters the list. **Rows per page** (10, 20, 50, 100) and **Go to page** work, and the choice is kept after a reload.
2. **Change a role.** Sign `qa-life-41` in in a second browser session (B). As `admin`, **⋮ → Make Security** on it and confirm. Session B returns to the login page on its next action; signing in again shows the Security sidebar. **⋮ → Make User**. On `admin`'s own row, Make User and Delete are refused or not offered (record which).
3. **Disable.** Sign `qa-life-41` in in session B and take its registry token (`POST /api/auth/login`). **⋮ → Disable** (read the dialog): status **Disabled**; session B returns to the login page; the registry token gets 401 on the npm `lodash` document; password sign-in is refused (record the message). Forgot password for it shows the usual answer (record whether Mailpit gets a message). **⋮ → Enable**: sign-in works again.
4. **Sign out everywhere.** Session B signed in, plus a fresh registry token. **⋮ → Sign out everywhere**: both are refused at once; the person can sign in again straight away.
5. **Sign-in limit.** Ten wrong passwords for `qa-life-41@example.com` within two minutes, then the right one: refused with a *wait* message (record the status and wording). `admin` can still sign in meanwhile. The Audit Log has the *Sign-in failed* entries with their reasons (record the reason after the limit).
6. **Audit:** the Audit Log has *Role changed* (twice), *User disabled*, *User enabled* and *Sessions revoked* for `qa-life-41`, each with actor `admin@depgate.local`. Delete `qa-life-41`.

### Case 42. Single sign-on with OIDC (UI; Keycloak)
Product rule 20. Docs: `docs/admin/sso.md`, `SSO_TESTING.md` part 2 (its test table is the source of the expected messages). Start Keycloak ([Section 2](#2-environment)). Use a fresh private browser session for each person and sign out of DepGate between steps. Provider name `qa-oidc-42`, button label `Sign in with qa-oidc-42`.

**Setup (Security)**
1. **UI:** Access → **Single sign-on** → *Who may sign in*: add `acme.test` to **Allowed sign-in domains**, keep **Add new people automatically** on, **Save**. `*.acme.test` and `http://acme.test` are refused (record the messages).
2. Access → Users → **Add user** `alice@acme.test` role **Security** and `bob@acme.test` role **User**, each with **Send a password invitation** unticked (**Add user**): status *Not signed in yet*, no message in Mailpit.
3. Identity providers → **Add provider** opens `/access/sso/new`. Before anything is filled, the **Summary** shows the Redirect URI `http://localhost:3050/api/auth/sso/<id>/callback` with a copy button; **Show all URLs** adds the Initiate login URI and Post-logout URI. Enter name, button label, Issuer `http://keycloak.localhost:8180/realms/depgate` → **Discover** (says it signs with RS256), client ID `depgate`, secret `depgate-dev-secret`. Leaving with unsaved changes asks first. **Create provider**: the page becomes its edit page. **API (c):** the provider's GET shows the secret only as set, never `depgate-dev-secret`.
4. **Test sign-in** as `alice` in the window that opens: *Would sign in as alice@acme.test with role Security* with every check green. Test as `carol`: what a real sign-in would do (record it). Nobody is signed in and nothing is created (Users unchanged). Turn on **Show on the login page**.

**Signing in**
5. Login page: the email and password form, then **or**, then **Sign in with qa-oidc-42**. `GET /api/auth/providers` lists it.
6. `alice` → Dashboard (Security). Users: alice's Sign-in column names `qa-oidc-42`. `bob` → Registry (User); Settings is not available. Bob's Registry page shows a registry token; the npm `lodash` document answers 200 with it.
7. `carol` (not listed) → Registry; Users lists carol with the **SSO** tag, role User.
8. **SSO-only account** (rule 12): `POST /api/auth/login` for `carol@acme.test` with any password → 403 *This account signs in with single sign-on.*; Forgot password for carol shows the usual answer and Mailpit gets nothing; **API:** `POST /api/admin/users/<carol id>/resend-invite` → 409.
9. Turn **Add new people automatically** off, delete carol, SSO as `carol`: *You don't have a DepGate account yet.* Turn it back on.
10. `eve` (Gmail) → *Your account's domain is not allowed to sign in.* and eve is not added. `dave` → *Your identity provider has not verified your email address.*
11. Signed out, open `/policies`, choose the SSO button, sign in as `alice`: you land on **Policies**.
12. `carol` again (re-added). With carol signed in in one session, **⋮ → Make Security**: that session is signed out; SSO again → Dashboard. Make User. **⋮ → Disable** carol: SSO → *Your DepGate account is disabled.* **Enable** lets her in. **⋮ → Sign out everywhere** on `alice` while signed in: her next click returns to the login page.
13. Edit the provider: required claim `hd` = `acme.test`, save; SSO as `alice` → *Your account is not allowed to sign in to DepGate.* Remove the claim. Change the client secret to `qa-wrong-42`, save; SSO as `alice` → *Sign-in failed: the identity provider's answer could not be verified.* and the provider row shows the error. Put the secret back (record whether leaving the field blank on edit keeps the stored one).
14. `docker compose stop keycloak`; the SSO button cannot open Keycloak; password sign-in as `admin` still works. Start Keycloak again (`docker compose --profile sso start keycloak`).
15. Remove `acme.test` from the allowed domains while the provider is on: refused (turn the provider off first).
16. In the Keycloak admin console change alice's email to `alice2@acme.test`; SSO as `alice` still signs in as `alice@acme.test` (the account follows the provider subject). Change it back.
17. **Audit:** Audit Log, Feature *Sign in*: every attempt above as *Sign-in succeeded* / *Sign-in failed* with method OIDC, provider `qa-oidc-42` and reason (domain not allowed, unverified email, not invited, disabled, claim mismatch, response failed validation); *Identity linked* for alice and bob, *User provisioned* for carol; Feature *Access*: *Provider created*, *Provider updated*, *Sign-in settings changed*. None is in the Decision Ledger. Access → Single sign-on shows the provider's last successful sign-in.

**Cleanup**
18. Turn the provider off and delete it (Audit Log *Provider deleted*); delete alice, bob and carol (and any other `*@acme.test` or `eve@gmail.com` row this case created); remove `acme.test`; put *Who may sign in* back to its case 0 value. The login page shows no SSO button. Keep Keycloak running if case 43 is next.

### Case 43. Single sign-on with SAML 2.0 (UI; Keycloak)
Product rule 20. Docs: `docs/admin/sso.md` (SAML 2.0), `SSO_TESTING.md` part 4. Keycloak running; repeat case 42 steps 1 and 2 (domain `acme.test`, alice Security, bob User).
1. Access → Single sign-on → **Add provider**, protocol **SAML 2.0**, name `qa-saml-43`, button `Sign in with qa-saml-43`. The Summary shows the **SP entity ID** (`…/api/auth/saml/<id>/metadata`) and **ACS URL** (`…/api/auth/saml/<id>/acs`) before anything is filled. Copy both.
2. In the Keycloak admin console (realm `depgate`) create a SAML client exactly as `SSO_TESTING.md` part 4 step 4 says (Client ID = the SP entity ID, ACS URL, Sign documents and Sign assertions on, Client signature required off, Name ID format email, Force name ID format on). This is test-fixture setup, not DepGate; record it.
3. Back in DepGate: **IdP metadata → Metadata URL** `http://keycloak.localhost:8180/realms/depgate/protocol/saml/descriptor` → **Read metadata**: entity ID, SSO URL and the `CN=depgate` certificate (subject, issuer, SHA-256 fingerprint, expiry) fill in. **Sign authentication requests** turns itself on (the metadata asks for it): turn it off. **Create provider**, then **Test sign-in** as `alice`: *Would sign in as alice@acme.test with role Security*, with the NameID, its format and the attributes shown. Turn on **Show on the login page**.
4. Login page: a **Sign in with qa-saml-43** button. `alice` → Dashboard; `bob` → Registry; `carol` → Registry and listed with **SSO** (if carol also exists from OIDC, it is one account with both providers under Sign-in); `eve` → domain not allowed; `dave` → signs in (SAML has no verified-email flag; record). Signed out `/policies` then SAML as alice → Policies.
5. Required attribute `firstName` = `Nobody` → alice refused (*not allowed*); remove it.
6. **Replay:** capture a SAMLResponse form post from one sign-in (browser network log) and post it again: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -d 'SAMLResponse=…' -d 'RelayState=…' <ACS URL>` → a redirect to the login page with *state_invalid*; without RelayState the same. Audit Log: *Sign-in failed* with a validation reason.
7. **Signed requests** (optional, record if skipped): turn on **Sign authentication requests**, **Generate** an SP certificate, save, download **SP metadata** from the summary; in Keycloak turn *Client signature required* on and import the key from that file: sign-in works. The private key is never shown again (API (c): the provider's GET has no PEM private key).
8. **Audit:** Audit Log, Feature *Sign in*, method **SAML**: one entry per attempt with reason. Access → Single sign-on lists the provider with the IdP entity ID.
9. **Cleanup:** delete `qa-saml-43`, the Keycloak SAML client, alice, bob, carol, dave (and eve if added); remove `acme.test`; put *Who may sign in* back to its case 0 value; `docker compose stop keycloak`.

### Case 44. EPSS and Project health (UI: Security, then User)
Product rule 21. Docs: `docs/admin/policy-rules.md` (Vulnerability, Project health), `docs/admin/jobs.md` (EPSS data), `requirements_epss.md`, `requirements_scorecard.md`.

**EPSS**
1. **UI:** Settings → Jobs → *EPSS scores sync*: score date (within 3 days), CVEs (over 100,000), source file. If it says *Never synced*, **Run now** and wait for Jobs & Feeds to show the run succeeded. If the data is more than three days old, Policies shows a banner (record).
2. Package check npm `minimist` 1.2.5 and Maven `log4j-core` 2.14.1: each vulnerability shows `EPSS n % · Pth`. Record the EPSS of CVE-2021-44906 and CVE-2021-44228.
3. **UI:** New policy `qa-vuln-npm-44a`, Vulnerability, CVSS at least 9.0, tick **Exploit likelihood (EPSS)**, **EPSS score at least** a value just **below** CVE-2021-44906's score. Record the Summary sentence. Save, wait 6 seconds: `minimist` 1.2.5 is Blocked naming `44a`, with the EPSS value in the reason; 1.2.8 Allowed. Download 1.2.5: 403. Edit the threshold just **above** the score: 1.2.5 is Allowed (the CVSS 9.8 alone is not enough). **View** shows the EPSS condition.
4. Switch to **EPSS percentile at least** a percentile just below the recorded one: Blocked again. Then choose *When a vulnerability has no EPSS score*: **Ignore** and record the View text.
5. Maven: `qa-vuln-maven-44b`, CVE-agnostic, CVSS at least 9.0 and EPSS at least 50 % (API setup allowed). `log4j-core` 2.14.1 is Blocked (direct request of [Section 4.3](#43-maven-with-ecosystem-wide-rules) → 403), 2.24.3 Allowed. Delete both policies.
6. **No EPSS score:** find a vulnerable version whose advisory has no CVE (for example a GHSA-only advisory; record which) and check it with *Block the version* (Blocked) and *Ignore it* (Allowed). If none is found, **Not run (no fixture)**.

**Project health**
7. **UI:** New policy `qa-health-npm-44c`, rule **Project health**. The form starts in Monitor mode. Overall score at least 5; Advanced: `Dangerous-Workflow` at least 10. The Summary lists *OpenSSF Scorecard below 5.0*, *or Dangerous-Workflow check below 10*, *Packages without a Scorecard: allowed*, *Scorecard unreachable: allowed*. Record it.
8. Edit to overall score at least **10** (nearly every project fails), keep **Monitor**, save, wait 6 seconds. As `user`, download `express` 4.21.2: served. Monitoring → `44c` lists `express` with *Scorecard below the minimum* (counts may lag about 60 seconds). Package check `express` 4.21.2 shows the Scorecard panel with the score and the checks. Record express's score.
9. **Enforce** with the minimum just **above** express's score: the download is 403 naming `44c`; just **below** it: served.
10. *When a package has no Scorecard result* **Block**: find an npm package that declares no repository (record which): it is Blocked; with **Allow** it is Allowed. If none is found, **Not run (no fixture)**. Delete the policy.

---

## 7. Recording failures

**Don't fix anything and don't make code changes.** That includes product code, tests, `test_apps`, docs and the charter. Document every failure in `TEST_REPORT.md` and `TEST_STATUS.md`, and list the fix it needs in `FIXES_NEEDED.md`, so that another agent can fix it.

When a step fails:
1. Stop that case and save evidence: a screenshot, the harness output, the ledger row, and the API response if there is one.
2. Find the likely root cause by reading only. Read the UI first, then the API response, backend logs (`docker compose logs backend`) and source code. Read the relevant pages under `docs/admin/`, `docs/guide/`, `docs/developers/` and `docs/reference/`, `test_apps/README.md`, `SSO_TESTING.md` and `requirements_*.md` to confirm the intended behaviour.
3. Record the defect in the report's Defects table: ID `D-<n>`, case and step, symptom, expected, actual, steps to reproduce, evidence paths, suspected root cause (`file:line` where you can find it), suggested fix, and the cases to re-run once it is fixed (the failed case plus every case that uses the same page, rule, ecosystem or setting). Write it so that someone who was not in this session can reproduce and fix it. A defect in `test_apps` (the harness) is recorded the same way, marked as a harness defect.
4. Put the defect ID in the Defects column of `TEST_STATUS.md` and set the case to **Fail (open)**.
5. Add an item for the defect to `FIXES_NEEDED.md` (use the format in the skill's `fixes-template.md`): priority (High, Medium or Low), where it happens, what happens and what should, the steps to reproduce, the suspected cause (`file:line`), a suggested fix, and the cases to re-run. Keep the file short and ordered by priority: it is what the fixing agent reads first, and it lists only open work. Move an item to *Verified fixed* only after your re-run passes.
6. Clean up the `qa-` data the failed case created, then go on to the next case. If later cases depend on the broken behaviour, run them anyway and record what happens; mark a case **Blocked (D-<n>)** only if it cannot be run at all.
7. Documentation (`docs/`, `test_apps/README.md`) that contradicts the verified behaviour is recorded as a defect too. Do not edit it.
8. **Do not commit, push or open a PR**, and do not edit anything outside `TEST_STATUS.md`, `TEST_REPORT.md`, `FIXES_NEEDED.md` and `test-results/`.

If the right behaviour needs a product decision that no doc answers, record it as **Blocked: needs decision**, describe the options, and continue.

---

## 8. Customer workflow matrix

Tick each row, in the Workflow coverage table of `TEST_STATUS.md` and in the report, with the case and step that covered it **in the UI**, as soon as that step passes. A row without a UI tick means the run is incomplete.

| # | Role | Workflow | Case |
|---|---|---|---|
| W1 | Both | Sign in, sign out, wrong password, deep link survives sign-in | 1 |
| W2 | Both | Sidebar navigation (four groups), API docs; blocked pages cannot be reached | 2 |
| W3 | User | Check a package in all eight ecosystems; filters, chips, load more, recommended version, copy install command | 19 |
| W4 | User | Install packages with real clients; read a 403 reason; follow `checkUrl` | 5, 1.6 |
| W5 | User | Request a waiver from Package check and from Waiver requests; view status and reason | 17 |
| W6 | User | Follow the Registry setup snippet | 23 |
| W7 | Security | Create, view, edit, enable or disable, delete a policy of each rule type | 4, 12, 14 |
| W8 | Security | Reorder policies (move up / move down) | 6 |
| W9 | Security | Exact, range and open-ended versions; validation | 4, 7 |
| W10 | Security | Monitor mode: create, report, approve one and bulk, export, edit from report, enforce, restart | 18 |
| W11 | Security | Add an exception from Exceptions and from Package check; view; revoke | 16 |
| W12 | Security | Review waivers: approve and reject | 17 |
| W13 | Security | Malware: add, view, edit, override, delete, sync | 15 |
| W14 | Security | Decision Ledger: filter, detail, Copy as JSON, time range, clear, page, export; Build column for a CI token | 20, 25 |
| W15 | Security | Dashboard: totals, recent activity, refresh, empty range | 21 |
| W16 | Security | Webhooks: add, send a test event, receive events, see a retry and the delivery history, redeliver, delete | 22 |
| W17 | Security | Repositories: add on the form page, test connection, open client setup, use, edit, credentials kept secret, delete | 24 |
| W18 | Security | Access → Users: add (invitation), sign in as, delete; service account: create, mint and use a CI token, revoke, delete; legacy keys list | 25 |
| W19 | Security | Gateway security settings: change and restore | 26 |
| W20 | Security | Registry page for all ecosystems | 23 |
| W21 | Security | Email (SMTP) settings: save, test email, restore | 29 |
| W22 | Security | Add a person by email; they get an invitation; resend; delete a pending person | 30 |
| W23 | User | Accept an invitation and choose a password, then sign in | 30 |
| W24 | Both | Forgot password and reset by email | 31 |
| W25 | Security | Add a person when email cannot be sent (copy the link) | 32 |
| W26 | Security | Limit a policy and an exception to selected repositories (sources and team entry points, never `all`); see the scope in the list, filter and view; a policy on `default` applying through `all`; approve a waiver with a narrowed or widened scope; delete a scoped repository and read what it changes | 35 |
| W27 | User | Request a waiver for the repository the package was checked on | 35 |
| W28 | Security | Mark a remote internal (and see the public-host warning); create a Namespace protection policy with live validation, the Serve only from list, Exceptions, Test a name and the GONOSUMDB snippet; switch it to monitor and back; read collisions; turn the collision check on and off | 36 |
| W29 | User | Check and install a reserved name: the namespace panel, a 403 through a repository with no internal remote, a 404 for a reserved name no internal remote has; read the source in the ledger (Security) | 36 |
| W30 | Security | Order `all` and a custom virtual repository, read the public-before-internal warning, see an outage stop the search (502, ledger), bind a namespace to one remote and delete that remote | 37 |
| W31 | User | Read *Searched in order* and *Served by* in Package check; install through `all` with a policy on the serving remote | 37 |
| W32 | Security | Settings → Jobs: read queues and the five schedules (EPSS data), run a scheduled job now, retry or discard a failed job | 26 |
| W33 | Security | Audit Log: filter by feature, action, target and actor; expand; Copy as JSON; export | 38 |
| W34 | Security | Jobs & Feeds: feed status, run history, filters | 38, 15 |
| W35 | Security | Log Streaming: add an HTTP destination with a secret header, choose events (presets, search, high volume), send a test event, read status (Healthy, Auth failed, Retrying, Disabled), edit, disable, delete | 39 |
| W36 | Security | Webhook alerts: `malware_requested`, `dependency_confusion_blocked`, a coalesced follow-up; an allowed malware download in the ledger | 22, 40 |
| W37 | Security | Access → Users: change a role, disable and enable, sign out everywhere, search and page the list | 41 |
| W38 | Security | Single sign-on setup: allowed domains, add an OIDC provider on its page, Discover, Test sign-in, show on the login page, required claim, turn off and delete | 42 |
| W39 | Both | Sign in with single sign-on as Security and as User; deep link; refused sign-ins read in plain words | 42, 43 |
| W40 | Security | SAML provider: read IdP metadata, Test sign-in, sign in, refuse a replay | 43 |
| W41 | Security | Vulnerability policy with an EPSS condition; Project health policy in monitor then enforce | 44 |
| W42 | Security | Package check of a package audited (Package checked in the Audit Log) and nothing else recorded | 27 |

---

## Report

Write `TEST_REPORT.md` in the repo root, and keep it up to date during the run (not only at the end) so that a partial run is still readable. Create it once, in case 0. A resumed session adds to it and never recreates it.

```markdown
# DepGate E2E Test Report
Run: <start – end>   Commit: <sha> (+ uncommitted changes listed below)
Harness images: <depgate-test-* list>

## Baseline (case 0)
- Environment: commit, `git status --short`, date and time, docker version, existing harness images
- Harness baseline: result per ecosystem of the unchanged `install_packages.sh` run
- Policies before the run: name, priority, ecosystem, rule, action, mode, enabled (screenshot path); which ones case 0 disabled
- Exceptions, waiver requests, malware custom entries, webhooks, repositories, service accounts, legacy keys
- Gateway security values, Settings → Jobs schedules, Log streaming destinations and the allow tap used
- Access: users (role, status, source), allowed sign-in domains and *Add new people automatically*, identity providers
- Dashboard totals, newest Decision Ledger row, newest Audit Log entry and newest Jobs & Feeds run
- Fixture substitutions

## Summary
| Result | Count |
|---|---|
| Pass | |
| Fail → Fixed (fixed by another agent, re-run passed) | |
| Fail (open) | |
| Blocked: needs decision | |
| Not run (reason) | |
| Charter discrepancy | |

## Workflow coverage
| # | Workflow | Covered in UI by | Result |
|---|---|---|---|

## Cases
| ID | Title | Role(s) | Surface (UI/Client/API) | Result | Defects | Evidence |
|---|---|---|---|---|---|---|

## Case details
### Case N: <title>
- Role(s):
- Steps run: (numbered, including per-ecosystem sub-steps with their result; mark API setup)
- Expected:
- Actual:
- Result: Pass | Fail (open) | Fail → Fixed | Blocked | Not run (<reason>)
- Evidence: screenshots, harness output files, ledger rows (time, package, version, decision, reason), allow tap events, Audit Log entries
- Observations (not failures)

## Defects
| ID | Case.step | Symptom | Expected | Actual | Steps to reproduce | Evidence | Suspected root cause (file:line) | Suggested fix | Re-run after fix | Status |
|---|---|---|---|---|---|---|---|---|---|---|

## Decisions needed
(each Blocked item: question, options, recommendation)

## Charter discrepancies
(quote charter text and the doc text)

## Per-ecosystem observations
| Ecosystem | Blocked version listed? | Client prints reason / checkUrl? | Refused metadata writes a ledger row? | Transitive deps fetched | Publish time available? |
|---|---|---|---|---|---|

## Changed files
(`git status --short` at the start and end; the tester changes nothing outside `TEST_STATUS.md`, `TEST_REPORT.md`, `FIXES_NEEDED.md` and `test-results/`, so any other difference was made by someone else and is listed here)

## Cleanup confirmation
(qa-* counts after case 28, policies and settings restored, baseline re-check, run-all.sh comparison)
```

A run is **complete** when:
- every case has a result;
- every workflow in the matrix has a UI tick;
- every failure is recorded as a defect with enough detail for another agent to fix it, or listed under Decisions needed;
- `FIXES_NEEDED.md` lists every open defect, highest priority first, and matches the Defects table;
- the regression pass in case 28 is recorded;
- cleanup is confirmed.
