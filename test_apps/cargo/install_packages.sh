#!/usr/bin/env bash
# Fetch each crate through DepGate inside the official Rust image.
# Cargo only allows an http registry on localhost, so the gateway is reached via 127.0.0.1.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "cargo" "rust:1-slim" "${1:-}" "${2:-}"
depgate_enter "rust:1-slim"
depgate_setup "cargo" "/cargo/default/"
depgate_copy_app

toml_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

token_toml=$(toml_escape "$TOKEN")
sparse_url="sparse+${REGISTRY_URL}"

while IFS=$(printf '\t') read -r name version; do
  [ -z "${name:-}" ] && continue
  dir="/tmp/cargo-${name}"
  home="/tmp/cargo-home-${name}"
  mkdir -p "${dir}/src" "$home"
  printf 'fn main() {}\n' >"${dir}/src/main.rs"
  cat > "${dir}/Cargo.toml" <<EOF
[package]
name = "probe"
version = "0.1.0"
edition = "2021"

[dependencies]
${name} = "=${version}"
EOF
  # Cargo finds .cargo/config.toml from the current directory, not from --manifest-path,
  # so the registry settings go in CARGO_HOME, which cargo always reads.
  cat > "${home}/config.toml" <<EOF
[registry]
global-credential-providers = ["cargo:token"]

[source.crates-io]
replace-with = "depgate"

[source.depgate]
registry = "${sparse_url}"

[registries.depgate]
index = "${sparse_url}"
token = "${token_toml}"

[net]
retry = 1
EOF
  chmod 600 "${home}/config.toml"
  depgate_install "${name}@${version}" -- \
    env CARGO_HOME="$home" cargo fetch --manifest-path "${dir}/Cargo.toml" --verbose
done <<EOF
$(awk '
  /^\[dependencies\]/ { f = 1; next }
  /^\[/ { f = 0 }
  f && /=/ && $0 !~ /^#/ {
    name = $0
    sub(/=.*/, "", name)
    ver = $0
    sub(/^[^=]*=/, "", ver)
    gsub(/[ "\t]/, "", name)
    gsub(/[ "\t]/, "", ver)
    sub(/^=/, "", ver)
    print name "\t" ver
  }
' Cargo.toml)
EOF

depgate_finish
