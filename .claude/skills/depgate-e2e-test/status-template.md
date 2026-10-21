# DepGate E2E Test Status

Working state of the current run of the `depgate-e2e-test` skill. Update it as you go (see the skill's SKILL.md). Details belong in `TEST_REPORT.md`; this file only says where the run stands.

The tester does not fix defects or change code. Each failure is recorded as a defect in `TEST_REPORT.md` for another agent to fix. The fixes still needed are listed, by priority, in `FIXES_NEEDED.md`.

Cases run in table order; case 28 (cleanup) and 28R run last.

Status values: **Not started**, **In progress**, **Waiting (case N)**, **Pass**, **Fail (open)** (defect recorded, not yet fixed), **Fail → Fixed** (fixed by another agent and re-run passed), **Blocked**, **Not run (reason)**. A charter discrepancy does not change the status; note it in Notes.

## Cases
Run started: — · Commit at start: — · Last updated: —

| Case | Title | Status | Last step done | Defects | Updated | Notes |
|---|---|---|---|---|---|---|
| 0 | Setup and baseline | Not started | | | | |
| 1 | Sign in and sign out | Not started | | | | |
| 2 | Navigation and page access | Not started | | | | |
| 3 | API access control | Not started | | | | |
| 4 | Policy form and validation | Not started | | | | |
| 5 | Packages rule, Block, all eight ecosystems | Not started | | | | |
| 6 | Allow versus Block, and changing the order | Not started | | | | |
| 7 | Version ranges and version order | Not started | | | | |
| 8 | Release type | Not started | | | | |
| 9 | Release age | Not started | | | | |
| 10 | Vulnerability | Not started | | | | |
| 11 | License | Not started | | | | |
| 12 | Rules of different types: priority | Not started | | | | |
| 13 | All-ecosystems policy | Not started | | | | |
| 14 | Disable, edit and propagation lag | Not started | | | | |
| 15 | Malware | Not started | | | | |
| 16 | Exceptions | Not started | | | | |
| 17 | Waiver requests | Not started | | | | |
| 18 | Monitor mode | Not started | | | | |
| 19 | Package check page | Not started | | | | |
| 20 | Decision Ledger | Not started | | | | |
| 21 | Dashboard | Not started | | | | |
| 22 | Webhooks | Not started | | | | |
| 23 | Registry page and client setup | Not started | | | | |
| 24 | Repositories | Not started | | | | |
| 25 | Users and access (Access page, CI tokens) | Not started | | | | |
| 26 | Gateway security | Not started | | | | |
| 27 | Package check writes only its audit event | Not started | | | | |
| 29 | Email settings (SMTP) | Not started | | | | |
| 30 | Add a person by invitation | Not started | | | | |
| 31 | Forgot password and reset by email | Not started | | | | |
| 32 | Add a person when email cannot be sent | Not started | | | | |
| 33 | Where email links point | Not started | | | | |
| 34 | Account and mail endpoints: access control | Not started | | | | |
| 35 | Policy scoping per repository | Not started | | | | |
| 36 | Namespace protection rule (dependency confusion) | Not started | | | | |
| 37 | Repository security: order, outages, warning, bound namespaces | Not started | | | | |
| 38 | Audit Log, Jobs & Feeds and the event split | Not started | | | | |
| 39 | Log Streaming | Not started | | | | |
| 40 | Malware and dependency-confusion alerts | Not started | | | | |
| 41 | Access: roles, disable, sign out everywhere, sign-in limit | Not started | | | | |
| 42 | Single sign-on with OIDC (Keycloak) | Not started | | | | |
| 43 | Single sign-on with SAML 2.0 (Keycloak) | Not started | | | | |
| 44 | EPSS and Project health | Not started | | | | |
| 28 | Cleanup and final regression (runs last) | Not started | | | | |
| 28R | Regression pass (case 28 step 6) | Not started | | | | |

## Workflow coverage
| # | Workflow | Case | UI tick (case.step) |
|---|---|---|---|
| W1 | Sign in, sign out, wrong password, deep link | 1 | |
| W2 | Sidebar navigation, API docs; blocked pages | 2 | |
| W3 | Package check in all eight ecosystems | 19 | |
| W4 | Install with real clients; 403 reason; checkUrl | 5, 1.6 | |
| W5 | Request a waiver; view status | 17 | |
| W6 | Registry setup snippet | 23 | |
| W7 | Policy CRUD for each rule type | 4, 12, 14 | |
| W8 | Reorder policies | 6 | |
| W9 | Exact, range, open-ended versions; validation | 4, 7 | |
| W10 | Monitor mode | 18 | |
| W11 | Exceptions | 16 | |
| W12 | Review waivers | 17 | |
| W13 | Malware | 15 | |
| W14 | Decision Ledger: filters, Copy as JSON, export, Build column | 20, 25 | |
| W15 | Dashboard | 21 | |
| W16 | Webhooks: test event, retry, signature, coalescing, Deliveries, redeliver | 22 | |
| W17 | Repositories: form page, client setup, credentials | 24 | |
| W18 | Access: users, service accounts and CI tokens, legacy keys | 25 | |
| W19 | Gateway security settings | 26 | |
| W20 | Registry page, all ecosystems | 23 | |
| W21 | Email (SMTP) settings | 29 | |
| W22 | Add a person by email; invitation; resend; delete pending | 30 | |
| W23 | Accept an invitation and sign in | 30 | |
| W24 | Forgot password and reset by email | 31 | |
| W25 | Add a person when email cannot be sent | 32 | |
| W26 | Scope policies, exceptions and waivers to repositories; delete a scoped repository | 35 | |
| W27 | Request a waiver for the checked repository | 35 | |
| W28 | Internal remotes and the Namespace protection policy: form, Try a name, monitor, collisions | 36 | |
| W29 | Check and install a reserved name: namespace panel, 403, 404, ledger source | 36 | |
| W30 | Order all and virtuals, order warning, outage 502, namespace bound to a remote | 37 | |
| W31 | Searched in order / Served by; install through all under a policy on the serving remote | 37 | |
| W32 | Settings → Jobs: queues, five schedules, EPSS data, run now, failed jobs | 26 | |
| W33 | Audit Log: filters, expand, Copy as JSON, export | 38 | |
| W34 | Jobs & Feeds: feed status, run history | 38, 15 | |
| W35 | Log Streaming: destination, events, test, status, secret header, disable, delete | 39 | |
| W36 | Webhook alerts: malware, dependency confusion; allowed malware in the ledger | 22, 40 | |
| W37 | Access: role change, disable/enable, sign out everywhere, list paging | 41 | |
| W38 | Single sign-on setup: domains, OIDC provider page, Test sign-in | 42 | |
| W39 | Sign in with single sign-on (Security, User), deep link, refusals | 42, 43 | |
| W40 | SAML provider: metadata, test, sign in, replay refused | 43 | |
| W41 | EPSS condition; Project health policy | 44 | |
| W42 | Package check recorded only as an audit event | 27 | |

## Re-run queue
Cases to run again after another agent has fixed a recorded defect. Remove a row only when its re-run has a result.

| Case | Because of | Added | Result |
|---|---|---|---|

## Session log
| # | Started | Ended | HEAD · changed files | Rebuilt? | Cases worked on | Stopped at | Leftovers cleaned |
|---|---|---|---|---|---|---|---|
