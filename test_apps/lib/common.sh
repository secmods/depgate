# shellcheck shell=bash
# Shared helpers for test_apps/*/install_packages.sh.
# Host side starts Docker. Inside the container this file configures the
# registry and records ALLOWED / BLOCKED / ERROR for each dependency.

RESULTS=""

if [ -t 1 ]; then
  GREEN=$(printf '\033[32m')
  RED=$(printf '\033[31m')
  YELLOW=$(printf '\033[33m')
  BOLD=$(printf '\033[1m')
  RESET=$(printf '\033[0m')
else
  GREEN=""
  RED=""
  YELLOW=""
  BOLD=""
  RESET=""
fi

depgate_usage() {
  local eco="$1"
  local image="$2"
  cat >&2 <<EOF
Usage: ./install_packages.sh <registry-url> <email:password>

  registry-url   DepGate origin, or this ecosystem's repository URL
                    http://localhost:3050
                    http://localhost:3050/${eco}/default/

  email:password  DepGate sign-in (the account's email address). The script calls /api/auth/login and
                  uses the registry token from that response.
                  Quote the argument if the password contains spaces or
                  shell characters. A colon in the password is fine.

The script builds a small image on top of ${image}, points that
client at DepGate, and installs each direct dependency on its own.
A blocked package does not hide the result of the others.

Exit 0  every dependency was allowed
Exit 1  usage error, or DepGate could not be reached
Exit 2  at least one dependency was blocked or failed
EOF
}

depgate_enter() {
  local base_image="$1"
  if [ -n "${DEPGATE_INSIDE_CONTAINER:-}" ]; then
    return 0
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required. The ecosystem CLIs run inside the container, not on the host." >&2
    exit 1
  fi
  local rel="${SCRIPT_DIR#"$ROOT_DIR"/}"
  local local_image="depgate-test-${rel}"
  if [ "${DEPGATE_REBUILD:-}" = "1" ] || ! docker image inspect "$local_image" >/dev/null 2>&1; then
    echo "Building ${local_image} from ${base_image}..."
    docker build \
      -f "${ROOT_DIR}/Dockerfile" \
      --build-arg "BASE=${base_image}" \
      -t "$local_image" \
      "$ROOT_DIR"
  else
    echo "Using image ${local_image} (set DEPGATE_REBUILD=1 to rebuild)."
  fi
  echo "Starting ${local_image}..."
  if [ -t 1 ]; then
    exec docker run --rm -t \
      --user root \
      --entrypoint bash \
      --add-host=host.docker.internal:host-gateway \
      -e DEPGATE_INSIDE_CONTAINER=1 \
      -e "DEPGATE_IMAGE=${local_image}" \
      -v "${ROOT_DIR}:/test_apps:ro" \
      "$local_image" \
      "/test_apps/${rel}/install_packages.sh" "$REGISTRY_INPUT" "$CREDENTIALS"
  fi
  exec docker run --rm \
    --user root \
    --entrypoint bash \
    --add-host=host.docker.internal:host-gateway \
    -e DEPGATE_INSIDE_CONTAINER=1 \
    -e "DEPGATE_IMAGE=${local_image}" \
    -v "${ROOT_DIR}:/test_apps:ro" \
    "$local_image" \
    "/test_apps/${rel}/install_packages.sh" "$REGISTRY_INPUT" "$CREDENTIALS"
}

depgate_args() {
  local eco="$1"
  local image="$2"
  REGISTRY_INPUT=${3:-}
  CREDENTIALS=${4:-}
  if [ -z "$REGISTRY_INPUT" ] || [ -z "$CREDENTIALS" ]; then
    depgate_usage "$eco" "$image"
    exit 1
  fi
  case "$CREDENTIALS" in
    *:*) ;;
    *)
      echo "Second argument must be email:password." >&2
      exit 1
      ;;
  esac
  DEPGATE_USER=${CREDENTIALS%%:*}
  DEPGATE_PASSWORD=${CREDENTIALS#*:}
  if [ -z "$DEPGATE_USER" ] || [ -z "$DEPGATE_PASSWORD" ]; then
    echo "Second argument must be email:password." >&2
    exit 1
  fi
  export DEPGATE_USER DEPGATE_PASSWORD
}

