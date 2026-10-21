#!/usr/bin/env bash
# npm run migration:check [-- <base-ref>]
#
# History check (requirements_schema_migrations.md M4, C2): every migration file that exists on the base
# branch is unchanged on this branch. New files are fine; a modified, renamed or deleted one fails.
# Default base: origin/main. CI runs it for pull requests; the 1.0 squash is the one allowed exception (P9).
set -euo pipefail

base="${1:-origin/main}"
root="$(git rev-parse --show-toplevel)"
dir="packages/backend/migrations"

if ! git -C "$root" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "migration:check: base ref '$base' not found (fetch it, or pass another: npm run migration:check -- main)" >&2
  exit 2
fi

changed="$(git -C "$root" diff --name-status --diff-filter=MDRT "$base...HEAD" -- "$dir" || true)"
if [ -n "$changed" ]; then
  echo "Migrations already on $base were changed on this branch. A migration is never edited once it is on main; fix it with a new one:" >&2
  echo "$changed" >&2
  exit 1
fi
echo "migration:check: no migration on $base was changed."
