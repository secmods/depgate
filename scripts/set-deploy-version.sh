#!/usr/bin/env bash
# Stamps the version from the root package.json into every file that names a release, so the deploy
# files never read package.json themselves (requirements_deploy.md §10):
#
#   deploy/all-in-one/.env.example        DEPGATE_VERSION=
#   deploy/app-only/.env.example          DEPGATE_VERSION=
#   deploy/kubernetes/kustomization.yaml  newTag:
#   packages/backend/package.json         "version" (the app reports it and records it with each migration)
#   packages/ui/package.json              "version"
#
#   scripts/set-deploy-version.sh           write
#   scripts/set-deploy-version.sh --check   change nothing; exit 1 and name every file that disagrees
#
# `npm version <x.y.z>` runs it through the root package.json "version" script and stages the result,
# and CI runs --check on every push. RELEASING.md has the whole procedure.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

version="$(node -p "require('./package.json').version")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || { echo "package.json version '$version' is not x.y.z" >&2; exit 1; }
check=false; [ "${1:-}" = --check ] && check=true

ENV_FILES=(deploy/all-in-one/.env.example deploy/app-only/.env.example)
KUSTOMIZATION=deploy/kubernetes/kustomization.yaml
WORKSPACES=(packages/backend/package.json packages/ui/package.json)

status=0
report() { # file current
  if [ "$check" = true ]; then
    echo "$1 names $2, package.json is $version" >&2; status=1
  else
    echo "$1: $2 -> $version"
  fi
}

for f in "${ENV_FILES[@]}"; do
  current="$(awk -F= '/^DEPGATE_VERSION=/ { print $2 }' "$f")"
  [ -n "$current" ] || { echo "$f has no DEPGATE_VERSION= line" >&2; exit 1; }
  if [ "$current" != "$version" ]; then
    report "$f" "$current"
    [ "$check" = true ] || sed -i.bak "s/^DEPGATE_VERSION=.*/DEPGATE_VERSION=$version/" "$f"
  fi
done

current="$(awk '/^ *newTag:/ { print $2 }' "$KUSTOMIZATION")"
[ -n "$current" ] || { echo "$KUSTOMIZATION has no newTag: line" >&2; exit 1; }
if [ "$current" != "$version" ]; then
  report "$KUSTOMIZATION" "$current"
  [ "$check" = true ] || sed -i.bak "s/^\( *newTag:\).*/\1 $version/" "$KUSTOMIZATION"
fi

for f in "${WORKSPACES[@]}"; do
  current="$(node -p "require('./$f').version")"
  if [ "$current" != "$version" ]; then
    report "$f" "$current"
    # The first "version" line only, keeping the file's formatting.
    [ "$check" = true ] || node -e '
      const fs = require("fs"); const [file, version] = process.argv.slice(1);
      const text = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
    ' "$f" "$version"
  fi
done
rm -f "${ENV_FILES[@]/%/.bak}" "$KUSTOMIZATION.bak"

if [ "$check" = true ]; then
  [ "$status" -eq 0 ] && echo "Deploy files and workspaces name $version"
  exit "$status"
fi
echo "Deploy files and workspaces name $version"
