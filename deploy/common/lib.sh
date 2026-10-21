# shellcheck shell=bash
# Shared helpers for the deploy scripts in ../all-in-one and ../app-only. Sourced, not run.
# A script that sources this file runs inside its own setup folder; nothing here needs the repository.

# The setup folder: the one holding the script that sourced this file.
SETUP_DIR="${SETUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)}"
SETUP_NAME="$(basename "$SETUP_DIR")"
ENV_FILE="$SETUP_DIR/.env"
ENV_EXAMPLE="$SETUP_DIR/.env.example"
CERT_DIR="$SETUP_DIR/certs"
# Signs certificates (generate-cert.sh); never inside CERT_DIR, which is mounted into the app container.
# shellcheck disable=SC2034
CA_DIR="$SETUP_DIR/local-ca"
# Both setups use this project name: one host runs one of them.
PROJECT=depgate-prod
APP_CONTAINER="$PROJECT-app-1"
# How long 3-run.sh waits for the app (R4): a database upgrade or a wait for another instance's startup
# lock happens before the app listens. The same bound as the Kubernetes startup probe. Docker itself never
# acts on an unhealthy container, so this is the only bound on the compose side.
APP_START_TIMEOUT=600

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"; }

# Random secret made of hex digits: safe inside URLs (REDIS_URL) and .env files without quoting.
rand_hex() { openssl rand -hex "${1:-24}"; }

# Value of KEY in an env file (last uncommented assignment), or empty.
get_env() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 0
  awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$file"
}

# Set KEY=VALUE in an env file: replaces "KEY=..." or "# KEY=...", otherwise appends.
set_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    !done && ($0 ~ "^" k "=" || $0 ~ "^# *" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp" && cat "$tmp" > "$file" && rm -f "$tmp"
}

# True for true/1/yes/on, case-insensitive.
is_true() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in true|1|yes|on) return 0 ;; *) return 1 ;; esac; }

# True when the env file asks for plain HTTP only (TLS on the customer's proxy).
ssl_disabled() { is_true "$(get_env "$1" DISABLE_SSL)"; }

compose() { docker compose --project-directory "$SETUP_DIR" "$@"; }

# Waits until a container reports healthy. Prints a dot every 15 seconds so a long upgrade is visibly alive.
wait_healthy() {
  local container="$1" timeout="${2:-$APP_START_TIMEOUT}" waited=0 status
  while [ "$waited" -lt "$timeout" ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo missing)"
    if [ "$status" = healthy ]; then [ "$waited" -ge 15 ] && echo; return 0; fi
    [ "$status" = exited ] && return 2
    sleep 3; waited=$((waited + 3))
    [ $((waited % 15)) -eq 0 ] && printf '.'
  done
  echo
  return 1
}

# 1 when the first version is older than the second (semantic versions, dotted numbers).
version_lt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]; }

# R2: the folder was replaced with a newer release but .env was kept.
warn_old_version() {
  local have want
  have="$(get_env "$ENV_FILE" DEPGATE_VERSION)"; want="$(get_env "$ENV_EXAMPLE" DEPGATE_VERSION)"
  if [ -n "$have" ] && [ -n "$want" ] && version_lt "$have" "$want"; then
    warn "DEPGATE_VERSION=$have in .env is older than $want in .env.example: these deploy files belong to $want. To upgrade: back up the database, set DEPGATE_VERSION=$want in .env, and run this script again."
  fi
}

