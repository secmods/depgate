---
name: depgate-e2e-test
description: Run the DepGate end-to-end test charter (every User and Security workflow through the web UI, the package-manager clients in test_apps, and the API, including the Decision Ledger, Audit Log and Jobs & Feeds, Log Streaming, webhooks, Access, single sign-on with OIDC and SAML, EPSS and Project health), recording every failure in TEST_REPORT.md and TEST_STATUS.md, and the list of fixes still needed in FIXES_NEEDED.md, for another agent to fix (it never changes code). Resumes an unfinished run from TEST_STATUS.md instead of starting over. Use when asked to run, continue or resume the E2E test charter or test run.
disable-model-invocation: true
argument-hint: "[resume | new | case <N>]"
---

# DepGate E2E test run

You are the tester. What to test, and how, is in [charter.md](charter.md). This file covers how a run that spans several sessions is started, resumed and kept up to date.

**Don't fix anything, don't make code changes.** Document every failure in the test report (`TEST_REPORT.md`) and test status (`TEST_STATUS.md`), so that another agent will fix those issues. The only files you write are those two, `FIXES_NEEDED.md` and evidence under `test-results/`. See charter Section 7.

A run's state is kept in three files in the repo root:
- `TEST_STATUS.md`: where the run stands. Status of each case, last finished step, UI ticks for the workflow matrix, re-run queue and session log. Created from [status-template.md](status-template.md).
- `TEST_REPORT.md`: the full report described in the charter's Report section, including the case 0 **Baseline**.
- `FIXES_NEEDED.md`: the short, prioritized list of what another agent has to fix, with where, expected and actual, the suspected cause, a suggested fix and the cases to re-run. It lists only open work, so a fixer can start from it without reading the report. Created from [fixes-template.md](fixes-template.md).

