# Policy rules

Every policy has exactly one rule. This page describes each rule, its settings, and how DepGate decides whether a version matches.

| Rule | Actions | Recommended start |
|---|---|---|
| [Packages](#packages) | Block or Allow | Enforce |
| [Release type](#release-type) | Block | Monitor |
| [Release age](#release-age) | Block | Monitor |
| [Vulnerability](#vulnerability) | Block | Monitor (Enforce for Critical only) |
| [License](#license) | Block | Monitor |
| [Namespace protection](#namespace-protection) | Block | Monitor |
| [Project health](#project-health) | Block | Monitor |

Allow is offered only for the Packages rule. The other rules cover every package in an ecosystem, and an Allow there would skip every lower-priority policy for all of them.

## Packages

Matches named packages, optionally only some of their versions.

| Setting | Description |
|---|---|
| **Package names** | One or more names or patterns, such as `event-stream` or `*-malware`. |
| **Versions** (optional) | Single versions (**+ Version**) and inclusive ranges (**+ Version range**), such as `1.0.0 – 2.0.0`. Leave empty to match every version. |

Versions are compared with each ecosystem's own rules (SemVer, PEP 440, Maven, NuGet, RubyGems, Composer), so names such as `2.0.0rc1`, `1.0-SNAPSHOT` or `31.1-jre` work as expected.

Use **Block** to stop a known-bad package or version. Use **Allow** with a low priority number to let trusted packages, such as your own, skip the rest of the policies.

## Release type

Blocks versions that are not stable releases. Each version has exactly one type, decided by its ecosystem's conventions.

| Type | Meaning | Ecosystems | Examples |
|---|---|---|---|
| **Pre-release** | Alpha, beta, milestone, release candidate, preview | All | `1.2.3-rc.1`, `2.0.0rc1`, `2.0.0-RC1`, `7.1.0.beta1` |
| **Dev release** | Development builds and branch heads | PyPI, Composer | `1.0.dev1`, `dev-main`, `1.0.x-dev` |
| **Snapshot** | Builds that can change under the same version | Maven | `1.0-SNAPSHOT` |
| **Pseudo-version** | Go versions for an untagged commit | Go | `v0.0.0-20240101120000-abcdef123456` |

The form shows, for each type, which ecosystems it applies to and example versions for the chosen ecosystem. The block reason names the convention that matched, for example *Version 2.0.0rc1 is a pre-release (PEP 440 "rc")*.

## Release age

Blocks versions by when they were published. Fill in one setting or both.

| Setting | Matches |
|---|---|
| **Published less than** N hours ago | Versions that are too new. A cool-down gives the community time to discover a compromised or broken release before it reaches you. The version is allowed automatically once it is old enough. |
| **No release in** N days | Packages whose latest release is older than N days, a sign the project is no longer maintained. |

Publish dates come from the upstream registry. When a public registry does not provide one, DepGate looks it up on [deps.dev](https://deps.dev). Internal packages are never looked up outside your network.

::: tip
A 72-hour cool-down blocks the newest release of many popular packages for three days. Developers then get the previous version automatically, which is usually what you want.
:::

## Vulnerability

Blocks versions with known vulnerabilities. Vulnerability data comes from [OSV](https://osv.dev), which aggregates GitHub, PyPI, Go, RustSec and other advisory databases.

| Setting | Description |
|---|---|
| **CVE IDs** | Block any version affected by these specific vulnerabilities, such as `CVE-2021-44228`. A listed CVE always matches. |
| **CVSS score at least** | Block when a vulnerability's CVSS base score is at least this value (0.1 to 10). Medium starts at 4.0, High at 7.0, Critical at 9.0. |
| **When a vulnerability has no CVSS score** | **Ignore it** (recommended) or **Block the version**. Many Go and some PyPI and Rust advisories are unrated. |
| **Exploit likelihood (EPSS)** | Optionally, block only vulnerabilities that are likely to be exploited. See below. |

With both CVE IDs and a score filled in, either one is enough to match.

**How the score is chosen.** DepGate computes the base score from the advisory's CVSS vector, preferring CVSS 4.0, then 3.1, then 3.0. When an advisory has only a severity label, the label counts as the lowest score of its rating (High counts as 7.0).

### Exploit likelihood (EPSS)

[EPSS](https://www.first.org/epss/) estimates, every day, the probability that a CVE will be exploited in the next 30 days. Most vulnerabilities are never exploited; EPSS lets you focus on the ones that are.

| Setting | Description |
|---|---|
| **EPSS score at least** N % | Block when the probability is at least N %. |
| **EPSS percentile at least** | Alternatively, block the top of the distribution, such as the 95th percentile. |
| **When a vulnerability has no EPSS score** | **Block the version** (default) or **Ignore it**. New CVEs receive a score within a day or so. |

**CVSS and EPSS apply to the same vulnerability.** "CVSS at least 7.0 and EPSS at least 10 %" matches a version with a CVSS 7.5 vulnerability at 42 %, but not a version with one CVSS 9.8 vulnerability at 0.1 % and a different CVSS 3.1 vulnerability at 90 %.

DepGate downloads the full EPSS data set once a day and evaluates policies against that local copy, so EPSS never slows downloads. Because scores change daily, a version may be allowed one day and blocked the next. The data status is under [Settings → Jobs](./jobs).

## License

Blocks versions by their declared license. Choose one of two modes:

| Mode | Use it for |
|---|---|
| **Block every license except the approved ones** | The usual company setup: an approved list, with everything else blocked. Packages with no license information are blocked too, unless you select **Allow packages with no license info**. |
| **Block only the listed licenses** | A list of banned licenses, such as `AGPL-3.0`, `SSPL-1.0` or `BUSL-1.1`. Every other license passes. |

You can run both: put the banned list at a higher priority so banned licenses name that policy, and the approved list below it.

**How licenses are read**

- **OR** means the user may choose: `MIT OR GPL-3.0` passes a policy that approves MIT, and is not blocked by a GPL-3.0 ban.
- **AND** means every license applies: `MIT AND GPL-3.0` needs both approved, and is blocked by a GPL-3.0 ban.
- Entries are SPDX IDs, or patterns such as `BSD-*`. `GPL-3.0` also covers `GPL-3.0-only`, `GPL-3.0-or-later` and `GPL-3.0+`. Common names such as `Apache License 2.0` are mapped to their SPDX ID.
- A license counts as **unknown** when it is missing, `UNKNOWN`, `NOASSERTION`, `SEE LICENSE IN …`, or full license text instead of a name.
- When a public registry does not declare a license, DepGate looks it up on deps.dev.

## Namespace protection

Protects your internal package names against **dependency confusion**: an attacker publishing a public package with the same name as one of yours. A Namespace protection policy lists your names for one ecosystem, and DepGate then serves those names only from the remotes you trust (your internal registries by default).

| Setting | Description |
|---|---|
| **Your package names** | Scopes, prefixes or exact names, such as `@acme` and `acme-*` for npm, `com.acme` for Maven, or `github.com/acme` for Go. |
| **Serve only from** | The remotes allowed to serve these names. All internal registries are selected by default. |
| **Exceptions: allow from any remote** | Names inside your namespaces that you publish publicly on purpose, such as `@acme/eslint-config`. |

This rule is described in full in [Namespace protection](./namespace-protection).

## Project health

Blocks packages whose source repository scores low on the [OpenSSF Scorecard](https://scorecard.dev), which rates projects from 0 to 10 on practices such as maintenance, code review, dangerous CI workflows and pinned dependencies. It measures project hygiene, not malware.

| Setting | Description |
|---|---|
| **Overall score at least** | The main condition. |
| **Individual checks** (advanced) | A minimum for chosen checks, such as `Dangerous-Workflow` at least 10. Any failing check is enough to match. |
| **When a package has no Scorecard result** | Allow (default) or block. Happens when the package declares no repository, the repository is not on GitHub or GitLab, or Scorecard has not scanned it. |
| **When Scorecard can't be reached** | Allow (default) or block. Blocking means an outage of the Scorecard service blocks every package the policy covers. |

The repository is the one the package declares, which DepGate reads from the registry metadata (with deps.dev as a fallback). Only repositories whose remotes are all public are checked: DepGate never sends internal package names to Scorecard.

::: warning
Many popular, safe packages score between 3 and 5. Start in monitor mode and pick a threshold from the results.
:::

## API field names

When you create policies through the [REST API](/reference/api), the rule settings go in `conditions`:

| Rule | Fields |
|---|---|
| Packages | `packageBlockList`, `versionRange` |
| Release type | `releaseTypes`: `prerelease`, `dev`, `snapshot`, `pseudo` |
| Release age | `releaseAgeMaxHours`, `releaseAgeMinDays` |
| Vulnerability | `cveBlockList`, `cvssMin`, `cvssUnknown`, `epssMin` or `epssPercentileMin`, `epssUnknown` |
| License | `licenseAllowList` and `allowUnknownLicense`, or `licenseDenyList` |
| Namespace protection | `reservedNamespaces`, `allowedRemotes`, `publicPackages` |
| Project health | `scorecardMinScore`, `scorecardChecks`, `scorecardUnknown`, `scorecardUnavailable` |

Every rule also accepts `ecosystem` (a list; empty means all).
