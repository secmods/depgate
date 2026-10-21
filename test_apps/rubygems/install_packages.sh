#!/usr/bin/env bash
# Install each gem through DepGate inside the official Ruby image.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "rubygems" "ruby:3.3-slim-bookworm" "${1:-}" "${2:-}"
depgate_enter "ruby:3.3-slim-bookworm"
depgate_setup "rubygems" "/rubygems/default"
depgate_copy_app

# gem does not read ~/.netrc. Credentials go in the source URL, as on the Registry page.
SOURCE_URL="${SCHEME}://_:${TOKEN}@${REGISTRY_URL#"$SCHEME"://}"

while read -r name version; do
  [ -z "${name:-}" ] && continue
  home="/tmp/gem-${name}"
  mkdir -p "$home"
  depgate_install "${name}@${version}" -- \
    env GEM_HOME="$home" GEM_PATH="$home" \
      gem install "$name" -v "$version" --clear-sources --source "$SOURCE_URL" --no-document
done <<EOF
$(awk -F '"' '/^[[:space:]]*gem / { print $2, $4 }' Gemfile)
EOF

depgate_finish
