#!/usr/bin/env bash
# Run DepGate k6 scenarios. Each scenario configures its own policies, then removes them.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

use_docker=0
if ! command -v k6 >/dev/null 2>&1; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "k6 is not installed, and docker is not available to run grafana/k6." >&2
    echo "Install k6: https://grafana.com/docs/k6/latest/set-up/install-k6/" >&2
    exit 1
  fi
  use_docker=1
  echo "k6 is not on PATH. Using the grafana/k6 Docker image." >&2
fi

export BASE_URL="${BASE_URL:-http://localhost:3050}"
export ADMIN_USER="${ADMIN_USER:-admin@depgate.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
export RESULTS_DIR="${RESULTS_DIR:-perf/results}"

mkdir -p "$RESULTS_DIR"

scenarios=()
extra=()
if [[ $# -eq 0 && -n "${SCENARIO:-}" ]]; then
  IFS=',' read -r -a scenarios <<< "$SCENARIO"
else
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == -* ]]; then
      extra=("$@")
      break
    fi
    scenarios+=("$1")
    shift
  done
fi

if [[ ${#scenarios[@]} -eq 0 ]]; then
  scenarios=(mixed)
fi

known="mixed allow block-package block-license block-cve allowlist scoped namespace scorecard epss sso cached"
for name in "${scenarios[@]}"; do
  if [[ " $known " != *" $name "* ]]; then
    echo "Unknown scenario: $name" >&2
    echo "Use one of: $known" >&2
    exit 1
  fi
done

# A k6 container cannot open the host's localhost. Point it at the gateway through Docker's host name.
docker_base_url() {
  local url="$1"
  if [[ "$url" =~ ^(https?://)(localhost|127\.0.0.1)(:[0-9]+)?(/.*)?$ ]]; then
    echo "${BASH_REMATCH[1]}host.docker.internal${BASH_REMATCH[3]}${BASH_REMATCH[4]}"
  else
    echo "$url"
  fi
}

run_k6() {
  local name="$1"
  shift
  local summary="${RESULTS_DIR}/${name}.k6.json"
  # Sign-in load has its own script (perf/k6/sso.js); every other scenario is an install replay.
  local script="perf/k6/load.js"
  if [[ "$name" == "sso" ]]; then script="perf/k6/sso.js"; fi
  if [[ "$use_docker" -eq 0 ]]; then
    # k6 does not expose the process environment unless asked.
    SCENARIO="$name" KEYCLOAK_IP="${KEYCLOAK_IP:-127.0.0.1}" k6 run \
      --include-system-env-vars \
      --summary-export "$summary" \
      "$@" \
      "$script"
    return
  fi
  local gateway
  gateway="$(docker_base_url "$BASE_URL")"
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    --add-host=keycloak.localhost:host-gateway \
    -v "${root}:/src" \
    -w /src \
    -e "BASE_URL=${gateway}" \
    -e "SCENARIO=${name}" \
    -e "ADMIN_USER=${ADMIN_USER}" \
    -e "ADMIN_PASSWORD=${ADMIN_PASSWORD}" \
    -e "RESULTS_DIR=${RESULTS_DIR}" \
    -e "ECOSYSTEMS=${ECOSYSTEMS:-}" \
    -e "PACKAGES=${PACKAGES:-}" \
    -e "VUS=${VUS:-}" \
    -e "DURATION=${DURATION:-}" \
    -e "COLD_DURATION=${COLD_DURATION:-}" \
    -e "TIMEOUT=${TIMEOUT:-}" \
    -e "SKIP_DOWNLOAD=${SKIP_DOWNLOAD:-}" \
    -e "REPO=${REPO:-}" \
    -e "QUIET=${QUIET:-}" \
    -e "INSECURE_SKIP_TLS=${INSECURE_SKIP_TLS:-}" \
    -e "GRACEFUL_STOP=${GRACEFUL_STOP:-}" \
    -e "SESSION_RATE=${SESSION_RATE:-}" \
    -e "SSO_ISSUER=${SSO_ISSUER:-}" \
    -e "SSO_CLIENT_SECRET=${SSO_CLIENT_SECRET:-}" \
    -e "SSO_PROTOCOLS=${SSO_PROTOCOLS:-}" \
    -e "KEYCLOAK_URL=${KEYCLOAK_URL:-}" \
    -e "SAML_METADATA_URL=${SAML_METADATA_URL:-}" \
    grafana/k6 run \
      --include-system-env-vars \
      --summary-export "$summary" \
      "$@" \
      "$script"
}

failed=0
for name in "${scenarios[@]}"; do
  echo "==> scenario ${name}"
  if [[ ${#extra[@]} -gt 0 ]]; then
    run_k6 "$name" "${extra[@]}" || failed=1
  else
    run_k6 "$name" || failed=1
  fi
done

if compgen -G "${RESULTS_DIR}/*.report.json" >/dev/null; then
  node perf/compare-results.mjs "$RESULTS_DIR" || true
fi

exit "$failed"
