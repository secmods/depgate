#!/usr/bin/env bash
# Download each Go module through DepGate inside the official Go image.
# GOPROXY has no ",direct" fallback, so a block cannot be fetched from GitHub.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "go" "golang:1.23-bookworm" "${1:-}" "${2:-}"
depgate_enter "golang:1.23-bookworm"
depgate_setup "go" "/go/default"
depgate_copy_app

export GO111MODULE=on
export GOPROXY="${REGISTRY_URL}"

# The go command never sends credentials over plain HTTP (neither ~/.netrc nor
# user:pass in GOPROXY). For an http gateway, terminate TLS inside the container
# with a throwaway certificate and point GOPROXY at it.
if [ "$SCHEME" = "http" ]; then
  TLS_PORT=3443
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost -keyout /tmp/tls-key.pem -out /tmp/tls-cert.pem 2>/dev/null
  cat /tmp/tls-key.pem /tmp/tls-cert.pem >/tmp/tls.pem
  cat /etc/ssl/certs/ca-certificates.crt /tmp/tls-cert.pem >/tmp/ca-bundle.pem
  export SSL_CERT_FILE=/tmp/ca-bundle.pem
  socat "OPENSSL-LISTEN:${TLS_PORT},bind=127.0.0.1,fork,reuseaddr,cert=/tmp/tls.pem,verify=0" \
    "TCP:${CLIENT_HOST}:${PORT}" >/tmp/socat-tls.log 2>&1 &
  sleep 0.4
  # Go 1.23 matches the netrc machine against host:port.
  printf 'machine localhost:%s\nlogin _\npassword %s\n' "$TLS_PORT" "$TOKEN" >>"${HOME}/.netrc"
  export GOPROXY="https://localhost:${TLS_PORT}${REGISTRY_PATH%/}"
  echo "TLS:      ${GOPROXY} (go sends credentials over HTTPS only)"
fi
export GOSUMDB=sum.golang.org
unset GOPRIVATE
unset GONOSUMDB

while read -r name version; do
  [ -z "${name:-}" ] && continue
  case "$version" in
    v*) ;;
    *) version="v${version}" ;;
  esac
  depgate_install "${name}@${version}" -- \
    go mod download "${name}@${version}"
done <<EOF
$(awk '
  /^require \(/ { f = 1; next }
  /^\)/ { f = 0 }
  f && $1 !~ /^\/\// && NF >= 2 { print $1, $2 }
' go.mod)
EOF

depgate_finish
