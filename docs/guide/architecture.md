---
aside: false
pageClass: dg-wide-page
---

# Architecture

DepGate sits between the machines that install packages and the registries those packages come from. Every package request passes through it, so every version is checked against known malware and your security policies before it can reach a laptop or a build. This page shows where DepGate fits, what it stops, how it is deployed, and how organizations use it in practice. For what happens to a single request inside DepGate, see [How DepGate works](./how-it-works).

## Where DepGate sits

<DiagramFrame caption="Developers and CI/CD runners install through DepGate. DepGate fetches from your internal and public registries, checks every version, and serves only what passes.">
  <ArchitectureOverview />
</DiagramFrame>

1. **Your teams** keep their usual tools. Developer laptops and CI/CD runners point npm, pip, Maven, Gradle, Go, NuGet, Cargo, Composer or Bundler at DepGate instead of the public registry.
2. **DepGate fetches** the package's metadata and files from the registries you connect: public registries such as npmjs and Maven Central, and internal ones such as JFrog Artifactory, Sonatype Nexus or GitHub Packages.
3. **Every version is checked** against the malware list, namespace protection, and your policies for vulnerabilities, licenses, release age and type, and project health. DepGate keeps these checks current with daily threat intelligence: vulnerabilities from OSV, exploit likelihood from EPSS, the OpenSSF malicious-packages feed, and OpenSSF Scorecard.
4. **Only allowed versions are served.** A blocked install fails with a clear reason, so the developer knows what to do next.
5. **Every block is recorded** in the Decision Ledger, and events can be streamed to your SIEM or sent to chat through webhooks.


## What DepGate stops

