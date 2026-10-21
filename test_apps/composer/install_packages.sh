#!/usr/bin/env bash
# Install each Composer package through DepGate inside the official Composer image.
# Public Packagist is disabled so packages cannot bypass the gateway.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "composer" "composer:2" "${1:-}" "${2:-}"
depgate_enter "composer:2"
depgate_setup "composer" "/composer/default/packages.json"
depgate_copy_app

export COMPOSER_HOME=/tmp/composer-home
mkdir -p "$COMPOSER_HOME"
php -r '
$host = getenv("AUTH_HOST");
$token = getenv("TOKEN");
$url = getenv("REGISTRY_URL");
$home = getenv("COMPOSER_HOME");
$config = [
  "config" => ["secure-http" => false],
  "repositories" => [
    "packagist.org" => false,
    "depgate" => ["type" => "composer", "url" => $url],
  ],
];
$auth = ["http-basic" => [$host => ["username" => "_", "password" => $token]]];
$flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES;
file_put_contents($home . "/config.json", json_encode($config, $flags) . "\n");
file_put_contents($home . "/auth.json", json_encode($auth, $flags) . "\n");
'
chmod 600 "${COMPOSER_HOME}/config.json" "${COMPOSER_HOME}/auth.json"

while IFS=$(printf '\t') read -r name version; do
  [ -z "${name:-}" ] && continue
  safe=$(printf '%s' "$name" | tr '/@' '__')
  dir="/tmp/composer-${safe}"
  mkdir -p "$dir"
  depgate_install "${name}@${version}" -- \
    composer require --working-dir "$dir" --no-interaction --no-scripts --no-plugins \
      --ignore-platform-reqs --no-cache "${name}:${version}"
done <<EOF
$(php -r '
$j = json_decode(file_get_contents("composer.json"), true);
foreach ($j["require"] as $name => $ver) {
  if ($name === "php") continue;
  if (strncmp($ver, "dev-", 4) !== 0) $ver = preg_replace("/^[^0-9]+/", "", $ver);
  echo $name, "\t", $ver, "\n";
}
')
EOF

depgate_finish
