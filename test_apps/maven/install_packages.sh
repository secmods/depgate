#!/usr/bin/env bash
# Resolve each Maven artifact through DepGate inside the official Maven image.
set -eu
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
# shellcheck source=../lib/common.sh
. "$ROOT_DIR/lib/common.sh"

depgate_args "maven" "maven:3.9-eclipse-temurin-21" "${1:-}" "${2:-}"
depgate_enter "maven:3.9-eclipse-temurin-21"
depgate_setup "maven" "/maven/default/"
depgate_copy_app

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
cat > /tmp/settings.xml <<EOF
<settings>
  <mirrors>
    <mirror>
      <id>maven-default-http-blocker</id>
      <mirrorOf>external:dummy</mirrorOf>
      <name>Disable the default HTTP blocker</name>
      <url>http://0.0.0.0/</url>
      <blocked>false</blocked>
    </mirror>
    <mirror>
      <id>depgate</id>
      <url>${REGISTRY_URL}</url>
      <mirrorOf>*</mirrorOf>
      <blocked>false</blocked>
    </mirror>
  </mirrors>
  <servers>
    <server>
      <id>depgate</id>
      <username>_</username>
      <password>${pass}</password>
    </server>
  </servers>
</settings>
EOF
chmod 600 /tmp/settings.xml

while read -r coord; do
  [ -z "${coord:-}" ] && continue
  safe=$(printf '%s' "$coord" | tr ':/' '__')
  repo="/tmp/m2-${safe}"
  mkdir -p "$repo"
  depgate_install "$coord" -- \
    mvn -B -s /tmp/settings.xml -Dmaven.repo.local="$repo" \
      org.apache.maven.plugins:maven-dependency-plugin:3.6.1:get \
      -Dartifact="$coord" -Dtransitive=false
done <<EOF
$(awk '
  /<dependency>/ { g = ""; a = ""; v = "" }
  /<groupId>/ {
    line = $0
    gsub(/.*<groupId>|<\/groupId>.*/, "", line)
    gsub(/[ \t]/, "", line)
    g = line
  }
  /<artifactId>/ {
    line = $0
    gsub(/.*<artifactId>|<\/artifactId>.*/, "", line)
    gsub(/[ \t]/, "", line)
    a = line
  }
  /<version>/ {
    line = $0
    gsub(/.*<version>|<\/version>.*/, "", line)
    gsub(/[ \t]/, "", line)
    v = line
  }
  /<\/dependency>/ { if (g != "" && a != "" && v != "") print g ":" a ":" v }
' pom.xml)
EOF

depgate_finish
