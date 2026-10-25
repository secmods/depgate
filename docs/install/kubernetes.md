# Install on Kubernetes

DepGate runs on Kubernetes as a Deployment with several replicas behind your Ingress, which terminates TLS. PostgreSQL and Redis run outside the cluster or in it; the manifests never manage them. The manifests are in `deploy/kubernetes/` of the repository and are applied with Kustomize (`kubectl apply -k`).

Before you start, check the [Requirements](./requirements). In addition:

- Kubernetes 1.30 or later.
- Nodes with 20 GiB of ephemeral disk per DepGate pod for the [artifact cache](#artifact-cache), or lower the limits.
- An Ingress controller, or a Gateway API implementation, that you can set to the [limits below](#ingress-controller-limits).

## What is deployed

| Manifest | What it is |
|---|---|
| `deployment.yaml` | 2 replicas, `strategy: Recreate`, startup, liveness and readiness probes on the private management port, a per-pod `emptyDir` for the artifact cache, a non-root security context. |
| `service.yaml` | ClusterIP `depgate`: port 80 to the application, port 9464 for Prometheus inside the cluster. |
| `ingress.yaml` | One host, TLS from the Secret `depgate-tls`, no controller-specific annotations. |
| `pdb.yaml` | A PodDisruptionBudget so a node drain never takes both replicas at once. |
| `configmap.yaml` | `depgate-config`: settings that are not secrets. |
| `secret.example.yaml` | A template for `depgate-secrets`. Not applied automatically. |
| `kustomization.yaml` | The namespace `depgate`, the resources above, and the image tag. |

The variable names are the same as in the Compose setups' `.env`; see [Configuration](/reference/configuration). Fixed in the Deployment and not configurable: TLS off in the pod (`DISABLE_SSL=true`), port 8080, management port 9464, the artifact cache on, and the company CA path.

## Install

### 1. Secrets

Copy `secret.example.yaml`, fill it in, apply it, and keep your copy out of version control. Or create the Secret directly:

```bash
kubectl create namespace depgate
kubectl -n depgate create secret generic depgate-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ADMIN_PASSWORD="$(openssl rand -hex 12)" \
  --from-literal=DB_PASSWORD='…' \
  --from-literal=REDIS_URL='rediss://:…@redis.example.com:6380'
```

`JWT_SECRET` is the same on every pod and never changes after installation: a new value signs everyone out and invalidates every registry token. `ADMIN_PASSWORD` is read once, when the first admin is created on an empty database; after signing in, change it in the web interface and remove it from the Secret if you like.

### 2. Settings and host

In `configmap.yaml`, set `GATEWAY_URL`, `ADMIN_EMAIL` and the `DB_*` connection values, and uncomment what you need: `DB_SSL` and `DB_SSL_CA_FILE`, the outbound proxy, SMTP, `WORKERS`.

In `ingress.yaml`, set `ingressClassName` to the class your cluster uses and the host.

::: warning The host is set in two places
`GATEWAY_URL` in the ConfigMap and the host in `ingress.yaml` must match. Kustomize cannot derive one from the other. A mismatch shows as a redirect to the wrong host after sign-in.
:::

### 3. TLS certificate

A Secret of type `kubernetes.io/tls` named `depgate-tls`, created by hand or by cert-manager:

```bash
kubectl -n depgate create secret tls depgate-tls --cert=fullchain.pem --key=key.pem
```

### 4. Company CA (optional)

For internal registries, PostgreSQL or Redis over TLS, or a TLS-inspecting proxy, give the pods your CA certificate. Without it the pod logs one warning at start and continues.

```bash
kubectl -n depgate create configmap depgate-ca --from-file=ca.crt=company-ca.pem
```

### 5. Apply

```bash
kubectl apply -k deploy/kubernetes
kubectl -n depgate rollout status deployment/depgate
```

Both replicas start at the same time. One creates the schema, the settings and the first admin; the other waits for it, then finds everything done. The startup probe allows 10 minutes for this. Open `GATEWAY_URL` and sign in as `ADMIN_EMAIL` with `ADMIN_PASSWORD`.

### Registry mirror

When the cluster cannot pull from Docker Hub, or its nodes share one address and reach Docker Hub's limit on pulls without signing in, set `newName: ghcr.io/secmods/depgate` to pull the same image from GitHub, or mirror `secmods/depgate:<version>` and set `newName` under `images:` in `kustomization.yaml`. If the mirror needs sign-in, create the pull secret the Deployment already names:

```bash
kubectl -n depgate create secret docker-registry depgate-registry \
  --docker-server=registry.example.com --docker-username=… --docker-password=…
```

The public image needs no secret; a missing `depgate-registry` Secret is ignored.

## Ingress controller limits

`ingress.yaml` carries no controller annotations: the Kubernetes project retired Ingress NGINX in March 2026, and every controller sets these limits differently. Give yours all three, or the same on a Gateway API `HTTPRoute`:

| Limit | Value | Why |
|---|---|---|
| Request body size | 1 GiB | Package publishes and large artifacts. |
| Read and send timeouts | 600 s | Slow upstream fetches are streamed to the client. |
| Request buffering | off | Publishes stream through without a temporary file. |

| Controller | Where to set them |
|---|---|
| ingress-nginx (a maintained fork, or a frozen install) | Ingress annotations `nginx.ingress.kubernetes.io/proxy-body-size: "1g"`, `proxy-read-timeout: "600"`, `proxy-send-timeout: "600"`, `proxy-request-buffering: "off"`. |
| Traefik | A `Middleware` with `buffering.maxRequestBodyBytes: 1073741824` attached with `traefik.ingress.kubernetes.io/router.middlewares`; `respondingTimeouts.readTimeout: 600s` on the entry point. |
| HAProxy Ingress | `haproxy.org/client-max-body-size: 1g` and `haproxy.org/timeout-server: 600s`. |
| GKE, AWS ALB, Azure Application Gateway | The controller's backend policy (`BackendConfig`, `IngressClassParams`, …) with a 600 s backend timeout. Body size is usually unlimited. |
| Gateway API | `HTTPRoute` `timeouts.request: 600s` and `backendRequest: 600s`; body size and buffering through the implementation's policy attachment. |

`TRUST_PROXY` is the number of proxies in front of the pods whose `X-Forwarded-For` is believed for client addresses: `1` for the Ingress controller alone (the default), `2` with a cloud HTTP load balancer in front of it. Set it in the ConfigMap.

The management port 9464 is never in the Ingress. It is on the Service for Prometheus inside the cluster: `http://depgate.depgate.svc:9464/metrics`.

## Artifact cache

Each pod keeps package files from public registries on its own `emptyDir` at `/var/lib/depgate/artifacts`, with a `sizeLimit` of 20 GiB. The volume survives a container restart inside the pod (a failed liveness probe) and is lost when the pod is deleted. Because upgrades use `Recreate`, every upgrade starts both replicas with an empty cache.

`ARTIFACT_CACHE_MAX_SIZE_GB` in the ConfigMap (18 by default) must stay below the `sizeLimit`: a pod that exceeds the limit is evicted. Lower both together on nodes with less ephemeral disk. **Settings → Artifact cache** lists every pod and can switch the cache off at run time. See [Artifact cache](/admin/artifact-cache).

## Upgrade

Version upgrades stop every pod before any new pod starts (`strategy: Recreate`). The new version upgrades the database schema at startup, and an old pod that kept running could hold a lock on a table the upgrade changes. Rolling upgrades are not supported; downtime is the time to stop, migrate and start.

1. Read the release notes. The **Database upgrade** line says whether a migration is slow; if so, raise `failureThreshold` of the startup probe (60 × 10 s = 10 minutes by default).
2. Back up the database.
3. Set `newTag` in `kustomization.yaml` to the new version and apply:

   ```bash
   kubectl apply -k deploy/kubernetes
   kubectl -n depgate rollout status deployment/depgate
   ```

If the upgrade fails, the database is unchanged: set the previous tag back and apply. To go back after a successful upgrade, restore the backup, then apply the previous tag. See [Operate and upgrade](./operations#upgrade).

**Settings changes** with the same image: edit the ConfigMap or the Secret, then `kubectl -n depgate rollout restart deployment/depgate`. This also stops every pod before starting the new ones.

## Shutdown and disruption

When a pod is deleted or its node is drained, it first sleeps 10 seconds (`preStop`) while the Ingress and the Service drop it from their endpoints, then receives SIGTERM, finishes the requests in flight, closes its connections and exits. `terminationGracePeriodSeconds` is 45. The PodDisruptionBudget (`maxUnavailable: 1`) keeps one replica available during a drain.

## Everyday commands

| Task | Command |
|---|---|
| Logs | `kubectl -n depgate logs -f deployment/depgate` |
| Pods | `kubectl -n depgate get pods -l app.kubernetes.io/name=depgate` |
| Scale | `kubectl -n depgate scale deployment/depgate --replicas=3`. Every replica runs background jobs unless `WORKERS` says otherwise. |
| Health inside the cluster | `http://depgate.depgate.svc:9464/healthz`, `/readyz`, `/metrics` |