# HTTPS in the app needs both files; DISABLE_SSL=true needs none. certs/ holds tls.crt, tls.key and ca.crt, nothing else.
check_certs() {
  if ! ssl_disabled "$ENV_FILE"; then
    [ -f "$CERT_DIR/tls.crt" ] && [ -f "$CERT_DIR/tls.key" ] || die "No certificate. Run ./2-generate-cert.sh first, or set DISABLE_SSL=true in .env."
  fi
  local f
  for f in "$CERT_DIR"/* "$CERT_DIR"/.[!.]*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in
      tls.crt|tls.key|ca.crt|.gitkeep) ;;
      *) warn "$f is mounted into the app; certs/ should hold only tls.crt, tls.key and ca.crt" ;;
    esac
  done
}

# Starts the stack (pulling the image when missing), waits for the app, and checks what it serves.
# `docker compose up -d` is the whole start: no script here ever builds (R1, R3).
start_and_check() {
  local image gateway https_port http_port host rc
  image="$(get_env "$ENV_FILE" DEPGATE_IMAGE):$(get_env "$ENV_FILE" DEPGATE_VERSION)"
  gateway="$(get_env "$ENV_FILE" GATEWAY_URL)"
  https_port="$(get_env "$ENV_FILE" HTTPS_PORT)"; https_port="${https_port:-443}"; https_port="${https_port##*:}"
  http_port="$(get_env "$ENV_FILE" HTTP_PORT)"; http_port="${http_port:-80}"
  host="${gateway#*://}"; host="${host%%/*}"; host="${host%%:*}"

  info "Starting $image (project $PROJECT, $SETUP_NAME)"
  compose up -d

  info "Waiting for the app (up to $((APP_START_TIMEOUT / 60)) minutes: a database upgrade, or another instance's startup, happens before it listens)"
  rc=0; wait_healthy "$APP_CONTAINER" "$APP_START_TIMEOUT" || rc=$?
  if [ "$rc" -eq 2 ]; then
    compose logs --tail 50 app
    die "DepGate exited during startup (logs above). The container restarts by itself; fix the cause, then run this script again."
  elif [ "$rc" -ne 0 ]; then
    compose logs --tail 50 app
    die "DepGate did not become healthy within $APP_START_TIMEOUT seconds (logs above). It keeps running: a long database upgrade finishes on its own; follow it with ./3-run.sh --logs."
  fi
  ok "container healthy"

  if ssl_disabled "$ENV_FILE"; then
    check() {
      local label="$1" path="$2" want="$3" code
      code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: text/html' "http://127.0.0.1:$http_port$path" || true)"
      if [ "$code" = "$want" ]; then ok "$label ($path → $code)"; else warn "$label ($path → $code, expected $want)"; fi
    }
    check "HTTP + health" /healthz 200
    check "Database and Redis" /readyz 200
    check "Web UI" / 200
    check "Metrics not public" /metrics 404
    if curl -sk -o /dev/null --max-time 3 "https://127.0.0.1:$https_port/healthz" 2>/dev/null; then warn "something answers HTTPS on port $https_port"; else ok "SSL disabled: nothing serves HTTPS"; fi
  else
    local cacert=() resolve=()
    [ -f "$CERT_DIR/ca.crt" ] && cacert=(--cacert "$CERT_DIR/ca.crt")
    resolve=(--resolve "$host:$https_port:127.0.0.1")
    check() {
      local label="$1" path="$2" want="$3" code
      code="$(curl -s -o /dev/null -w '%{http_code}' ${cacert[@]+"${cacert[@]}"} "${resolve[@]}" -H 'Accept: text/html' "https://$host:$https_port$path" || true)"
      if [ "$code" = "$want" ]; then ok "$label ($path → $code)"; else warn "$label ($path → $code, expected $want)"; fi
    }
    check "TLS + health" /healthz 200
    check "Database and Redis" /readyz 200
    check "Web UI" / 200
    check "Metrics not public" /metrics 404
    ok "HTTP redirect → $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "http://127.0.0.1:$http_port/" || true)"
  fi

  cat <<MSG

DepGate is running at $gateway
Sign in as $(get_env "$ENV_FILE" ADMIN_EMAIL) with ADMIN_PASSWORD from $SETUP_NAME/.env (used only when the account was first created).
Logs: ./3-run.sh --logs     Stop: ./3-run.sh --stop
MSG
  if ssl_disabled "$ENV_FILE"; then
    echo "SSL is disabled: your proxy terminates TLS for $gateway and forwards to http://<this host>:$http_port"
  elif [ "$host" != localhost ]; then
    warn "Make $host resolve to this machine (DNS, or /etc/hosts for a test) before opening $gateway"
  fi
}
