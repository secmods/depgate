#!/usr/bin/env bash
# Step 1: create .env for the all-in-one setup, with generated passwords and secrets.
#
# Inputs (environment variables, all optional):
#   DISABLE_SSL       true: plain HTTP only; your own proxy does TLS.  default false
#   GATEWAY_URL       address users reach (with DISABLE_SSL, your proxy's https:// address)
#   DEPGATE_HOST      host name users type          default localhost
#   HTTPS_PORT        host port for HTTPS             default 443
#   HTTP_PORT         host port that redirects        default 80
#   DEPGATE_IMAGE     image name (a mirror)           default the one in .env.example
#   DEPGATE_VERSION   image tag                       default the one in .env.example
#   ADMIN_EMAIL       first admin                     default admin@example.com
#   ADMIN_PASSWORD    first admin password            default generated
#
#   --force           replace an existing .env (the old one is kept as .env.bak). Keeps its JWT_SECRET,
#                     DB_PASSWORD and REDIS_PASSWORD (new ones would lock the app out of its own database and
#                     sign everyone out), and its ADMIN_EMAIL and ADMIN_PASSWORD (the admin exists already).
set -euo pipefail
source "$(dirname "$0")/../common/lib.sh"
need openssl

if [ -f "$ENV_FILE" ] && [ "${1:-}" != "--force" ]; then
  die "$ENV_FILE exists. Edit it, or rerun with --force to regenerate (keeps .env.bak)."
fi
# Values that must survive a regeneration (see --force above).
kept_jwt=""; kept_email=""; kept_password=""; kept_db=""; kept_redis=""
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak"
  kept_jwt="$(get_env "$ENV_FILE" JWT_SECRET)"
  kept_email="$(get_env "$ENV_FILE" ADMIN_EMAIL)"
  kept_password="$(get_env "$ENV_FILE" ADMIN_PASSWORD)"
  kept_db="$(get_env "$ENV_FILE" DB_PASSWORD)"
  kept_redis="$(get_env "$ENV_FILE" REDIS_PASSWORD)"
fi

host="${DEPGATE_HOST:-localhost}"
https_port="${HTTPS_PORT:-443}"
http_port="${HTTP_PORT:-80}"
image="${DEPGATE_IMAGE:-$(get_env "$ENV_EXAMPLE" DEPGATE_IMAGE)}"
version="${DEPGATE_VERSION:-$(get_env "$ENV_EXAMPLE" DEPGATE_VERSION)}"
admin_email="${ADMIN_EMAIL:-${kept_email:-admin@example.com}}"
admin_password="${ADMIN_PASSWORD:-${kept_password:-$(rand_hex 12)}}"
jwt_secret="${kept_jwt:-$(rand_hex 32)}"
# Hex only: both sit inside URLs and command lines in docker-compose.yml.
db_password="${kept_db:-$(rand_hex 24)}"
redis_password="${kept_redis:-$(rand_hex 24)}"

disable_ssl=false
is_true "${DISABLE_SSL:-false}" && disable_ssl=true

if [ "$disable_ssl" = true ]; then
  # Without a proxy URL, default to plain HTTP on this machine (a test without a proxy).
  default_gateway="http://$host"; [ "$http_port" = 80 ] || default_gateway="$default_gateway:$http_port"
else
  default_gateway="https://$host"; [ "$https_port" = 443 ] || default_gateway="$default_gateway:$https_port"
fi
gateway="${GATEWAY_URL:-$default_gateway}"

info "Writing $ENV_FILE"
umask 077
cp "$ENV_EXAMPLE" "$ENV_FILE"
chmod 600 "$ENV_FILE"
set_env "$ENV_FILE" DEPGATE_IMAGE "$image"
set_env "$ENV_FILE" DEPGATE_VERSION "$version"
set_env "$ENV_FILE" DISABLE_SSL "$disable_ssl"
set_env "$ENV_FILE" GATEWAY_URL "$gateway"
set_env "$ENV_FILE" JWT_SECRET "$jwt_secret"
set_env "$ENV_FILE" ADMIN_EMAIL "$admin_email"
set_env "$ENV_FILE" ADMIN_PASSWORD "$admin_password"
set_env "$ENV_FILE" DB_PASSWORD "$db_password"
set_env "$ENV_FILE" REDIS_PASSWORD "$redis_password"
# Without SSL the HTTPS port only matters when moved out of a same-host proxy's way.
if [ "$disable_ssl" = false ] || [ -n "${HTTPS_PORT:-}" ]; then set_env "$ENV_FILE" HTTPS_PORT "$https_port"; fi
set_env "$ENV_FILE" HTTP_PORT "$http_port"

cat <<MSG

Address      $gateway
SSL          $([ "$disable_ssl" = true ] && echo "disabled: plain HTTP on port $http_port, nothing on HTTPS" || echo "in DepGate on port $https_port")
Image        $image:$version
Database     Postgres and Redis in this compose file, reachable only by the app (passwords in .env)
Admin        $admin_email / $admin_password   (stored in .env; used only when the account is first created)
MSG
if [ "$disable_ssl" = true ]; then
  echo "Next: ./3-run.sh   (no certificate needed; point your proxy at http://<this host>:$http_port)"
else
  echo "Next: ./2-generate-cert.sh $host"
fi
