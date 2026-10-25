# App only: DepGate against your own PostgreSQL and Redis

One compose file with the `app` service, project `depgate-prod`. PostgreSQL and Redis are yours: another machine, a managed service, or servers on this host outside Docker (reached as `host.docker.internal`). DepGate serves HTTPS on 443 and redirects 80 to it, or plain HTTP on 80 behind your own TLS proxy.

| File | Purpose |
|---|---|
| `docker-compose.yml` | The `app` service from the published image. |
| `.env.example` | Every setting, explained. `1-configure.sh` turns it into `.env`. |
| `1-configure.sh` | Writes `.env` from your database addresses, with a generated `JWT_SECRET` and admin password. |
| `2-generate-cert.sh` | A local CA and an HTTPS certificate into `certs/` (skip it with a company certificate, or with `DISABLE_SSL=true`). |
| `3-run.sh` | `docker compose up -d`, waits for the app, checks what it serves. `--stop`, `--logs`. |
| `quickstart.sh` | The three steps with defaults. Keeps an existing `.env` and certificate. |
| `certs/` | Exactly `tls.crt`, `tls.key` and `ca.crt`. Mounted read-only at `/certs`. Never committed. |

## Your PostgreSQL and Redis

- **PostgreSQL 15 or later** (17 recommended). Create an empty database and a user that owns it, once, before the first start: DepGate creates the tables on first start and upgrades them on later starts, but not the database or the user. As a PostgreSQL superuser, `CREATE ROLE depgate LOGIN PASSWORD '…';` then `CREATE DATABASE depgate OWNER depgate;` (or the service's console). Use a new database: one that already has tables, such as a development database, stops DepGate at startup. No extension is needed. For TLS, `DB_SSL=true`, and `DB_SSL_CA_FILE=/certs/ca.crt` to verify the server with the CA in `certs/ca.crt`. Allow 25 connections per DepGate instance.
- **Redis 7**, one endpoint, with `maxmemory-policy noeviction`, AOF persistence and a password. Managed services (ElastiCache, Azure Cache for Redis, Memorystore) often default to an evicting policy, which loses queued jobs silently: change it in the service's console. They also block `CONFIG`, so DepGate cannot read the policy and `/readyz` reports it as `unknown`. Alternatively point `QUEUE_REDIS_URL` at a Redis set up that way and use the main one as a cache. `rediss://` for TLS. Redis Cluster mode is not supported.

## Install

On a host with Docker Engine and Compose v2:

```bash
cd deploy/app-only
DB_HOST=pg.example.com DB_PASSWORD='…' DB_SSL=true \
REDIS_URL='rediss://:…@redis.example.com:6380' \
GATEWAY_URL=https://depgate.example.com ADMIN_EMAIL=security@example.com ./1-configure.sh
cp /path/to/fullchain.pem certs/tls.crt && cp /path/to/key.pem certs/tls.key && cp /path/to/company-ca.pem certs/ca.crt
./3-run.sh
```

Without a company certificate, `./2-generate-cert.sh depgate.example.com` issues one from a local CA that every client must then trust. `./quickstart.sh` with the same `DB_*`, `REDIS_URL` and `GATEWAY_URL` variables runs the three steps for `localhost`.

Behind your own TLS proxy: add `DISABLE_SSL=true` to the `1-configure.sh` line. DepGate then serves plain HTTP on port 80 only; the proxy forwards to it and passes `Host` and `X-Forwarded-For`. See [HTTPS and networking](../../docs/install/https-and-networking.md).

`3-run.sh` waits up to 10 minutes for the app: a database upgrade, or another instance's startup, happens before it listens. Docker itself never stops or restarts a container for a failed health check, so if the wait runs out the script prints the log tail and exits non-zero while the container keeps running; follow it with `./3-run.sh --logs`.

## Operate

| Task | Command |
|---|---|
| Logs | `./3-run.sh --logs` |
| Stop (data kept) | `./3-run.sh --stop` |
| Apply `.env` changes | `./3-run.sh` |
| Health | `https://<host>/healthz`, `https://<host>/readyz` |
| Metrics | `http://app:9464/metrics` from a container on the compose network. Never published. |
| Reload a renewed certificate now | `docker compose kill -s HUP app` (otherwise within a minute) |
| Back up | Your database's usual tooling (`pg_dump -Fc`). Redis needs no backup. Keep a copy of `.env` (`JWT_SECRET`) and the certificate files. |

### Upgrade

1. Read the release notes: the **Database upgrade** line says whether a migration is slow.
2. Stop every DepGate instance that uses this database: `./3-run.sh --stop` here, and the same on any other host.
3. Back up the database.
4. Set `DEPGATE_VERSION` in `.env` to the new version. If you replaced this folder with the new release's, `3-run.sh` warns when `.env` still names the old one.
5. `./3-run.sh` (pulls the new image and starts it; the log shows the migrations it applies). Then start the other instances.

If the upgrade fails, the database is unchanged: set the previous version back and start again. To go back after a successful upgrade, restore the backup, then start the previous version.

### Regenerate `.env`

`./1-configure.sh --force` (with the `DB_*` and `REDIS_URL` variables again) writes a new `.env` and keeps the old one as `.env.bak`. It carries over `JWT_SECRET` (a new one signs everyone out and breaks every registry token) and the admin account.
