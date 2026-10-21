# Namespace protection

Namespace protection defends against **dependency confusion**, one of the most effective supply-chain attacks.

## The attack

Your company publishes internal packages such as `@acme/billing`, `acme-auth` or `com.acme:core` to an internal registry. An attacker publishes a package with the same name on the public registry, often with a higher version number. Any build that resolves through a repository combining your internal registry and the public one may now pick up the attacker's package, and run its install scripts.

A virtual repository such as `all` asks its remotes in order and moves on when one answers "not found". Without protection, a public remote can answer for an internal name, and every lookup of that name also reveals it to the public registry.

## How DepGate protects you

A **Namespace protection** policy lists your package names for one ecosystem. For a name in that list, DepGate:

- **asks only the remotes you trust** (your internal registries by default), through every repository, including `all`;
- **blocks** the request with HTTP 403 when the requested repository has no trusted remote;
- **answers 404** when no trusted remote has the package, and never falls through to a public registry;
- **never looks the name up** on a public registry, on OSV or on deps.dev, so your internal names do not leak.

When the package is found internally, your other policies (vulnerability, license and so on) evaluate it as usual.

Namespace protection is applied before everything else. A higher-priority Allow policy does not reopen public remotes, and an ordinary exception does not lift it.

## Set it up

### 1. Mark your internal registries

In **Settings → Repositories**, open each remote that serves your own packages and set **Source** to **Internal registry**. Remotes are public until you say otherwise, so a reserved name is never served from an unclassified remote. See [Repositories](./repositories#remote-source).

### 2. Create the policy in monitor mode

1. Choose **Policies → New policy**.
2. **Name**: for example `Protect the @acme namespace`. **Ecosystem**: the single ecosystem to protect.
3. **Rule**: Namespace protection. **Enforcement**: Monitor only.
4. Under **Your package names**, add your scopes and prefixes (see the syntax below).
5. Under **Serve only from**, keep the internal registries selected. Select a public registry only where you truly own the namespace there, such as your npm organization scope on npmjs.com.
6. Optionally, choose **Add exceptions** to list names you publish publicly on purpose, such as `@acme/eslint-config`.
7. Choose **Test a name** and try an internal name to confirm where it would be served from.
8. Choose **Create policy**.

![A Namespace protection policy](/screenshots/policy-new-namespace.png)

### 3. Review the Monitoring page

In monitor mode nothing changes for clients. Every download of a reserved name that a **public** remote served is recorded on the Monitoring page. For each one, either publish the package to your internal registry, or list it under **Exceptions: allow from any remote**.

### 4. Enforce

When the report is empty or every remaining entry is understood, choose **Enforce**.

## Name syntax

Matching respects segment boundaries: `com.acme` never matches `com.acmecorp`, and a prefix must end with a separator (`acme-*`, not `acme*`).

| Ecosystem | Forms | Example |
|---|---|---|
| npm | A whole scope, a prefix, or an exact name | `@acme` matches `@acme/billing`; `acme-*` matches `acme-auth` |
| PyPI | A prefix or an exact name (normalized: `_` and `.` equal `-`) | `acme-*` matches `acme_auth` and `Acme.Auth` |
| Go | A module path prefix | `github.com/acme` matches `github.com/acme/svc/v2` |
| Maven | A groupId prefix, optionally with an artifact | `com.acme` matches `com.acme:core` and `com.acme.billing:api` |
| NuGet | An ID prefix or an exact ID | `Acme.*` matches `Acme.Billing` |
| Cargo | A crate prefix or an exact name | `acme-*` matches `acme_core` |
| Composer | A vendor, a vendor prefix, or an exact name | `acme/*` matches `acme/billing` |
| RubyGems | A prefix or an exact name | `acme-*` matches `acme_billing` |

Patterns that would cover far too much are refused, such as `*`, a shared host on its own (`github.com`), or a one-segment Maven groupId (`com`).

## Recommendations for clients

- **npm**: claim your scope on npmjs.com as an organization. DepGate still protects you if you lose it.
- **Go**: set `GONOSUMDB` to your internal module paths, so the `go` command does not send them to `sum.golang.org`. The policy form shows the exact value. Do not use `GOPRIVATE` for this: it also makes `go` bypass DepGate.
- **NuGet**: reserve your ID prefix on nuget.org.
- **PyPI, Cargo, RubyGems** have no namespaces. Choose distinctive prefixes.

## Collision check (optional)

DepGate can check once a day whether your internal names also exist on the public registries, which may indicate an attack in progress. Turn on **Namespace collision check** under **Settings → Repositories → Gateway security**. Collisions are listed on the policy and sent to webhooks as `namespace_collision` events.

The check is off by default because it sends your internal names to the public registries.

## Package check

For a reserved name, [Package check](/developers/package-check) shows a **Reserved internal namespace** panel with the policy, the internal remotes that serve the name, and the public remotes that are not asked.
