# Install with Docker

This guide installs DepGate for production use with Docker Compose. DepGate runs as a single container that serves the web interface, the REST API and every package registry on one address. Two setups are available, and both run the published image only; nothing is built on the server.

| Setup | Folder | PostgreSQL and Redis |
|---|---|---|
| **All-in-one** | `deploy/all-in-one/` | Included in the same Compose file, on the same host. Not reachable from the network. |
| **App only** | `deploy/app-only/` | Your own servers: another machine, or a managed service. |

For a cluster with several replicas, see [Install on Kubernetes](./kubernetes). Before you start, check the [Requirements](./requirements).

## Overview

1. Get the `deploy/` folder onto the host.
2. Choose a setup and create `.env`.
3. Add a TLS certificate, or put DepGate behind your own TLS proxy.
4. Start DepGate and sign in.

Each setup folder has the same files:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Runs DepGate from its image (and, in all-in-one, PostgreSQL and Redis). It never builds anything. |
| `.env.example` | Every setting, with explanations. `1-configure.sh` turns it into `.env`. |
| `1-configure.sh` | Writes `.env` with generated secrets. |
| `2-generate-cert.sh` | Issues an HTTPS certificate from a local CA, when you have no company certificate. |
| `3-run.sh` | Starts DepGate, waits until it is healthy, and checks what it serves. Also `--stop` and `--logs`. |
| `quickstart.sh` | The three steps with defaults. |
| `certs/` | Your certificate files: `tls.crt`, `tls.key` and `ca.crt`. |

The scripts use `deploy/common/`, so copy the whole `deploy/` folder, not one subfolder.

## Step 1: Get the deploy folder and the image

The `deploy/` folder of the repository holds the compose files and scripts. Clone the repository on the host, or copy that folder to it:

```bash
git clone https://github.com/secmods/depgate.git
cd depgate/deploy
```

The image `secmods/depgate:<version>` is pulled from Docker Hub when DepGate first starts; no sign-in is needed. The same image is on GitHub as `ghcr.io/secmods/depgate:<version>`: set `DEPGATE_IMAGE=ghcr.io/secmods/depgate` in `.env` to pull it from there. Docker Hub allows a limited number of pulls per hour from one address without signing in; hosts that pull often, or many hosts behind one address, can use GitHub or `docker login`. With an internal registry mirror, set `DEPGATE_IMAGE` in `.env` to the mirror's name (and `docker login` once if it needs sign-in). To build the image yourself, see [Build from source](./build-from-source#build-the-production-image).

## Step 2: Choose a setup and configure

### All-in-one

PostgreSQL 17 and Redis 7 run in the same Compose file, with generated passwords, Redis set to `noeviction` with persistence, and no published ports. Use it for a team or a pilot on one server.

```bash
cd all-in-one
GATEWAY_URL=https://depgate.example.com ADMIN_EMAIL=security-team@example.com ./1-configure.sh
```

The script writes `.env` with a random `JWT_SECRET`, admin password, `DB_PASSWORD` and `REDIS_PASSWORD`, and protects it with `chmod 600`. The database connection is fixed in the Compose file; `.env` holds only the passwords.

### App only

DepGate connects to PostgreSQL and Redis you run elsewhere. Prepare them first:

