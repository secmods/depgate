#!/usr/bin/env bash
# Install each requirement through DepGate inside the official Python image.
# Credentials live in pip.conf. pip redacts the password in its own log.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "pypi" "python:3.12-slim-bookworm" "${1:-}" "${2:-}"
depgate_enter "python:3.12-slim-bookworm"
depgate_setup "pypi" "/pypi/default/simple/"
depgate_copy_app

export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_CONFIG_FILE=/tmp/pip.conf
umask 077
{
  printf '[global]\n'
  printf 'index-url = %s://_:%s@%s\n' "$SCHEME" "$TOKEN" "${REGISTRY_URL#"$SCHEME"://}"
  printf 'trusted-host = %s\n' "$CLIENT_HOST"
} >"$PIP_CONFIG_FILE"
chmod 600 "$PIP_CONFIG_FILE"

while read -r line; do
  case "$line" in
    ''|\#*) continue ;;
  esac
  name=${line%%==*}
  version=${line#*==}
  safe=$(printf '%s' "$name" | tr '/@' '__')
  dir="/tmp/py-${safe}"
  mkdir -p "$dir"
  depgate_install "${name}==${version}" -- \
    pip install --disable-pip-version-check --no-cache-dir --retries 1 --timeout 30 \
      --trusted-host "$CLIENT_HOST" --target "$dir" "${name}==${version}"
done <requirements.txt

depgate_finish
