#!/usr/bin/env bash
# Restore each NuGet package through DepGate inside the official .NET SDK image.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "nuget" "mcr.microsoft.com/dotnet/sdk:8.0" "${1:-}" "${2:-}"
depgate_enter "mcr.microsoft.com/dotnet/sdk:8.0"
depgate_setup "nuget" "/nuget/default/v3/index.json"
depgate_copy_app

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export NUGET_CERT_REVOCATION_MODE=offline

xml_escape() {
  local s=$1
  s=${s//&/&amp;}
  s=${s//</&lt;}
  s=${s//>/&gt;}
  s=${s//\"/&quot;}
  printf '%s' "$s"
}

pass=$(xml_escape "$TOKEN")
umask 077
cat > /tmp/NuGet.Config <<EOF
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="depgate" value="${REGISTRY_URL}" allowInsecureConnections="true" />
  </packageSources>
  <packageSourceCredentials>
    <depgate>
      <add key="Username" value="_" />
      <add key="ClearTextPassword" value="${pass}" />
    </depgate>
  </packageSourceCredentials>
  <config>
    <add key="signatureValidationMode" value="accept" />
  </config>
</configuration>
EOF
chmod 600 /tmp/NuGet.Config

while read -r name version; do
  [ -z "${name:-}" ] && continue
  safe=$(printf '%s' "$name" | tr '/@ .' '____')
  dir="/tmp/nuget-${safe}"
  mkdir -p "$dir"
  cat > "${dir}/Probe.csproj" <<EOF
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <NuGetAudit>false</NuGetAudit>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="${name}" Version="${version}" />
  </ItemGroup>
</Project>
EOF
  cp /tmp/NuGet.Config "${dir}/NuGet.Config"
  depgate_install "${name}@${version}" -- \
    dotnet restore "${dir}/Probe.csproj" --configfile "${dir}/NuGet.Config" \
      --packages "${dir}/packages" --verbosity normal --force
done <<EOF
$(sed -n 's/.*Include="\([^"]*\)".*Version="\([^"]*\)".*/\1 \2/p' Depgate.Nuget.Test.csproj)
EOF

depgate_finish
