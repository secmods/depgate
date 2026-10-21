#!/usr/bin/env bash
# Step 2: a TLS certificate for DepGate from a local CA, into this folder's certs/.
#   ./2-generate-cert.sh [host ...]      default: the host in GATEWAY_URL, or localhost
# Skip it with DISABLE_SSL=true, or when your company CA issues the certificate (put its files in certs/).
set -euo pipefail
SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"
export SETUP_DIR
exec "$SETUP_DIR/../common/generate-cert.sh" "$@"
