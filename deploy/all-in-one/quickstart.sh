#!/usr/bin/env bash
# Steps 1, 2 and 3 with defaults: .env with generated passwords, a local certificate for localhost,
# then Postgres, Redis and DepGate from their published images.
#
#   ./quickstart.sh
#   DISABLE_SSL=true ./quickstart.sh     plain HTTP only (your own proxy does TLS); no certificate
#
# Safe to rerun: it keeps an existing .env and certificate.
set -euo pipefail
source "$(dirname "$0")/../common/lib.sh"

if [ -f "$ENV_FILE" ]; then info "Keeping existing $ENV_FILE"; else "$SETUP_DIR/1-configure.sh"; fi
if ssl_disabled "$ENV_FILE"; then info "SSL disabled: no certificate needed"
elif [ -f "$CERT_DIR/tls.crt" ]; then info "Keeping existing certificate"
else "$SETUP_DIR/2-generate-cert.sh"; fi
"$SETUP_DIR/3-run.sh"
