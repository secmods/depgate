# Deploying DepGate

One image serves the web UI, the API and every package registry (npm, PyPI, Maven, Go, NuGet, Cargo, Composer, RubyGems) on one address. Everything here runs the published image `ghcr.io/secmods/depgate:<version>`; nothing builds.

Copy this whole `deploy/` folder to the server and use one of the three setups. Scripts reach `common/`, so a subfolder does not work on its own.

| Setup | Folder | What runs where | Choose it when |
|---|---|---|---|
| **All-in-one** | [`all-in-one/`](all-in-one/README.md) | PostgreSQL, Redis and DepGate in one compose file, on one host. | A team or a pilot on one server. Nothing else to run. |
| **App only** | [`app-only/`](app-only/README.md) | DepGate only. PostgreSQL and Redis are your own servers: another machine, or a managed service. | Your database team or cloud provider runs the databases. |
| **Kubernetes** | [`kubernetes/`](kubernetes/README.md) | DepGate as a Deployment with 2 replicas, behind your Ingress. PostgreSQL and Redis outside the cluster, or in it, never managed by these manifests. | You run Kubernetes and want more than one instance. |

`common/` holds the shell helpers and the certificate script the two compose setups share.

## What every setup needs

- **The image.** Pulled from `ghcr.io/secmods/depgate` without signing in. An internal mirror is set with `DEPGATE_IMAGE` (compose) or `newName` in `kustomization.yaml` (Kubernetes); if the mirror needs sign-in, `docker login` once, or the `depgate-registry` pull secret.
- **PostgreSQL 15 or later** (17 recommended): an empty database and a user that owns it. Each DepGate instance opens up to `DB_POOL_SIZE` (20) connections plus two during startup; allow 25 per instance in `max_connections`.
- **Redis 7** with `maxmemory-policy noeviction`, AOF persistence and a password, as one endpoint (a standalone server, or a primary behind one failover address). Redis Cluster mode is not supported. The all-in-one setup brings both servers set up this way.
- **The same settings everywhere.** `.env` (compose) and the ConfigMap and Secret (Kubernetes) use the same variable names; the [Configuration reference](../docs/reference/configuration.md) lists them. `JWT_SECRET` is the same on every instance and never changes after installation. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are read once, when the first admin is created on an empty database; change the password in the UI afterwards.
- **The artifact cache is on.** Package files from public registries are kept on each instance's own disk (`ARTIFACT_CACHE_MAX_SIZE_GB`). **Settings → Artifact cache** can switch it off at run time.

## Versions and upgrades

The deploy files of a release name that release (`DEPGATE_VERSION` in `.env.example`, `newTag` in `kustomization.yaml`). An upgrade stops every DepGate instance first, backs up the database, changes the version, and starts the new one; the new version upgrades the database schema at startup. Rolling upgrades are not supported. Each setup's README has the exact steps; the [upgrade procedure](../docs/install/operations.md#upgrade) in the documentation has the background.

Several instances may start at the same time, on an empty database too: one does the database work while the others wait for it, then find it done.

## What is exposed

Only the HTTPS and HTTP ports of DepGate (compose), or the Ingress (Kubernetes). The management port with `/metrics`, `/healthz` and `/readyz` stays private. The all-in-one PostgreSQL and Redis publish no ports at all. The app runs as an unprivileged user.