depgate_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

depgate_login() {
  local user_json pass_json code
  user_json=$(depgate_json_escape "$DEPGATE_USER")
  pass_json=$(depgate_json_escape "$DEPGATE_PASSWORD")
  umask 077
  printf '{"email":"%s","password":"%s"}' "$user_json" "$pass_json" >/tmp/depgate-login.json
  code=$(curl -sS -o /tmp/depgate-login-out.json -w '%{http_code}' \
    -X POST "${ORIGIN}/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data-binary @/tmp/depgate-login.json \
    --connect-timeout 5 --max-time 20 || true)
  rm -f /tmp/depgate-login.json
  if [ "$code" != "200" ]; then
    echo "Login failed for ${DEPGATE_USER} (HTTP ${code:-000})." >&2
    rm -f /tmp/depgate-login-out.json
    exit 1
  fi
  TOKEN=$(sed -n 's/.*"registryToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/depgate-login-out.json)
  rm -f /tmp/depgate-login-out.json
  if [ -z "$TOKEN" ]; then
    echo "Login succeeded but the response had no registryToken." >&2
    exit 1
  fi
  export TOKEN
  echo "Signed in: ${DEPGATE_USER}"
}

depgate_forward() {
  local port="$1"
  echo "Forwarding 127.0.0.1:${port} to host.docker.internal:${port}"
  socat "TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr" "TCP:host.docker.internal:${port}" >/tmp/socat.log 2>&1 &
  echo $! >/tmp/socat.pid
  sleep 0.4
  if ! kill -0 "$(cat /tmp/socat.pid)" 2>/dev/null; then
    echo "Could not listen on 127.0.0.1:${port} inside the container." >&2
    cat /tmp/socat.log >&2 || true
    exit 1
  fi
}

depgate_setup() {
  local ecosystem="$1"
  local default_path="$2"
  local url="$REGISTRY_INPUT"

  export HOME=/root

  case "$url" in
    http://*|https://*) ;;
    *)
      echo "Registry URL must start with http:// or https://." >&2
      exit 1
      ;;
  esac

  local scheme rest hostport path host port
  scheme=${url%%://*}
  rest=${url#*://}
  rest=${rest%%\?*}
  rest=${rest%%\#*}
  hostport=${rest%%/*}
  case "$rest" in
    */*) path="/${rest#*/}" ;;
    *) path="/" ;;
  esac
  hostport=${hostport#*@}
  case "$hostport" in
    *:*)
      host=${hostport%%:*}
      port=${hostport##*:}
      ;;
    *)
      host=$hostport
      if [ "$scheme" = "https" ]; then
        port=443
      else
        port=80
      fi
      ;;
  esac

  local use_path="$path"
  if [ "$path" = "/" ]; then
    use_path="$default_path"
  fi
  case "$default_path" in
    */)
      case "$use_path" in
        */) ;;
        *) use_path="${use_path}/" ;;
      esac
      ;;
  esac

  case "$use_path" in
    /"$ecosystem"|/"$ecosystem"/*) ;;
    *)
      echo "Registry path ${use_path} does not start with /${ecosystem}/." >&2
      exit 1
      ;;
  esac

  if ! command -v curl >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
    echo "Installing socat and curl inside the container..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq socat curl ca-certificates
  fi

  local client_host="$host"
  case "$host" in
    localhost|127.0.0.1|::1|host.docker.internal)
      depgate_forward "$port"
      # Artifact URLs are rewritten to GATEWAY_URL, usually http://localhost.
      # localhost inside the container is the socat listener, and Cargo only
      # allows an http registry on localhost.
      client_host="localhost"
      ;;
  esac

  SCHEME="$scheme"
  CLIENT_HOST="$client_host"
  PORT="$port"
  REGISTRY_PATH="$use_path"
  ECOSYSTEM="$ecosystem"
  export SCHEME CLIENT_HOST PORT REGISTRY_PATH ECOSYSTEM

  ORIGIN="${scheme}://${client_host}"
  if [ "$scheme" = "http" ] && [ "$port" != "80" ]; then
    ORIGIN="${ORIGIN}:${port}"
  elif [ "$scheme" = "https" ] && [ "$port" != "443" ]; then
    ORIGIN="${ORIGIN}:${port}"
  fi
  REGISTRY_URL="${ORIGIN}${REGISTRY_PATH}"
  export ORIGIN REGISTRY_URL

  if [ "$port" = "80" ] || [ "$port" = "443" ]; then
    AUTH_HOST="$client_host"
  else
    AUTH_HOST="${client_host}:${port}"
  fi
  export AUTH_HOST

  echo ""
  echo "${BOLD}DepGate ${ecosystem} install${RESET}"
  echo "Image:    ${DEPGATE_IMAGE:-local}"
  echo "Registry: ${REGISTRY_URL}"

  local code
  code=$(curl -sS -o /tmp/depgate-health.txt -w '%{http_code}' --connect-timeout 5 --max-time 10 "${ORIGIN}/healthz" || true)
  if [ "$code" != "200" ]; then
    echo "DepGate health check failed at ${ORIGIN}/healthz (HTTP ${code:-000})." >&2
    echo "Start the gateway on the host and pass http://localhost:${port} ." >&2
    if [ -f /tmp/depgate-health.txt ]; then
      cat /tmp/depgate-health.txt >&2 || true
      echo >&2
    fi
    if [ -f /tmp/socat.log ]; then
      echo "--- port forward ---" >&2
      cat /tmp/socat.log >&2 || true
    fi
    exit 1
  fi
  echo "Gateway:  reachable"
  depgate_login

  umask 077
  {
    printf 'machine %s\nlogin _\npassword %s\n' "$client_host" "$TOKEN"
    if [ "$client_host" != "127.0.0.1" ]; then
      printf 'machine 127.0.0.1\nlogin _\npassword %s\n' "$TOKEN"
    fi
  } >"${HOME}/.netrc"
  chmod 600 "${HOME}/.netrc"
}

depgate_copy_app() {
  local rel="${SCRIPT_DIR#"$ROOT_DIR"/}"
  rm -rf /tmp/depgate-app
  mkdir -p /tmp/depgate-app
  cp -a "/test_apps/${rel}/." /tmp/depgate-app/
  rm -f /tmp/depgate-app/install_packages.sh
  cd /tmp/depgate-app
}

# Literal redact. JWT dots must not be treated as regex wildcards.
depgate_redact_stream() {
  DEPGATE_REDACT_TOKEN="${TOKEN:-}" \
  DEPGATE_REDACT_PASSWORD="${DEPGATE_PASSWORD:-}" \
  awk '
    function scrub(s, secret,    L, i, out) {
      L = length(secret)
      if (L == 0) return s
      out = ""
      while ((i = index(s, secret)) > 0) {
        out = out substr(s, 1, i - 1) "***"
        s = substr(s, i + L)
      }
      return out s
    }
    {
      line = scrub($0, ENVIRON["DEPGATE_REDACT_TOKEN"])
      line = scrub(line, ENVIRON["DEPGATE_REDACT_PASSWORD"])
      print line
    }
  '
}

depgate_classify() {
  local rc="$1"
  local log="$2"
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' ALLOWED
    return 0
  fi
  # A 401 means the token was missing or rejected. Do not call that a policy block.
  if grep -Eq '401 Unauthorized|HTTP error 401|status code: 401|E401' "$log" \
    && ! grep -Eq '403|blocked by policy|Package blocked' "$log"; then
    printf '%s\n' ERROR
    return 0
  fi
  if grep -Eq '403|blocked by policy|Package blocked|package blocked' "$log"; then
    printf '%s\n' BLOCKED
    return 0
  fi
  # Pip says this when it saw no files at all. That is an index or auth problem,
  # not one blocked version. A blocked version still lists the other versions.
  if grep -Eq 'from versions: none' "$log"; then
    printf '%s\n' ERROR
    return 0
  fi
  # DepGate drops blocked versions from metadata, so clients report a missing
  # version instead of HTTP 403.
  if grep -Eq 'ETARGET|No matching version|No matching distribution|could not find a version that matches|version that satisfies' "$log"; then
    printf '%s\n' BLOCKED
    return 0
  fi
  printf '%s\n' ERROR
  return 0
}

depgate_install() {
  local name="$1"
  shift
  if [ "${1:-}" != "--" ]; then
    echo "internal: depgate_install expected --" >&2
    exit 1
  fi
  shift

  local log rc status detail
  log=$(mktemp)
  echo ""
  echo "${BOLD}>>> ${name}${RESET}"
  { printf '$'; printf ' %q' "$@"; printf '\n'; } | depgate_redact_stream

  set +e
  # </dev/null so the client cannot consume the dependency list on stdin.
  stdbuf -oL -eL "$@" </dev/null 2>&1 | depgate_redact_stream | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e

  status=$(depgate_classify "$rc" "$log")
  detail=""
  if [ "$status" != "ALLOWED" ]; then
    detail=$(grep -Ei 'Package blocked|blocked by policy|No matching version|No matching distribution|ETARGET|401 Unauthorized|403|could not find a version' "$log" | tail -n 1 | tr -d '\r' || true)
    if [ -z "$detail" ]; then
      detail=$(grep -Ei 'error:|ERROR|FAIL' "$log" | tail -n 1 | tr -d '\r' || true)
    fi
    detail=${detail//"$TOKEN"/***}
    if [ -n "${DEPGATE_PASSWORD:-}" ]; then
      detail=${detail//"$DEPGATE_PASSWORD"/***}
    fi
    detail=${detail//|/ }
    if [ "${#detail}" -gt 200 ]; then
      detail="${detail:0:200}..."
    fi
    if [ -z "$detail" ]; then
      detail="command exited ${rc}"
    fi
  fi
  RESULTS="${RESULTS}${status}|${name}|${detail}"$'\n'
  printf 'RESULT %s  %s\n' "$status" "$name"
  if [ -n "$detail" ]; then
    printf '         %s\n' "$detail"
  fi
}

depgate_finish() {
  local allowed=0 blocked=0 errors=0
  local status name detail
  echo ""
  echo "${BOLD}========== summary ==========${RESET}"
  printf '%s' "$RESULTS" >/tmp/depgate-results.txt
  while IFS='|' read -r status name detail; do
    [ -z "${status:-}" ] && continue
    case "$status" in
      ALLOWED)
        allowed=$((allowed + 1))
        printf '%sALLOWED%s  %s\n' "$GREEN" "$RESET" "$name"
        ;;
      BLOCKED)
        blocked=$((blocked + 1))
        printf '%sBLOCKED%s  %s\n' "$RED" "$RESET" "$name"
        if [ -n "$detail" ]; then
          printf '         %s\n' "$detail"
        fi
        ;;
      *)
        errors=$((errors + 1))
        printf '%sERROR%s    %s\n' "$YELLOW" "$RESET" "$name"
        if [ -n "$detail" ]; then
          printf '         %s\n' "$detail"
        fi
        ;;
    esac
  done </tmp/depgate-results.txt
  echo "-----------------------------"
  echo "${allowed} allowed, ${blocked} blocked, ${errors} errors"
  if [ "$allowed" -eq 0 ] && [ "$blocked" -eq 0 ] && [ "$errors" -eq 0 ]; then
    echo "No dependencies were tested." >&2
    exit 1
  fi
  if [ "$blocked" -eq 0 ] && [ "$errors" -eq 0 ]; then
    exit 0
  fi
  exit 2
}
