# Operate and upgrade

Day-to-day tasks for a DepGate installation made with [Install with Docker](./docker) or [Install on Kubernetes](./kubernetes). Compose commands run from the setup folder (`deploy/all-in-one/` or `deploy/app-only/`); Kubernetes commands have their own section on that page.

## Everyday commands

| Task | Command |
|---|---|
| Start, or apply changes to `.env` | `./3-run.sh` (or `docker compose up -d`) |
| Stop (data is kept) | `./3-run.sh --stop` |
| Follow the logs | `./3-run.sh --logs` |
| Status | `docker compose ps` |
| Reload the TLS certificate now | `docker compose kill -s HUP app` |

## Health checks

| Endpoint | Returns | Use for |
|---|---|---|
| `/healthz` | `{"status":"ok"}` while the process runs | Liveness |
| `/readyz` | `{"status":"ready"}` when PostgreSQL and Redis are reachable, plus the Redis eviction policy | Readiness, load balancer health |

Both are available on the public address. With `MANAGEMENT_PORT` set (port 9464 in every production setup), they are also served on that private port, where the container health check and the Kubernetes probes read them.

On a managed Redis that blocks `CONFIG` (Memorystore, ElastiCache), DepGate cannot read the eviction policy and `/readyz` reports it as `unknown`. Verify `noeviction` in the service's console.

## Metrics

DepGate exposes Prometheus metrics at `/metrics` on the management port (`http://app:9464/metrics` from a container on the Compose network). This port is never published. Useful metrics include:

| Metric | Watch for |
|---|---|
| `depgate_redis_memory_bytes{kind="used"\|"max"}` | Alert when used memory passes 80 % of max. |
| `depgate_jobs_failed_total` | Webhook, email or scheduled jobs that failed. |
| `depgate_ledger_rows_lost_total` | Decision Ledger rows that could not be written (database unavailable). |
| `depgate_stream_dropped_total` | Events a log streaming destination did not receive, by reason. |

## Background jobs

Webhook deliveries, email, monitoring rechecks and scheduled tasks run on job queues in Redis, shared by every replica. Their state is visible under **Settings → Jobs**, and every run under **Jobs & Feeds**. See [Jobs and data feeds](/admin/jobs).

## Retention

| Data | Kept for | Setting |
|---|---|---|
| Decision Ledger | 180 days | `LEDGER_RETENTION_DAYS` |
| Audit Log | 730 days | `AUDIT_RETENTION_DAYS` |
| Monitoring rows nobody downloaded | 90 days | `MONITOR_RETENTION_DAYS` |
| Webhook deliveries | 30 days | `WEBHOOK_DELIVERY_RETENTION_DAYS` |
| Job runs | 90 days | |

`0` keeps the Decision Ledger, the Audit Log or the monitoring rows forever.

## Back up

DepGate's state is in PostgreSQL. Back up the database regularly with your usual tooling. With the all-in-one setup, from `deploy/all-in-one/`:

```bash
docker compose exec postgres pg_dump -U depgate -Fc depgate > depgate-$(date +%F).dump
```

The custom format (`-Fc`) is what `pg_restore` reads. To restore, stop the app, run `pg_restore -U depgate -d depgate --clean --if-exists` inside the `postgres` container with the file on standard input, and start the app again (the all-in-one README has the exact commands).

Redis holds caches and job queues. It does not need a backup; on loss, caches refill from upstream.

Also keep a copy of `.env` (in particular `JWT_SECRET`, and in all-in-one the database passwords) and your certificate files. On Kubernetes, keep the `depgate-secrets` Secret.

## Upgrade

DepGate upgrades its own database schema. Every release ships the whole chain of schema migrations; at startup the new version applies the ones the database is missing, in order, in one transaction, and then serves. The release you come from does not matter, and you can skip releases.

1. Read the release notes for anything version-specific, and for any migration expected to take long.
2. **Stop every DepGate instance.** Migrations run with the application stopped; rolling upgrades are not supported.

   ```bash
   docker compose stop app      # all-in-one: the databases keep running
   ./3-run.sh --stop            # app only
   ```

   On Kubernetes, `strategy: Recreate` does this for you: every old pod stops before a new one starts.

3. **Back up the database** (see [Back up](#back-up)).
4. Set the new version and start it. The log shows the schema it found and the migrations it applies, then `Database schema at NNNN`.
   - Compose: set `DEPGATE_VERSION` in `.env` (if you unpacked the new release's `deploy/` folder over the old one, `3-run.sh` warns when `.env` still names the old version), then `./3-run.sh`. It pulls the new image, or finds the one you loaded with `docker load`.
   - Kubernetes: set `newTag` in `kustomization.yaml`, then `kubectl apply -k deploy/kubernetes`.

5. Check that the app is healthy (`docker compose ps` shows `(healthy)`; `kubectl -n depgate rollout status deployment/depgate`) and sign in.

**If the upgrade fails**, the database is unchanged: the log names the migration and the error and says so. Start the previous image again and report the log.

**To go back after a successful upgrade**, stop DepGate, restore the backup, then start the previous image. Starting the previous image without restoring is refused: an older DepGate does not run against a newer schema.

::: tip Several replicas
Instances that start together run their whole startup one at a time: one applies the migrations, creates the settings, the default repositories and (on an empty database) the first admin, while the others wait for it and then find everything done. The first install needs no special replica count. Still stop all of them before an upgrade, because an instance of the old version that keeps running can hold a lock on a table the upgrade changes. In that case the upgrade stops with "A table is locked by another connection" and nothing is changed.
:::

### Give the migration time to finish

`/healthz` and `/readyz` only answer once the schema is up to date and the startup tasks are done. The Kubernetes manifests allow 10 minutes for this with a `startupProbe` (`periodSeconds: 10`, `failureThreshold: 60`); liveness is not checked until it passes. When the release notes announce a slow migration, raise `failureThreshold` before applying the new tag. A pod killed in the middle of a migration leaves the database unchanged (the transaction rolls back) and starts into the same wait again.

With Compose, Docker never stops or restarts a container for a failed health check, so nothing interrupts a long migration. `3-run.sh` waits the same 10 minutes and then reports with the log tail while the container keeps running.

## Scale out

DepGate replicas are stateless and share PostgreSQL and Redis. To run several:

- Put them behind a load balancer and set `DISABLE_SSL=true` with TLS on the load balancer. The Kubernetes manifests do this with 2 replicas; see [Install on Kubernetes](./kubernetes).
- Use the same `JWT_SECRET` on every replica.
- Give each replica its own disk for the artifact cache; it is never shared.
- Every replica processes background jobs by default. Use `WORKERS` to dedicate replicas to jobs (`all`, `none`, or a list such as `webhooks,email`).
- Scheduled tasks run once per interval for the whole cluster, whatever the number of replicas.

## Logs

DepGate writes structured JSON logs to standard output. Set `LOG_LEVEL` to `debug`, `info` (default), `warn` or `error`. Each line includes the request ID, so you can follow one request across the log.

To have DepGate's events (blocks, changes, sign-ins) in the same stream, add a **Container output** destination under **Settings → Log streaming**. See [Log streaming](/admin/log-streaming).
