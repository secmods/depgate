# All-in-one: PostgreSQL, Redis and DepGate on one host

One compose file, three services, project `depgate-prod`. PostgreSQL and Redis publish no ports: only the app reaches them, on the compose network, with generated passwords. DepGate serves HTTPS on 443 and redirects 80 to it, or plain HTTP on 80 behind your own TLS proxy.

| File | Purpose |
|---|---|
| `docker-compose.yml` | `postgres` (pinned `postgres:17.11-alpine`), `redis` (pinned `redis:7.4.11-alpine`, `noeviction`, AOF, password) and `app`. The app starts only after both are healthy. |
| `.env.example` | Every setting, explained. `1-configure.sh` turns it into `.env`. |
| `1-configure.sh` | Writes `.env` with generated `DB_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET` and admin password. |
| `2-generate-cert.sh` | A local CA and an HTTPS certificate into `certs/` (skip it with a company certificate, or with `DISABLE_SSL=true`). |
| `3-run.sh` | `docker compose up -d`, waits for the app, checks what it serves. `--stop`, `--logs`. |
| `quickstart.sh` | The three steps with defaults. Keeps an existing `.env` and certificate. |
| `certs/` | Exactly `tls.crt`, `tls.key` and `ca.crt`. Mounted read-only at `/certs`. Never committed. |

## Install

On a host with Docker Engine and Compose v2:

```bash
cd deploy/all-in-one
./quickstart.sh
```

Open `https://localhost`, sign in as `admin@example.com` with `ADMIN_PASSWORD` from `.env`, and change the password. For a real host name and your own certificate, run the steps one by one:

```bash
GATEWAY_URL=https://depgate.example.com ADMIN_EMAIL=security@example.com ./1-configure.sh
cp /path/to/fullchain.pem certs/tls.crt && cp /path/to/key.pem certs/tls.key && cp /path/to/company-ca.pem certs/ca.crt
./3-run.sh
```

Behind your own TLS proxy: `DISABLE_SSL=true GATEWAY_URL=https://depgate.example.com ./1-configure.sh`, then `./3-run.sh`. DepGate then serves plain HTTP on port 80 only; the proxy forwards to it and passes `Host` and `X-Forwarded-For`. See [HTTPS and networking](../../docs/install/https-and-networking.md).

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

### Back up and restore

DepGate's state is in PostgreSQL. Redis holds caches and job queues and needs no backup.

```bash
docker compose exec postgres pg_dump -U depgate -Fc depgate > depgate-$(date +%F).dump
```

To restore into the same stack (stop the app first so nothing writes):

```bash
docker compose stop app
docker compose exec -T postgres pg_restore -U depgate -d depgate --clean --if-exists < depgate-2026-10-20.dump
docker compose up -d
```

Also keep a copy of `.env` (in particular `JWT_SECRET`, `DB_PASSWORD` and `REDIS_PASSWORD`) and your certificate files.

### Upgrade

1. Read the release notes: the **Database upgrade** line says whether a migration is slow.
2. Stop DepGate (the databases keep running): `docker compose stop app`
3. Back up (above).
4. Set `DEPGATE_VERSION` in `.env` to the new version. If you replaced this folder with the new release's, `3-run.sh` warns when `.env` still names the old one.
5. `./3-run.sh` (pulls the new image and starts it; the log shows the migrations it applies).

If the upgrade fails, the database is unchanged: set the previous version back and start again. To go back after a successful upgrade, restore the backup, then start the previous version.

### Regenerate `.env`

`./1-configure.sh --force` writes a new `.env` and keeps the old one as `.env.bak`. It carries over `JWT_SECRET` (a new one signs everyone out), `DB_PASSWORD` and `REDIS_PASSWORD` (new ones would lock the app out of its own databases), and the admin account.
