# Kubernetes: DepGate as a Deployment

Plain manifests with a Kustomize `kustomization.yaml`, applied with `kubectl apply -k`. DepGate runs as a Deployment with 2 replicas behind your Ingress, which terminates TLS. PostgreSQL and Redis are yours, outside the cluster or in it; these manifests never manage them.

| File | What it is |
|---|---|
| `kustomization.yaml` | Namespace `depgate`, the resources below, and the image tag (`newTag`). A registry mirror goes in `newName`. |
| `deployment.yaml` | 2 replicas, `strategy: Recreate`, probes on the management port, a per-pod `emptyDir` for the artifact cache, non-root security context. |
| `service.yaml` | ClusterIP `depgate`: port 80 to the app, port 9464 (`management`) for Prometheus inside the cluster. |
| `ingress.yaml` | Host, TLS Secret `depgate-tls`, backend Service `depgate`. No controller annotations (see [Ingress controller limits](#ingress-controller-limits)). |
| `pdb.yaml` | `maxUnavailable: 1`: a node drain never takes both replicas at once. |
| `configmap.yaml` | `depgate-config`: settings that are not secrets. Same variable names as the compose setups' `.env`. |
| `secret.example.yaml` | Template for `depgate-secrets`. Not applied by `kustomization.yaml`. |

## Requirements

- Kubernetes 1.30 or later (`lifecycle.preStop.sleep`).
- **PostgreSQL 15 or later** (17 recommended): an empty database and a user that owns it. Allow 25 connections per replica (`DB_POOL_SIZE` 20, plus two during startup).
- **Redis 7**, one endpoint (a standalone server, or a primary behind one failover address such as Memorystore Standard), `maxmemory-policy noeviction`, AOF, a password. Redis Cluster mode is not supported. Managed services block `CONFIG`, so DepGate cannot read the policy and `/readyz` reports it as `unknown`: verify it in the service's console.
- Nodes with **20 GiB of ephemeral disk per pod** for the artifact cache (the `emptyDir` `sizeLimit`), or lower both `sizeLimit` and `ARTIFACT_CACHE_MAX_SIZE_GB`. Memory request 3 GiB and limit 4 GiB per pod are the Team size from the [Sizing table](../../docs/install/requirements.md#sizing); raise them for larger installations.
- An Ingress controller, or a Gateway API implementation, set to the [limits below](#ingress-controller-limits).

## Install

1. **Namespace and Secret.** Copy `secret.example.yaml`, fill it in, apply it, and keep the copy out of version control; or create the Secret on the command line (the comment at the top of the file has it). `JWT_SECRET` is `openssl rand -hex 32` and never changes after installation.

   ```bash
   kubectl create namespace depgate
   kubectl -n depgate apply -f my-depgate-secrets.yaml
   ```

2. **Settings.** In `configmap.yaml`, set `GATEWAY_URL`, `ADMIN_EMAIL` and the `DB_*` connection values, and uncomment what you need (proxy, SMTP, `DB_SSL`). In `ingress.yaml`, set `ingressClassName` and the host. **The host is set in two places**, `GATEWAY_URL` and `ingress.yaml`; `kubectl apply -k` cannot derive one from the other. A mismatch shows as a redirect to the wrong host after sign-in.

3. **TLS certificate.** A `kubernetes.io/tls` Secret named `depgate-tls` in the namespace, by hand or from cert-manager:

   ```bash
   kubectl -n depgate create secret tls depgate-tls --cert=fullchain.pem --key=key.pem
   ```

4. **Company CA** (optional): for internal registries, PostgreSQL or Redis over TLS, or a TLS-inspecting proxy. Without it the pod logs one warning at start and continues.

   ```bash
   kubectl -n depgate create configmap depgate-ca --from-file=ca.crt=company-ca.pem
   ```

5. **Apply.**

   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl -n depgate rollout status deployment/depgate
   ```

   Both replicas start together. One creates the schema, the settings and the first admin while the other waits for it, then finds everything done. The startup probe allows 10 minutes for this.

6. Open `GATEWAY_URL`, sign in as `ADMIN_EMAIL` with `ADMIN_PASSWORD`, and change the password. `ADMIN_PASSWORD` is read only on that first start and can then be removed from the Secret.

### Registry mirror

When the cluster cannot pull from Docker Hub, set `newName: ghcr.io/secmods/depgate` to pull the same image from GitHub, or mirror the image and set `newName` under `images:` in `kustomization.yaml`. If the mirror needs sign-in, create the pull secret the Deployment already names:

```bash
kubectl -n depgate create secret docker-registry depgate-registry --docker-server=registry.example.com --docker-username=… --docker-password=…
```

The public image needs no secret; a missing `depgate-registry` is ignored.

## Ingress controller limits

`ingress.yaml` carries no controller-specific annotations: the Kubernetes project retired Ingress NGINX in March 2026, and the limits DepGate needs are set differently by every controller. Give yours these three, or the same on a Gateway API `HTTPRoute`:

| Limit | Value | Why |
|---|---|---|
| Request body size | 1 GiB | Package publishes and large artifacts |
| Read and send timeouts | 600 s | Slow upstream fetches streamed to the client |
| Request buffering | off | Publishes stream through without a temp file |

Where to set them:

| Controller | How |
|---|---|
| ingress-nginx (a maintained fork, or a frozen install) | Annotations on the Ingress: `nginx.ingress.kubernetes.io/proxy-body-size: "1g"`, `proxy-read-timeout: "600"`, `proxy-send-timeout: "600"`, `proxy-request-buffering: "off"`. |
| Traefik | A `Middleware` with `buffering.maxRequestBodyBytes: 1073741824` attached with `traefik.ingress.kubernetes.io/router.middlewares`; `respondingTimeouts.readTimeout: 600s` on the entry point. |
| HAProxy Ingress | Annotations `haproxy.org/client-max-body-size: 1g` (or the global `max-body-size`) and `haproxy.org/timeout-server: 600s`. |
| GKE, AWS ALB, Azure Application Gateway | A `BackendConfig` / `IngressClassParams` / policy with a 600 s backend timeout; the body limit is usually unlimited. Set `TRUST_PROXY: "2"` when the cloud load balancer sits in front of a second in-cluster proxy. |
| Gateway API | `HTTPRoute` `timeouts.request: 600s` and `backendRequest: 600s`; body size and buffering as the implementation's policy attachment. |

The management port 9464 is never in the Ingress; it is only on the Service for Prometheus.

`TRUST_PROXY` is the number of proxies in front of the pods whose `X-Forwarded-For` is believed for client addresses: `1` for the Ingress controller alone (the default with `DISABLE_SSL=true`), `2` with a cloud HTTP load balancer in front of it.

## Artifact cache

Each pod keeps package files from public registries on its own `emptyDir` (`/var/lib/depgate/artifacts`, `sizeLimit: 20Gi`). It survives a container restart inside the pod and is lost when the pod is deleted, so every upgrade starts both replicas with an empty cache. `ARTIFACT_CACHE_MAX_SIZE_GB` in the ConfigMap (18) must stay below `sizeLimit`: a pod that exceeds the limit is evicted. **Settings → Artifact cache** lists every pod and can switch the cache off at run time.

## Upgrade

Version upgrades stop every pod before any new pod starts (`strategy: Recreate`): the new version upgrades the database schema at startup, and an old pod that kept running could hold a table lock. Downtime is the time to stop, migrate and start.

1. Read the release notes: the **Database upgrade** line says whether a migration is slow. If it is, raise `failureThreshold` of the startup probe (60 × 10 s = 10 minutes by default).
2. Back up the database.
3. Set `newTag` in `kustomization.yaml` to the new version and apply:

   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl -n depgate rollout status deployment/depgate
   ```

If the upgrade fails, the database is unchanged: set the previous tag back and apply. To go back after a successful upgrade, restore the backup, then apply the previous tag.

**Settings changes** with the same image: edit the ConfigMap or the Secret, then `kubectl -n depgate rollout restart deployment/depgate`. This also stops every pod before starting the new ones.

## Shutdown and disruption

On `kubectl delete pod` or a node drain, the pod first sleeps 10 seconds (`preStop`) while the Ingress and the Service drop it from their endpoints, then receives SIGTERM, finishes the requests in flight, closes its connections and exits; `terminationGracePeriodSeconds` is 45. The PodDisruptionBudget keeps one replica available during a drain.

## Operate

| Task | Command |
|---|---|
| Logs | `kubectl -n depgate logs -f deployment/depgate` |
| Pods | `kubectl -n depgate get pods -l app.kubernetes.io/name=depgate` |
| Health inside the cluster | `http://depgate.depgate.svc:9464/healthz`, `/readyz`, `/metrics` |
| Scale | `kubectl -n depgate scale deployment/depgate --replicas=3` (every replica runs background jobs unless `WORKERS` says otherwise) |
