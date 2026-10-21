#!/usr/bin/env bash
# Run every ecosystem test app. A failure in one ecosystem does not skip the others.
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)

if [ $# -ne 2 ]; then
  echo "Usage: ./run-all.sh <registry-url> <email:password>" >&2
  echo "Example: ./run-all.sh http://localhost:3050 'user@example.com:password'" >&2
  exit 1
fi

failed=""
for eco in npm pypi go maven nuget cargo composer rubygems; do
  echo ""
  echo "##############################"
  echo "# ${eco}"
  echo "##############################"
  if "$ROOT/$eco/install_packages.sh" "$1" "$2"; then
    :
  else
    failed="${failed} ${eco}"
  fi
done

echo ""
if [ -z "$failed" ]; then
  echo "All ecosystems allowed every dependency."
  exit 0
fi
echo "Ecosystems with blocked or failed dependencies:${failed}"
exit 2
