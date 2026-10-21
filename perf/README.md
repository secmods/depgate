# DepGate load tests

k6 replays dependency installs through a running Depgate and records download time for packages it allows and packages it blocks.

The default run is independent of whatever policies are already on the gateway. Setup pauses every other enabled policy, creates its own ALLOW and BLOCK policies, checks that a deny pin is rejected and an approve pin is served, runs the installs, then deletes its policies and turns the paused ones back on.

## What the default run configures

One pair of policies per ecosystem in the run:

| Policy | Decision | Matches |
|--------|----------|---------|
| `k6-load: allow {ecosystem}` | ALLOW | The approve pins in `k6/catalog.js` |
| `k6-load: block {ecosystem}` | BLOCK | The deny pins in `k6/catalog.js` |

A package matches one of those lists, not both. ALLOW is evaluated first. Pins outside either list are not requested.

`./perf/run.sh` runs this `mixed` scenario. These extra scenarios still exist:

| Scenario | Policies the script creates |
|----------|-----------------------------|
| `allow` | none, after pausing other policies |
| `block-package` | one BLOCK policy for every deny pin |
| `block-license` | BLOCK licenses matching `*MIT*`, `*GPL*`, `*MPL*` |
| `block-cve` | BLOCK severity HIGH and above |
| `allowlist` | ALLOW the approve set, then BLOCK everything else |
| `scoped` | The `mixed` policies scoped to the `default` remote, behind 10 BLOCK decoys per ecosystem scoped to a `k6-load-decoy` remote the run creates (and deletes). Run it with `REPO=all` |
| `namespace` | The `mixed` policies, plus one Internal namespace policy per ecosystem with 50 reserved patterns (`@k6-ns-*`, `k6-ns-*-*`, `test.k6ns*`…) that no catalog name falls in |
| `epss` | BLOCK severity HIGH and above when that same vulnerability has EPSS ≥ 10 % (compare with `block-cve`) |
| `sso` | None. Sign-in load instead of installs: see [Sign-in load](#sign-in-load-sso) |
| `scorecard` | The `mixed` policies behind one enforced Project health (OpenSSF Scorecard) policy per ecosystem at priority 1, overall at least 0.5, so every request loads its Scorecard fact first |
| `cached` | None, after pausing other policies. Clears the artifact cache, then installs each ecosystem once cold and repeats it warm: see [Artifact cache](#artifact-cache-cached) |

### Repository scope cost

`scoped` measures policies that follow the serving remote (R5 in `requirements_repository_security.md`). Requests go through `all`; the policies are scoped to the `default` remote that serves them, and the decoys to a remote after it that never serves. A decoy that applied shows up as 403s on approve pins, a scoped policy that did not apply as served deny pins; both are counted as unexpected. Run both scenarios through `all` and compare p95:

```bash
REPO=all ./perf/run.sh mixed scoped
```

The comparison table in `perf/results/compare.md` puts the two side by side. The acceptance bar is a p95 regression of at most 2% on the npm packument and tarball rows.

### Internal namespace cost

`namespace` measures the reserved-name check on traffic that is not reserved: every request now resolves its route through the namespace policies (a prefix match per pattern on the canonical name) before fetching. Run it next to `mixed`:

```bash
./perf/run.sh mixed namespace
```

The acceptance bar (requirements_namespace_protection.md §11) is a p95 regression of at most 2% on the npm packument (metadata) and tarball (allow) rows. Cache keys of names outside the reserved namespaces do not change, so the run uses the same warm caches as `mixed`.

### EPSS cost

`epss` adds the EPSS lookup to the vulnerability path of `block-cve`: the CVE ids of each version's OSV advisories are looked up in DepGate's `epss_scores` table (one query per evaluation round, then a process cache). Sync EPSS first (Settings → Jobs → EPSS scores sync → Run now, or `POST /api/admin/epss/sync`), then:

```bash
./perf/run.sh block-cve epss
```

The acceptance bar (requirements_epss.md §11) is a p95 regression of at most 5% on the npm packument (metadata) row versus the severity-only `block-cve`. No request calls FIRST.

### Project health (Scorecard) cost

`scorecard` measures the Scorecard fact on every request: the repository mapping (`scorecard:v1:map:*`) and the project's score (`scorecard:v1:proj:*`) from Redis, or on a cold cache one registry or deps.dev read per version and one Scorecard API call per distinct repository. The policy's minimum (0.5) is below every catalog project, so the deny and approve split stays the same as `mixed`. Run it twice so the second run reads warm caches, and compare with `mixed`:

```bash
./perf/run.sh mixed scorecard scorecard
```

The acceptance bar (requirements_scorecard.md §11) is a p95 regression of at most 5% on the npm packument (metadata) row with a warm cache. The scenario needs outbound access to api.securityscorecards.dev (and api.deps.dev for packages whose registry metadata has no repository).


### Artifact cache (`cached`)

`cached` measures the artifact cache (requirements_artifact_cache.md §12). The gateway must run with `ARTIFACT_CACHE_ENABLED=true` and `ARTIFACT_CACHE_MAX_SIZE_GB`; setup fails with a clear message otherwise. Setup clears the cache on every pod. Then, per ecosystem:

| Phase | What runs |
|---|---|
| cold | One install with 1 VU, against the empty cache: every allowed file is fetched from the registry and stored (`X-DepGate-Cache: MISS`). Starts at once and may take up to `COLD_DURATION` (default `3m`). |
| warm | `VUS` installs for `DURATION`, starting after `COLD_DURATION`: every allowed file should be served from the cache (`HIT`). |

```bash
ARTIFACT_CACHE_ENABLED=true ARTIFACT_CACHE_MAX_SIZE_GB=20 docker compose up -d backend
VUS=5 DURATION=60s ./perf/run.sh cached
```

The report adds a table with the p95 of stored files (cold) and of cached files (warm), and how many files were stored, hit, and served without being stored. The acceptance bars: a warm run sends no file request to the registries (every allowed file is a hit, so `not stored` stays at the cold run's count of internal or oversized files), and a hit adds at most 5 ms p95 over the policy decision; compare warm p95 with the `allow` scenario's metadata p95 on the same gateway. Memory flat during a 1 GB download and the cache's own hit latency are checked by `RUN_PERF=1 npx vitest run src/services/artifact-cache/perf.test.ts` in `packages/backend`.

### Sign-in load (`sso`)

`sso` is not an install replay: it runs `perf/k6/sso.js`, a sign-in burst (requirements_sso.md §12.1 case 17). For `DURATION` (default 30s), four scenarios run at once:

| Scenario | Each iteration |
|---|---|
| `sso` (`VUS`, default 3) | A full OIDC round trip through Keycloak: start → Keycloak login page → credentials → DepGate callback → code exchange → one signed-in API call. A fresh cookie jar each time, so Keycloak always shows its form. |
| `saml` (`VUS`) | A full SAML 2.0 round trip through Keycloak: start (AuthnRequest) → Keycloak login page → credentials → Keycloak's auto-post form → DepGate ACS (XML signature, issuer, audience, recipient, InResponseTo, replay cache) → code exchange → one signed-in API call. `SSO_PROTOCOLS=oidc` leaves it out. |
| `password` (`VUS`) | `POST /api/auth/login` as the admin. bcrypt dominates. |
| `session` (`SESSION_RATE`/s, default 50) | A signed-in API call (the per-request session check: user exists, not disabled, current session version) and the public provider list. |

It needs Keycloak (`docker compose --profile sso up -d keycloak`). Setup adds an OIDC provider, a SAML provider read from Keycloak's metadata (registering its SP entity ID and ACS URL as a SAML client through Keycloak's admin API, `admin`/`admin` or `KEYCLOAK_ADMIN`/`KEYCLOAK_ADMIN_PASSWORD`) and the `acme.test` domain; teardown removes them, the Keycloak client and the load user. All traffic comes from one address, so turn DepGate's per-IP SSO limit off for the run, and back on afterwards:

```bash
SSO_RATE_LIMIT=0 docker compose up -d backend
VUS=5 DURATION=60s ./perf/run.sh sso
docker compose up -d backend
```

Thresholds: no failed sign-ins; p95 of DepGate's start under 200 ms, OIDC callback and SAML ACS under 500 ms, code exchange under 100 ms, signed-in call and provider list under 100 ms. The summary is also written to `perf/results/sso.auth.json`.

SAML result on the same laptop (2026-10-14, VUS=5, 30s, alongside OIDC, password and session load): 898 SAML and 973 OIDC sign-ins, no failures. p95: SAML round trip 237 ms (Keycloak's credential check 82 ms of it), DepGate start 48 ms, ACS 77 ms, code exchange 9.6 ms. The same run had the OIDC round trip at 220 ms and the signed-in API call at 14 ms.

Result on a developer laptop (2026-10-14, Docker Desktop, Keycloak in dev mode, VUS=5, 60s): 2,758 SSO sign-ins and 4,378 password sign-ins, no failures. p95: SSO round trip 170 ms (Keycloak's credential check 48 ms of it), DepGate start 37 ms, callback 65 ms, code exchange 4.7 ms, password sign-in 97 ms, signed-in API call 7.9 ms.

The session check also runs on every package download with a registry token. It reads the cached users list (no database read per request), so compare `mixed` before and after an auth change: `./perf/run.sh mixed`.

## What an install does

Each pin is read the way a lockfile install reads it, then the file is downloaded.

| Ecosystem | Client behaviour | Blocked download |
|-----------|------------------|------------------|
| npm | abbreviated packument, then the tarball | tarball request, HTTP 403 |
| pypi | simple index, then one wheel or the sdist | index response that dropped the file |
| go | `.info`, `.mod`, then `.zip` | zip request, HTTP 403 |
| maven | POM, then the jar | jar request, HTTP 403 |
| nuget | service index, flat-container index, then the nupkg | nupkg request, HTTP 403 |
| cargo | crate metadata, then the crate download | download request, HTTP 403 |
| composer | `packages.json`, Composer 2 `p2` metadata, then the dist archive | metadata response that dropped the dist |
| rubygems | version list, then the rewritten gem URI | version list that dropped the gem |

PyPI, Composer, and RubyGems mint a token only for a file the policy still allows, so a blocked pin has no file URL to time. The blocked time for those three is the metadata response that removed the pin. The allowed time is always the file transfer.

Requests send `Authorization: Bearer`. Depgate accepts that on every ecosystem.

## Run

k6 0.57 or newer, or Docker. The gateway is already up, with a Security account that can sign in. If `k6` is not on your PATH, `./perf/run.sh` runs the `grafana/k6` image and rewrites `localhost` in `BASE_URL` to `host.docker.internal` so the container can reach the gateway.

```bash
# allow and block policies for all eight ecosystems, 1 VU for 30s
./perf/run.sh

# one ecosystem
VUS=1 DURATION=15s ECOSYSTEMS=npm ./perf/run.sh

# metadata only, no file bodies
SKIP_DOWNLOAD=1 ./perf/run.sh
```

`npm run test:load` is the same entry point.

Defaults: `BASE_URL=http://localhost:3050`, `ADMIN_USER=admin@depgate.local` (the Security account's email), `ADMIN_PASSWORD=admin`, `VUS=1`, `DURATION=30s`, repository key `default`.

| Variable | Effect |
|----------|--------|
| `ECOSYSTEMS` | Comma-separated subset. Example: `npm,pypi` |
| `PACKAGES` | First N pins from each ecosystem |
| `VUS` | Virtual users per ecosystem. They run at the same time. |
| `DURATION` | How long each ecosystem keeps installing |
| `TIMEOUT` | Per-request timeout. Default `120s` |
| `SKIP_DOWNLOAD` | `1` stops after metadata |
| `REPO` | Repository key in the URL. Default `default` |
| `QUIET` | `1` hides per-package warnings |
| `INSECURE_SKIP_TLS` | `1` for a gateway with a private certificate |
| `RESULTS_DIR` | Default `perf/results` |

Extra arguments that start with `-` are passed to `k6 run`, before the script path.

```bash
./perf/run.sh mixed --http-debug
```

Set `VUS` instead of k6's `--vus`. Each ecosystem scenario already has its own VU count.

k6 hides process environment variables unless `--include-system-env-vars` is set. `./perf/run.sh` sets that flag. A direct `k6 run` needs it too, or an explicit `-e BASE_URL=... -e SCENARIO=mixed`.

## How to read the numbers

The table printed at the end, and `perf/results/compare.md`, use these columns:

- **allow p95** — time to download a file an ALLOW policy served
- **block p95** — time to receive the rejection for a BLOCK policy
- **meta p95** — packuments, indexes, POMs, `.info` / `.mod`
- **blocked** — share of pins the client did not receive
- **errors** — timeouts, 5xx, or a pin whose decision did not match its list

For `mixed`, every deny pin must block and every approve pin must download. The run fails when more than 5% of package outcomes are wrong.

Setup waits for the gateway to reload policies, then requests one deny pin and one approve pin before any virtual user starts. If the deny pin is still served, setup stops and turns the paused policies back on. A blocked rate of zero with a green run is not possible: the probe fails first.

The full k6 dump is `perf/results/<scenario>.k6.json`. The small report is `<scenario>.report.json`.

## Safety

Use a gateway you can fill with audit rows. Every allow and block is written to the decision ledger. Run one load test at a time.

Setup pauses other enabled policies for the duration of the run and writes their ids into a disabled policy named `k6-load: restore`. Teardown turns those policies back on and deletes every policy whose name starts with `k6-load:`. If the process is killed before teardown, the next run reads that restore policy and turns the same policies back on.

`block-cve` calls the public OSV API through Depgate. Start with one ecosystem and one VU:

```bash
TIMEOUT=120s VUS=1 DURATION=30s ECOSYSTEMS=npm ./perf/run.sh block-cve
```
