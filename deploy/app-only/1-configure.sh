#!/usr/bin/env bash
# Step 1: create .env for the app-only setup, pointing at your own Postgres and Redis.
#
#   DB_HOST=pg.corp DB_PORT=5432 DB_USER=depgate DB_PASSWORD=... DB_SSL=true \
#   REDIS_URL='rediss://:pass@redis.corp:6380' ./1-configure.sh
#
# Required inputs: DB_HOST, DB_PASSWORD, REDIS_URL. Postgres and Redis on this same host, outside Docker,
# are reached as host.docker.internal.
# Other inputs (environment variables, all optional):
#   DB_PORT, DB_USER, DB_NAME, DB_SSL        default 5432, depgate, depgate, false
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
#   --force           replace an existing .env (the old one is kept as .env.bak). Keeps its JWT_SECRET
#                     (a new one signs everyone out and breaks every registry token), and its ADMIN_EMAIL
#                     and ADMIN_PASSWORD (the admin exists already).
set -euo pipefail
source "$(dirname "$0")/../common/lib.sh"
need openssl

if [ -f "$ENV_FILE" ] && [ "${1:-}" != "--force" ]; then
  die "$ENV_FILE exists. Edit it, or rerun with --force to regenerate (keeps .env.bak)."
fi
# Values that must survive a regeneration (see --force above).
kept_jwt=""; kept_email=""; kept_password=""
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$ENV_FILE.bak"
  kept_jwt="$(get_env "$ENV_FILE" JWT_SECRET)"
  kept_email="$(get_env "$ENV_FILE" ADMIN_EMAIL)"
  kept_password="$(get_env "$ENV_FILE" ADMIN_PASSWORD)"
fi

host="${DEPGATE_HOST:-localhost}"
https_port="${HTTPS_PORT:-443}"
http_port="${HTTP_PORT:-80}"
image="${DEPGATE_IMAGE:-$(get_env "$ENV_EXAMPLE" DEPGATE_IMAGE)}"
version="${DEPGATE_VERSION:-$(get_env "$ENV_EXAMPLE" DEPGATE_VERSION)}"
admin_email="${ADMIN_EMAIL:-${kept_email:-admin@example.com}}"
admin_password="${ADMIN_PASSWORD:-${kept_password:-$(rand_hex 12)}}"
jwt_secret="${kept_jwt:-$(rand_hex 32)}"

db_host="${DB_HOST:?Set DB_HOST (your Postgres; host.docker.internal for one on this host outside Docker)}"
db_port="${DB_PORT:-5432}"; db_user="${DB_USER:-depgate}"; db_name="${DB_NAME:-depgate}"
db_password="${DB_PASSWORD:?Set DB_PASSWORD for your database}"
db_ssl="${DB_SSL:-false}"
redis_url="${REDIS_URL:?Set REDIS_URL for your Redis, for example redis://:password@redis.corp:6379}"

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
# Without SSL the HTTPS port only matters when moved out of a same-host proxy's way.
if [ "$disable_ssl" = false ] || [ -n "${HTTPS_PORT:-}" ]; then set_env "$ENV_FILE" HTTPS_PORT "$https_port"; fi
set_env "$ENV_FILE" HTTP_PORT "$http_port"
set_env "$ENV_FILE" DB_HOST "$db_host"
set_env "$ENV_FILE" DB_PORT "$db_port"
set_env "$ENV_FILE" DB_USER "$db_user"
set_env "$ENV_FILE" DB_PASSWORD "$db_password"
set_env "$ENV_FILE" DB_NAME "$db_name"
set_env "$ENV_FILE" DB_SSL "$db_ssl"
set_env "$ENV_FILE" REDIS_URL "$redis_url"

cat <<MSG

Address      $gateway
SSL          $([ "$disable_ssl" = true ] && echo "disabled: plain HTTP on port $http_port, nothing on HTTPS" || echo "in DepGate on port $https_port")
Image        $image:$version
Database     $db_host:$db_port/$db_name
Admin        $admin_email / $admin_password   (stored in .env; used only when the account is first created)
MSG
if [ "$disable_ssl" = true ]; then
  echo "Next: ./3-run.sh   (no certificate needed; point your proxy at http://<this host>:$http_port)"
else
  echo "Next: ./2-generate-cert.sh $host"
fi
