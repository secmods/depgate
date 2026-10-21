#!/usr/bin/env bash
# Install each npm dependency through DepGate inside the official Node image.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "npm" "node:22-bookworm-slim" "${1:-}" "${2:-}"
depgate_enter "node:22-bookworm-slim"
depgate_setup "npm" "/npm/default/"
depgate_copy_app

auth_path="$REGISTRY_PATH"
case "$auth_path" in
  */) ;;
  *) auth_path="${auth_path}/" ;;
esac
umask 077
{
  printf 'registry=%s\n' "$REGISTRY_URL"
  printf '//%s%s:_authToken=%s\n' "$AUTH_HOST" "$auth_path" "$TOKEN"
  if [ "$CLIENT_HOST" != "127.0.0.1" ]; then
    printf '//127.0.0.1:%s%s:_authToken=%s\n' "$PORT" "$auth_path" "$TOKEN"
  fi
  printf 'fetch-retries=1\nfund=false\naudit=false\nupdate-notifier=false\n'
} >"${HOME}/.npmrc"
chmod 600 "${HOME}/.npmrc"

while IFS=$(printf '\t') read -r name version; do
  [ -z "${name:-}" ] && continue
  safe=$(printf '%s' "$name" | tr '/@' '__')
  dir="/tmp/npm-${safe}"
  cache="/tmp/npm-cache-${safe}"
  mkdir -p "$dir" "$cache"
  depgate_install "${name}@${version}" -- \
    npm install --ignore-scripts --no-audit --no-fund --no-package-lock --fetch-retries=1 \
      --cache "$cache" --prefix "$dir" "${name}@${version}"
done <<EOF
$(node -e '
const pkg = require("./package.json");
for (const [name, version] of Object.entries(pkg.dependencies || {})) {
  process.stdout.write(name + "\t" + String(version).replace(/^[^0-9]+/, "") + "\n");
}
')
EOF

depgate_finish