Arguments: none or `resume` continues the current run. `new` starts a fresh run (see [Starting a fresh run](#starting-a-fresh-run)). `case <N>` runs or re-runs only case N, and still updates all three files.

If `resume` finds a run that is **complete** (28R has a result and no case or re-run is open) and the charter has gained cases since, do not reopen it on your own: tell the user, and recommend `new` when the product changed as much as in the 2026-10-17 update (most earlier results no longer prove the current behaviour). Use [When the charter gained cases 38 to 44](#when-the-charter-gained-cases-38-to-44-2026-10-17-update) only if the user wants to extend the old run.

Policy freedom: you may create any policy that helps exercise a rule, not only the ones the cases list, but never one that conflicts with what the run needs (for example blocking a package the client or its plugins depend on, such as Apache Commons for Maven). See Test data in [charter.md](charter.md). Maven-wide Release type, Release age, Vulnerability and License rules also block `mvn`'s own plugin dependencies; for those steps download the fixture's jar directly as described in charter Section 4.3.

## 1. Starting a session
1. Read [charter.md](charter.md) in full. Then read `TEST_STATUS.md`, `FIXES_NEEDED.md` and, in `TEST_REPORT.md`, the Baseline and the details of the last case worked on.
2. If `TEST_STATUS.md` does not exist, this is a new run: copy [status-template.md](status-template.md) to `TEST_STATUS.md` and [fixes-template.md](fixes-template.md) to `FIXES_NEEDED.md` in the repo root, fill in *Run started* and *Commit at start*, and begin at case 0. If `TEST_STATUS.md` exists but `FIXES_NEEDED.md` does not (a run that began before this file existed), create it from the template and fill it from the Defects table of `TEST_REPORT.md`: one item for every defect that is not yet verified fixed.
   Otherwise this is a **resume**. Do **not** run case 0 again. Its Baseline in `TEST_REPORT.md` is the only record of the state before the run (which policies were enabled, settings, counts). Running it again would record the already-changed state, and case 28 would then restore the wrong thing.
3. Add a row to the Session log with the start time, `git rev-parse --short HEAD` and the output of `git status --short | wc -l`. If code changed since the previous session's row (another agent fixed defects) and the containers have not been rebuilt since, rebuild (`docker compose up -d --build --remove-orphans backend`; one image serves the UI, the API and the registries on 3050) and wait for health.
4. Confirm `docker compose ps` shows the services healthy and the UI loads. Confirm Mailpit answers at `http://localhost:8025` (cases 29 to 34 and any case that adds a user read email there; see charter Section 1.3 "Reading email"). Start it as in charter Section 2 if it does not. Confirm the allow tap of charter Section 4.4 exists and is enabled (create it if the run has none yet; restart the event receiver if the run uses the HTTP tap). Start Keycloak only for cases 42 and 43, and the event receiver for cases 39 and 40 (charter Section 2).
5. If defects were fixed since the last session (an item in `FIXES_NEEDED.md` is marked `Fixed`, or the code changed), add the cases listed under their *Re-run after fix* to the Re-run queue, then clear the queue first.
6. Then continue with the first case, in the order of the `TEST_STATUS.md` table, whose status is **In progress**. If none is, take the first **Not started** one. Case 28 (cleanup) and 28R always run **last**, after case 44. Run a **Waiting** case as soon as the case it waits on is finished.
7. Before the session ends, or as soon as you expect it to (for example the context is getting long), bring `TEST_STATUS.md`, `TEST_REPORT.md` and `FIXES_NEEDED.md` up to date and fill in the session's Ended and Stopped at.

### When the charter gained cases since the run began
A run started before cases 29 to 34 existed (or before sign-in used email addresses) keeps its results for cases 0 to 28R. On resume:
1. Add rows 29 to 34 and workflows W21 to W25 to `TEST_STATUS.md` from [status-template.md](status-template.md), all **Not started**.
2. Do **not** run case 0 again. Add an **Addendum to the baseline** to `TEST_REPORT.md`: the users that exist now (they are not `qa-` data), the Email settings (case 29 step 1 also records them), and the Mailpit inbox count.
3. Put cases **1** and **25** in the Re-run queue, because sign-in and Add user changed (email and password, invitation). Their old results used a username and an admin-set password. Also re-run any case whose steps call `test_apps` with `user:user`: the credentials are now `user@depgate.local:usertest123` ([charter Section 2](charter.md#2-environment)).
4. Then run the queue, then cases 29 to 34 in order. Cases 30 to 33 depend on `user@depgate.local` and on Mailpit.

### When the charter gained case 35 (repository scope)
A run started before case 35 existed keeps its results. On resume, add row 35 and workflows W26 and W27 to `TEST_STATUS.md` from [status-template.md](status-template.md), all **Not started**. Put case **24** in the Re-run queue: its step 3 now names the policy's scope. Do not run case 0 again. Run case 35 after the queue; it needs `user@depgate.local` and creates repositories `qa-scope-<ecosystem>` that case 28 deletes.

### When the charter gained case 36 (internal namespace)
A run started before case 36 existed keeps its results. On resume, add row 36 and workflows W28 and W29 to `TEST_STATUS.md` from [status-template.md](status-template.md), all **Not started**. Add to the **Addendum to the baseline** in `TEST_REPORT.md` each remote's Source (all `public` unless someone changed them) and the Namespace collision check value. Put case **4** in the Re-run queue: its rule list and step 8 now include Namespace protection. Do not run case 0 again. Run case 36 after the queue; it creates repositories `qa-ns-<ecosystem>` that it deletes itself (case 28 checks they are gone).

### When the charter gained case 37 (repository security)
A run started before case 37 existed keeps its results. On resume, add row 37 and workflows W30 and W31 to `TEST_STATUS.md` from [status-template.md](status-template.md), all **Not started**. Add to the **Addendum to the baseline** in `TEST_REPORT.md` the members of each ecosystem's `all` in order (Settings → Repositories), so case 37 can put them back. Put case **35** in the Re-run queue: scope now follows the serving remote and `all` is no longer offered (steps 2, 3, 6, 7a, 9 and 12 changed). Do not run case 0 again. Run case 37 after the queue; it creates `qa-sec-*` repositories that it deletes itself.

### When the charter gained cases 38 to 44 (2026-10-17 update)
The product changed under a run that began before 2026-10-17: allowed downloads are no longer ledger rows, admin events and sign-ins moved to the Audit Log, feed syncs to Jobs & Feeds, people to the Access page, and Package check now writes one audit event. A run started before this update keeps its results. On resume:
1. Add rows 38 to 44 to `TEST_STATUS.md` from [status-template.md](status-template.md), all **Not started**, and move rows 28 and 28R below them (if case 28 already passed, set it back to **Not started**: it must run after the new cases). Add workflows W33 to W42 and update the wording of W2, W14, W16, W17, W18 and W32.
2. Do not run case 0 again. Add to the **Addendum to the baseline** in `TEST_REPORT.md` what case 0 steps 2, 4 and 5 now record: users with role, status and source; Access → Single sign-on (allowed domains, *Add new people automatically*, providers); Webhooks with their events; Log streaming destinations; Settings → Jobs schedules; the newest Audit Log entry and Jobs & Feeds run. Then set up the allow tap (charter Section 4.4, case 0 step 7) and record which one.
3. Put these cases in the Re-run queue, because their steps changed: **2** (sidebar, API docs), **3** (new endpoints), **4** (Project health, Audit Log), **5** and **6** (allowed downloads read from the tap), **15** (Jobs & Feeds, Malware tag), **16**, **18** (tap), **20** and **21** (rewritten), **22** (new events, signature, coalescing), **24** (form page, credentials), **25** (Access, CI tokens), **26** (five schedules), **27** (audit event), **30**, **31** (a reset now ends sessions; step 7 is no longer a documented limitation) and **32** (Access), **35** (steps 8, 11, 18), **36** (steps 1, 3, 11, 14, 16) and **37** (steps 2, 3).
4. Then run the queue, then cases 38 to 44 in order, then case 28 and 28R.

### When the charter gained the job queue (product rule 17)
A run started before product rule 17 existed keeps its results. On resume, add workflow W32 to `TEST_STATUS.md` from [status-template.md](status-template.md), **Not started**, and update the W16 wording. Put cases **15** (step 5: Sync is queued and answers 409 while running), **22** (retry, Deliveries, Redeliver, no `policy_violation`), **26** (new step 4: Settings → Jobs) and **36** (step 17: the collision run answers 202 with a job ID to poll) in the Re-run queue. Do not run case 0 again. The backend must have been rebuilt with Redis running `noeviction`: `GET /readyz` shows `"queues":"ok"` and `"evictionPolicy":"noeviction"`; record it in the session log.

## 2. Resuming an interrupted case
1. An **In progress** case names its last finished step. Open Policies, Exceptions, Waiver requests, Malware Packages and the Settings pages, and compare the `qa-` data there with what that case should have after that step.
   - It matches: continue from the next step.
   - It does not match, or you cannot tell: delete that case's `qa-` data, wait 6 seconds, and run the case again from step 1. Note this in the case's Notes.
2. Any other `qa-` item that is not one of the carry-overs below is left over from an interrupted case. Delete it, and record what you deleted in the session log.
3. A setting changed in case 26 (Registry token lifetime) and not yet restored: restore it from the Baseline before doing anything else. The same for Settings → Email after cases 29 or 32 (host `127.0.0.1` port `1` means it was left broken: restore the values recorded in case 29 step 1), for Access → Single sign-on after cases 42 and 43 (*Who may sign in* back to the Baseline, `qa-` providers deleted), and for a `qa-stream-*` destination other than the allow tap left by case 39 (delete it). A `qa-` remote left in an ecosystem's `all` (cases 37, 40) is deleted and the order of `all` put back to the Baseline.
4. A download folder `test-results/charter/dl/<case>-<eco>-<n>` from the interrupted attempt is kept as evidence. Use the next free `<n>` for the new attempt.

Data allowed to carry over from one case to another:
- The policies disabled in case 0 stay disabled until case 28.
- `qa-packages-npm-16` from case 16 into case 17.
- Case 1 step 6 needs a `checkUrl` from case 5. Mark case 1 **Waiting (case 5)** after step 5, and finish it right after case 5.
- The webhook receiver script from case 22 may be reused in case 27 (start it again).
- `qa-invitee-30@example.com` from case 30 into case 31 (deleted at the end of case 31). The fixture `user@depgate.local` stays for the whole run.
- The allow tap (`qa-stream-jsonl-tap` or `qa-stream-http-tap`, charter Section 4.4) from case 0 to case 28.
- Within case 42 only: `acme.test` in the allowed domains, the provider `qa-oidc-42` and the `*@acme.test` people; the same within case 43 for `qa-saml-43` and its Keycloak SAML client. A resumed case 42 or 43 that finds them left over deletes them and starts again from step 1.
- Within case 36 only: the `qa-ns-<ecosystem>` repositories and `qa-namespace-npm-36` from step 2 to step 18. Step 1 must run before step 2 in the same session (it warms the `all` cache that step 11 compares against); a resumed case 36 that already passed step 2 skips the step 11 comparison and records that.

## 3. Keeping the status current
- Set a case to **In progress** before its first step.
- Update **Last step done** after every step that creates, changes or deletes data, and after each ecosystem in per-ecosystem cases (for example `3: npm, pypi, go`).
- Tick a workflow row as soon as the UI step covering it passes.
- When a case ends, set its final status, defects and date, and write its details into `TEST_REPORT.md` before starting the next case.
- When a step fails, record the defect (charter Section 7), add it to `FIXES_NEEDED.md` with its priority, set the case to **Fail (open)** with its defect ID, and move on. Do not fix it.
- Keep `FIXES_NEEDED.md` in step with the Defects table: one item per open defect, highest priority first, the *Last updated* line and the counts current. A **Blocked: needs decision** item goes under *Needs a decision*.
- Set a case to **Fail → Fixed** only once another agent has fixed its defect and your re-run has passed. Then move that defect from *Fixed, waiting for re-run* to *Verified fixed* in `FIXES_NEEDED.md`. If the re-run fails, set it back to `Open` there and say what you saw.
- Only mark a case Pass if it was run in this run. Never reset `TEST_STATUS.md` to start over.

## Starting a fresh run
Only when the user asks for one (`new`). Move the current `TEST_STATUS.md`, `TEST_REPORT.md` and `FIXES_NEEDED.md` to `test-results/charter/previous/<YYYY-MM-DD>/`, then start as in step 2 of [Starting a session](#1-starting-a-session) with new status and fixes files. Make sure case 28 of the old run finished first, or the policies disabled in its case 0 are still off: if not, ask the user before going on.
