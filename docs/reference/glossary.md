# Glossary

| Term | Meaning |
|---|---|
| **Approval** | An exception scoped to one policy, created from the Monitoring page. Only that policy stops matching the package. |
| **Artifact cache** | Package files from public registries kept on each DepGate replica's local disk. |
| **Audit Log** | The record of every change a person made in DepGate, every sign-in and every package check. |
| **CI token** | A download-only token minted by a service account for one pipeline job. It lasts at most 1 day. |
| **CVSS** | Common Vulnerability Scoring System. A 0–10 severity score: Medium from 4.0, High from 7.0, Critical from 9.0. |
| **Decision Ledger** | The record of every download DepGate refused, and why. |
| **Dependency confusion** | An attack in which a public package impersonates an internal package name. Prevented by namespace protection. |
| **Ecosystem** | A package format and its clients: npm, PyPI, Maven, Go, NuGet, Cargo, Composer or RubyGems. |
| **Enforce** | A policy mode in which matching versions are blocked. |
| **EPSS** | Exploit Prediction Scoring System, from FIRST. The daily probability that a CVE will be exploited in the next 30 days. |
| **Exception** | A time-bound permission for a package that policies would block. |
| **Identity provider** | The OpenID Connect or SAML service people sign in with when single sign-on is set up. |
| **Internal registry** | A remote repository that holds your organization's own packages. |
| **Log streaming** | Delivery of DepGate's events in batches to a SIEM or log platform. |
| **Malware list** | Known-malicious packages, from the synced threat feed and your own entries. |
| **Monitor mode** | A policy mode that records what would be blocked, without blocking. |
| **Namespace protection** | A rule that serves your internal package names only from trusted remotes. |
| **OSV** | Open Source Vulnerabilities, the vulnerability database DepGate uses. |
| **Package check** | The page and API that show which versions of a package are allowed, and why. |
| **Policy** | A rule plus an action (Block or Allow), with a priority, an ecosystem and a repository scope. |
| **Priority** | The order of policy evaluation. Lower numbers first; the first match decides. |
| **Registry token** | The personal token in a developer's package manager settings. |
| **Remote repository** | A repository that proxies one upstream registry. |
| **Scorecard** | The OpenSSF Scorecard, a 0–10 rating of an open-source project's security practices. |
| **Service account** | A non-interactive account whose key mints CI tokens. |
| **Virtual repository** | A repository that serves several remotes behind one URL, asking them in order. |
| **Waiver request** | A developer's request for an exception, reviewed by the security team. |
