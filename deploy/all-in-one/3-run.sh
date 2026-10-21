#!/usr/bin/env bash
# Step 3: start DepGate from the published image and check it answers.
#
#   ./3-run.sh            start, or apply .env changes (pulls the image when it is missing)
#   ./3-run.sh --stop     stop everything (data is kept)
#   ./3-run.sh --logs     follow the app's logs
#
# Nothing here builds. Without registry access, load the image first: docker load -i depgate-<version>.tar
set -euo pipefail
source "$(dirname "$0")/../common/lib.sh"
need docker; need curl

case "${1:-}" in
  --stop) compose down; ok "DepGate stopped (data kept)"; exit 0 ;;
  --logs) exec docker compose --project-directory "$SETUP_DIR" logs -f app ;;
  "") ;;
  *) die "Unknown option $1 (use --stop or --logs)" ;;
esac

[ -f "$ENV_FILE" ] || die "No .env. Run ./1-configure.sh first."
warn_old_version
check_certs
start_and_check
