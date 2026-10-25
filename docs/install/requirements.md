# Requirements

This page lists what you need before you install DepGate in production. For a trial on one machine, see the [Quick start](/guide/quick-start).

## Architecture at a glance

A DepGate installation has three parts:

| Component | Role | Notes |
|---|---|---|
| **DepGate** | Web interface, REST API and every package registry, in one container image. | Stateless. Run one or more replicas. |
| **PostgreSQL 15 or later** (17 recommended) | Configuration, policies, audit data. | Your own server, a managed service, or the bundled stack. |
| **Redis 7** | Metadata cache and background job queues. | One endpoint, `maxmemory-policy noeviction`. |

Package files from public registries are kept in each DepGate instance's own [artifact cache](/admin/artifact-cache) on local disk; everything else is streamed from the upstream registry.

## Host

- A Linux host (or any machine that runs Docker) with **Docker Engine** and **Docker Compose v2**, or a Kubernetes cluster (1.30 or later) for [Install on Kubernetes](./kubernetes).
- At least **2 vCPU and 4 GB RAM** for a team; see [Sizing](#sizing) for larger installations.
- Ports **443** and **80** free. With your own TLS proxy in front, only port 80 is used.

## Network

| Direction | Destination | Why |
|---|---|---|
| Inbound | HTTPS (443) from developer machines and CI runners | Package downloads, web interface, API. |
| Outbound | The public registries you proxy: registry.npmjs.org, pypi.org and files.pythonhosted.org, repo1.maven.org, proxy.golang.org, api.nuget.org, crates.io (with index.crates.io and static.crates.io), repo.packagist.org, rubygems.org | Fetching packages. |
| Outbound | `api.osv.dev` | Known vulnerabilities. |
| Outbound | `api.deps.dev`, `api.securityscorecards.dev` | Missing licenses and publish dates; project health scores. |
| Outbound | `github.com` (malicious-packages feed), `epss.empiricalsecurity.com` | Malware feed and daily EPSS scores. |
| Outbound | Your internal registries, SMTP server and webhook endpoints | Optional. |

A corporate outbound proxy is supported. See [HTTPS and networking](./https-and-networking#corporate-outbound-proxy).

## Host name and certificate

Choose the address people will use, for example `https://depgate.example.com`, and either:

- a **TLS certificate** for that name (from your company CA or a public CA), which DepGate serves itself; or
- **your own TLS proxy or load balancer** in front of DepGate, which terminates TLS.

## Database

**PostgreSQL 15 or later** (17 recommended). Create an empty database and a user that owns it, once, before DepGate first starts. DepGate creates its tables on first start and upgrades them on later starts (see [Operate and upgrade](./operations#upgrade)), but it does not create the database or the user. As a PostgreSQL superuser:

```sql
CREATE ROLE depgate LOGIN PASSWORD '…';      -- DB_USER and DB_PASSWORD
CREATE DATABASE depgate OWNER depgate;        -- DB_NAME
```

On a managed service (Amazon RDS, Cloud SQL, Azure Database for PostgreSQL), create them in the service's console or with the same statements. Use a new database: one that already has tables, such as a development database, stops DepGate at startup with `relation "…" already exists`, and nothing is changed. The all-in-one Docker setup creates its own database and needs none of this.

Each DepGate instance opens up to `DB_POOL_SIZE` (20) connections, plus two more while it starts: allow 25 per instance in `max_connections`, so two replicas need about 45 plus the server's own headroom.

**Redis 7** (or compatible), configured with:

- `maxmemory-policy noeviction`: job queues live in Redis and must never be evicted.
- AOF persistence (`appendonly yes`, `appendfsync everysec`).
- A password, and one endpoint: a standalone server, or a primary with a replica behind one failover address (for example Memorystore Standard). Redis Cluster mode is not supported.

Managed Redis services (ElastiCache, Azure Cache for Redis, Memorystore) often default to an evicting policy. Change it, or give the job queues their own Redis with `QUEUE_REDIS_URL`. These services also block the `CONFIG` command, so DepGate cannot read the policy and `/readyz` reports it as `unknown`; verify it in the service's console.

If you do not have database servers yet, the all-in-one setup runs PostgreSQL and Redis on the same host as DepGate, set up this way. See [Install with Docker](./docker#all-in-one).

## Sizing

Memory use is driven by how many distinct packages your organization requests per hour.

| Deployment | Distinct packages per hour | Redis `maxmemory` | DepGate container RAM |
|---|---|---|---|
| Evaluation | fewer than 500 | 512 MB | 1 GB |
| Team (up to 50 developers, some CI) | about 3,000 | 2 GB | 3–4 GB |
| Organization (hundreds of developers) | about 15,000 | 8 GB | 12–16 GB |
| Large (thousands of pipelines) | 50,000 or more | 24 GB or more | Use a separate queue Redis |

Leave about 40 % of the Redis host's memory above `maxmemory` for persistence rewrites.

## Package clients

DepGate works with the standard clients of each ecosystem: npm, Yarn and pnpm; pip, Poetry and uv; Maven and Gradle; the `go` command; `dotnet` and NuGet; Cargo; Composer; and RubyGems/Bundler.

::: warning Go needs HTTPS
The `go` command sends credentials only over HTTPS. Go clients therefore need DepGate behind TLS.
:::