1. Create an empty PostgreSQL database and a user that owns it. DepGate creates the tables on first start, but not the database or the user. As a PostgreSQL superuser:

   ```sql
   CREATE ROLE depgate LOGIN PASSWORD '…';      -- DB_USER and DB_PASSWORD
   CREATE DATABASE depgate OWNER depgate;        -- DB_NAME
   ```

   Use a new database, not one that already has tables (such as a development database): DepGate refuses to start on it. Allow 25 connections per DepGate instance. See [Requirements](./requirements#database).
2. Make sure Redis uses `maxmemory-policy noeviction` and AOF persistence, as one endpoint. Redis Cluster mode is not supported.

Then pass the connection details to the script:

```bash
cd app-only
DB_HOST=pg.example.com DB_PASSWORD='…' DB_SSL=true \
REDIS_URL='rediss://:…@redis.example.com:6380' \
GATEWAY_URL=https://depgate.example.com ADMIN_EMAIL=security-team@example.com ./1-configure.sh
```

For servers on the same host outside Docker, use `DB_HOST=host.docker.internal`.

### What `.env` holds

The settings people usually change:

| Setting | Example | Description |
|---|---|---|
| `DEPGATE_IMAGE`, `DEPGATE_VERSION` | `secmods/depgate`, `1.0.0` | Image name and tag. The version is already filled in for the release the folder came from. |
| `GATEWAY_URL` | `https://depgate.example.com` | The address people and package clients use. Registry responses contain links built from it. |
| `JWT_SECRET` | output of `openssl rand -hex 32` | Signs sessions and registry tokens. Keep it: a new value signs everyone out and invalidates every registry token. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `security-team@example.com` | The first Security account, created on first start only. Change the password in the web interface afterwards; both variables may then be removed. |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | | PostgreSQL connection (app only). |
| `DB_SSL`, `DB_SSL_CA_FILE` | `true`, `/certs/ca.crt` | Encrypt the PostgreSQL connection and verify the server certificate (app only). |
| `REDIS_URL` | `redis://:password@redis.example.com:6379` | Redis connection (app only). Use `rediss://` for TLS. |
| `ARTIFACT_CACHE_MAX_SIZE_GB` | `50` | Disk the [artifact cache](/admin/artifact-cache) may use. The cache is on in both setups. |

Email, the outbound proxy and every tuning option can also go in `.env`. See [Configuration](/reference/configuration). To write `.env` by hand instead of with the script: `cp .env.example .env && chmod 600 .env`, then fill in the values.

## Step 3: Add the certificate

DepGate serves HTTPS on port 443 and redirects port 80 to it. Put three files in the setup's `certs/` folder:

| File | Contents |
|---|---|
| `tls.crt` | The server certificate followed by its intermediate certificates (full chain), in PEM. It must name the host in `GATEWAY_URL`. |
| `tls.key` | The private key of `tls.crt`, in PEM, without a passphrase. |
| `ca.crt` | Your CA certificate (public). DepGate also trusts it for outgoing connections, such as internal registries. |

The container runs as user ID 1000, which must be able to read the files:

```bash
chmod 644 certs/tls.crt certs/ca.crt
chmod 640 certs/tls.key && sudo chown 1000 certs/tls.key
```

::: details No company CA yet?
`./2-generate-cert.sh depgate.example.com` creates a local CA (kept in the setup's `local-ca/`, never mounted into the container) and issues a certificate for the name. Every client must then trust `certs/ca.crt`.
:::

To use your own TLS proxy or load balancer instead, set `DISABLE_SSL=true` (add it to the `1-configure.sh` line) and skip this step. See [HTTPS and networking](./https-and-networking#behind-your-own-tls-proxy).

## Step 4: Start DepGate

```bash
./3-run.sh
```

The script runs `docker compose up -d`, which pulls the image when it is missing, waits until the `app` service reports `(healthy)`, and checks HTTPS, the database, the web interface and the HTTP redirect. On first start DepGate creates its tables, the first Security account and the default repositories for every ecosystem, then begins downloading the malware feed and EPSS scores in the background.

The wait is up to 10 minutes: a database upgrade, or another DepGate instance starting on the same database, happens before the app listens. If it runs out, the script prints the log tail and exits with an error while the container keeps running; follow it with `./3-run.sh --logs`.

::: tip One command
`./quickstart.sh` runs the three scripts in order with defaults, for `https://localhost`. In `app-only/` it needs the same `DB_*` and `REDIS_URL` variables as `1-configure.sh`.
:::

## Step 5: Verify

1. **Health:** `curl https://depgate.example.com/healthz` returns `{"status":"ok"}`, and `/readyz` returns `{"status":"ready"}` once PostgreSQL and Redis are reachable.
2. **Sign in:** open `GATEWAY_URL` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Change the password.
3. **Install a package:** follow [Connect your package manager](/developers/connect-package-managers) and install any package through DepGate. The Dashboard counts it.

## After installation

- [Set up email](/admin/email) so you can invite people.
- [Add people](/admin/users) and give them the User or Security role.
- [Add your internal registries](/admin/repositories).
- [Create your first policies](/admin/create-policy), starting in [monitor mode](/admin/monitoring).
- Plan [operations and upgrades](./operations).