| Threat | Real-world example | How DepGate stops it |
|---|---|---|
| **Malicious packages** | `flatmap-stream 0.1.1`, the payload of the 2018 event-stream attack that targeted cryptocurrency wallets | The [malware list](/admin/malware) blocks it on every download, before any policy. |
| **Known vulnerable versions** | `log4j-core 2.14.1`, affected by Log4Shell (CVE-2021-44228, CVSS 10.0) | A [Vulnerability policy](/admin/policy-rules#vulnerability) blocks versions above a CVSS score, optionally only those likely to be exploited (EPSS). |
| **Dependency confusion** | A public package named `@acme/billing` that impersonates your internal one | [Namespace protection](/admin/namespace-protection) serves your internal names only from your internal registries. |
| **Hijacked maintainer accounts** | A new release published from a stolen account, such as `ua-parser-js 0.7.29` in 2021 | A [release age](/admin/policy-rules#release-age) cool-down holds new versions for a few days, while the community detects and removes bad releases. |
| **License risk** | An AGPL-licensed library in a proprietary product | A [License policy](/admin/policy-rules#license) enforces your approved or banned licenses. |
| **Unmaintained or poorly run projects** | A package with no release in years, or a project with dangerous CI workflows | [Release age](/admin/policy-rules#release-age) (unmaintained) and [Project health](/admin/policy-rules#project-health) policies. |
| **Unstable builds** | Release candidates and snapshots in production builds | A [Release type](/admin/policy-rules#release-type) policy. |

Exceptions are time-bound and recorded, so a team that needs a blocked version can [request a waiver](/developers/waiver-requests) without anyone switching a protection off.

## Components

<DiagramFrame caption="A DepGate installation: stateless application replicas, PostgreSQL, Redis, and outbound connections to registries, data feeds and notification targets.">
  <DeploymentDiagram />
</DiagramFrame>

| Component | Role | Notes |
|---|---|---|
| **DepGate** | Serves the web interface, the REST API and a registry endpoint for each ecosystem, on one HTTPS address. | One container image. Replicas are stateless; run more behind a load balancer for availability. |
| **Load balancer** | Terminates TLS and spreads traffic. | Optional. DepGate can serve HTTPS itself. |
| **PostgreSQL** | Stores policies, exceptions, waivers, repositories, users, the malware list, EPSS scores, monitoring data, the Decision Ledger and the Audit Log. | Your own server or a managed service. Back it up. |
| **Redis** | Caches registry metadata and package facts, holds the background job queues, and buffers events for log streaming. | Requires `maxmemory-policy noeviction`. |
| **Prometheus** | Scrapes metrics and health from a private port (9464). | Optional. The port is never published. |
| **Registries** | Public registries and your internal registries. | Connected under **Settings → Repositories**. |
| **Data feeds** | OSV, EPSS, the malicious-packages feed, deps.dev and OpenSSF Scorecard. | Can be mirrored internally for restricted networks. |
| **Identity provider** | Your OpenID Connect or SAML provider, for single sign-on. | Optional. Roles stay in DepGate. |
| **Notifications** | Your SMTP server, your SIEM or log platform for log streaming, and webhook endpoints such as Slack. | Optional. |

Each replica keeps package files from public registries in an [artifact cache](/admin/artifact-cache) on its own local disk. The cache needs no backup: a replica that loses it downloads the files again.

Outbound connections can go through your corporate proxy. See [Requirements](/install/requirements) and [HTTPS and networking](/install/https-and-networking).

## Deployment scenarios

### 1. A gateway to the public registries

The simplest setup, and the usual starting point. DepGate proxies the public registries directly, and developers and pipelines use it instead of them.

<DiagramFrame caption="Clients install through DepGate, which fetches from the public registries.">
  <FlowDiagram label="Developers and CI install through DepGate, which fetches from the public registries."
    :columns="[{ title: 'Developers and CI', lines: ['npm, pip, Maven, Go, …'] }, { title: 'DepGate', kind: 'gate', lines: ['malware list, policies'] }, { title: 'Public registries', kind: 'public', lines: ['npmjs · PyPI · Maven Central', 'NuGet · crates.io · RubyGems'] }]"
    :labels="['your token', 'HTTPS']" />
</DiagramFrame>

**When to use it:** teams without an artifact repository, or as a first step before connecting one.

**How:** [install DepGate](/install/docker), create your [policies](/admin/create-policy), and have everyone [connect their package manager](/developers/connect-package-managers) to the `default` repository of each ecosystem.

### 2. Together with JFrog Artifactory or Sonatype Nexus

Many organizations already run an artifact repository. DepGate does not replace it: the repository keeps caching and hosting your packages, and DepGate adds the security decisions. There are two ways to combine them.

**Option A: DepGate in front of the artifact repository (recommended)**

<DiagramFrame caption="Clients install through DepGate. DepGate fetches through your artifact repository, which caches the public registries.">
  <FlowDiagram label="Developers and CI install through DepGate, which fetches through JFrog Artifactory or Sonatype Nexus, which caches the public registries."
    :columns="[{ title: 'Developers and CI', lines: ['npm, pip, Maven, Go, …'] }, { title: 'DepGate', kind: 'gate', lines: ['malware list, policies'] }, { title: 'Artifactory or Nexus', kind: 'cache', lines: ['remote and hosted', 'repositories'] }, { title: 'Public registries', kind: 'public', lines: ['npmjs · PyPI · Maven', 'Central · …'] }]"
    :labels="['your token', 'credentials', 'cached']" />
</DiagramFrame>

1. In **Settings → Repositories**, add a remote repository for each ecosystem whose **Upstream URL** is the matching Artifactory or Nexus repository, for example `https://artifactory.example.com/artifactory/api/npm/npm-remote/`.
2. Under **Upstream authentication**, enter the credentials DepGate uses to read from it.
3. Set **Source** to **Public registry** for a repository that proxies a public registry, and **Internal registry** for one that holds your own packages.
4. Point clients at DepGate.

Every request is checked, policy changes and newly disclosed vulnerabilities apply at once, and the Decision Ledger shows which person or pipeline a blocked version was refused to. Artifactory or Nexus still caches the files, so upstream traffic stays low.

**Option B: The artifact repository in front of DepGate**

<DiagramFrame caption="Clients keep using the artifact repository, whose remote repositories fetch through DepGate.">
  <FlowDiagram label="Developers and CI keep using JFrog Artifactory or Sonatype Nexus, whose remote repositories fetch through DepGate from the public registries."
    :columns="[{ title: 'Developers and CI', lines: ['unchanged settings'] }, { title: 'Artifactory or Nexus', kind: 'cache', lines: ['remote repositories', 'point at DepGate'] }, { title: 'DepGate', kind: 'gate', lines: ['malware list, policies'] }, { title: 'Public registries', kind: 'public', lines: ['npmjs · PyPI · Maven', 'Central · …'] }]"
    :labels="['as today', 'account token', 'HTTPS']" />
</DiagramFrame>

Set the URL of each remote repository in Artifactory or Nexus to the matching DepGate repository, for example `https://depgate.example.com/npm/default/`. For credentials, use the registry token of a dedicated DepGate account (for example `artifactory@example.com` with the User role) as the password. The token is valid for the **registry token lifetime** (up to 365 days, set under **Settings → Repositories**), so plan to renew it.

This option needs no change on developer machines, but it has limits:

::: warning Cached versions bypass later decisions
Artifactory and Nexus serve cached files without asking DepGate again. A version cached before you added a policy, or before a vulnerability was disclosed, keeps being served until you remove it from the cache. The Decision Ledger also records every block against the artifact repository's account, not the person or pipeline behind it.
:::

| | Option A: DepGate in front | Option B: Artifact repository in front |
|---|---|---|
| Client configuration | Point clients at DepGate | Unchanged |
| New policies and vulnerabilities | Apply to every request at once | Apply only to versions not yet cached |
| Decision Ledger | The person or pipeline that was refused | The artifact repository's account |
| Package check, waivers, monitoring | Per person and per repository | Only for cache misses |

### 3. Internal and public packages together

When your own packages and public packages are installed from one URL, a public package with the same name as an internal one could be installed instead: a **dependency confusion** attack. DepGate's `all` repository combines your internal registry and the public registry behind one URL, and namespace protection makes sure your names only ever come from the internal one.

<DiagramFrame caption="One URL for everything. Internal names are served only from the internal registry; a public look-alike is blocked.">
  <FlowDiagram label="Developers and CI install from DepGate's all repository. Internal @acme packages come from the internal registry, everything else from the public registry, and public look-alikes of internal names are blocked."
    :columns="[{ title: 'Developers and CI', lines: ['one registry URL'] }, { title: 'DepGate', kind: 'gate', lines: ['namespace protection', 'for @acme/* and acme-*'] }, [{ title: 'Internal registry', kind: 'internal', lines: ['serves @acme/billing'] }, { title: 'Public registry', kind: 'public', lines: ['serves everything else'] }, { title: 'Public look-alike', kind: 'blocked', lines: ['@acme/billing on npmjs:', 'never asked, never served'] }]]"
    :labels="['/npm/all/', '']" />
</DiagramFrame>

**How:** mark your internal remote as **Internal registry** and put it first in the search order of `all` (see [Repositories](/admin/repositories)), then create a [Namespace protection](/admin/namespace-protection) policy for your scopes and prefixes. Internal names are also never sent to public registries or vulnerability services, so they do not leak.

### 4. A security gate in CI/CD

Pipelines install through DepGate with a **CI token** for each job. The token lasts at most 1 day. Blocked versions fail the build with a clear reason, and every block is recorded with the job's metadata, such as the repository, pull request and build number.

<DiagramFrame caption="Each pipeline job exchanges a service-account key for a CI token that lasts at most 1 day, then installs through DepGate.">
  <FlowDiagram label="A CI pipeline uses a CI token, valid for at most 1 day, with build metadata to install through DepGate from the registries."
    :columns="[{ title: 'CI pipeline', kind: 'pipeline', lines: ['GitHub Actions, GitLab CI,', 'Jenkins, Azure DevOps'] }, { title: 'DepGate', kind: 'gate', lines: ['ledger records build', 'metadata per download'] }, { title: 'Registries', kind: 'public', lines: ['internal and public'] }]"
    :labels="['CI token', 'HTTPS']" />
</DiagramFrame>

**How:** create a [service account](/admin/users#service-accounts), store its key as a CI secret, and mint a CI token at the start of each job. To fail fast, call [Package check](/developers/package-check) for pinned versions before installing. See [CI/CD pipelines](/developers/ci-pipelines). Send `package_blocked` [webhooks](/admin/webhooks) to the team's channel so blocks are noticed.

### 5. Regulated and air-gapped networks

DepGate runs entirely inside your network. It uses certificates from your company CA, reaches the internet through your outbound proxy if at all, and can use internal mirrors for both packages and threat data.

<DiagramFrame caption="DepGate inside a restricted network, using internal mirrors for packages and threat intelligence.">
  <FlowDiagram label="Developers and CI install through DepGate inside a restricted network. DepGate uses internal package mirrors and internal mirrors of the threat-intelligence feeds."
    :columns="[{ title: 'Developers and CI', lines: ['trust your company CA'] }, { title: 'DepGate', kind: 'gate', lines: ['your certificate', 'your PostgreSQL, Redis'] }, [{ title: 'Package mirrors', kind: 'internal', lines: ['Artifactory or Nexus'] }, { title: 'Feed mirrors', kind: 'internal', icon: 'feed', lines: ['EPSS file, malware feed,', 'OSV'] }]]"
    :labels="['company CA', 'internal only']" />
</DiagramFrame>

**How:** follow [HTTPS and networking](/install/https-and-networking): your own certificate, the corporate outbound proxy, and the air-gapped settings that point the EPSS and malware feeds at internal mirrors. Vulnerability policies need vulnerability data: without access to OSV or an internal mirror of it, they cannot match.

## Security of DepGate itself

- **Small attack surface.** Only HTTPS (443) and the HTTP redirect (80) are exposed. Metrics and health checks stay on a private port.
- **Least privilege.** The container runs as an unprivileged user. People get the User role unless they administer DepGate; pipelines get download-only CI tokens that expire within 1 day.
- **Secrets protected.** Registry credentials, identity provider secrets, SIEM tokens and the SMTP password are stored encrypted. Tokens in package manager settings are sent as headers, never in download URLs.
- **Private names stay private.** Packages from internal registries are never looked up on public services.
- **Everything is audited.** Every block is in the Decision Ledger; every policy change, exception, approval and sign-in is in the Audit Log.

## Next steps

- [How DepGate works](./how-it-works): what happens to a single request, step by step.
- [Quick start](./quick-start): run DepGate on one machine in ten minutes.
- [Requirements](/install/requirements): plan a production installation.
