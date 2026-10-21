#!/usr/bin/env bash
# Steps 1, 2 and 3 with defaults, against your own Postgres and Redis:
#
#   DB_HOST=pg.corp DB_PASSWORD=... REDIS_URL='rediss://:pass@redis.corp:6380' ./quickstart.sh
#   DISABLE_SSL=true GATEWAY_URL=https://depgate.corp ... ./quickstart.sh    plain HTTP behind your proxy; no certificate
#
# Safe to rerun: it keeps an existing .env and certificate.
set -euo pipefail
source "$(dirname "$0")/../common/lib.sh"

if [ -f "$ENV_FILE" ]; then info "Keeping existing $ENV_FILE"; else "$SETUP_DIR/1-configure.sh"; fi
if ssl_disabled "$ENV_FILE"; then info "SSL disabled: no certificate needed"
elif [ -f "$CERT_DIR/tls.crt" ]; then info "Keeping existing certificate"
else "$SETUP_DIR/2-generate-cert.sh"; fi
"$SETUP_DIR/3-run.sh"
