#!/usr/bin/env bash
# Issues a TLS certificate for DepGate from a local CA, the way a company CA would. Called by the
# 2-generate-cert.sh of a setup folder, which sets SETUP_DIR; do not run it from here.
#
#   ./2-generate-cert.sh [host ...]      default: the host in GATEWAY_URL, or localhost
#
# Writes the three files certs/ holds: tls.crt, tls.key and ca.crt (public). The CA's private key stays
# in local-ca/, outside the folder mounted into the container, so a reissued certificate stays trusted.
# Clients trust ca.crt once (see the end of the output).
#
# With a real company CA, skip this: put its tls.crt (full chain), tls.key and ca.crt in certs/ instead.
set -euo pipefail
: "${SETUP_DIR:?Run ./2-generate-cert.sh inside all-in-one/ or app-only/, not this file}"
source "$(dirname "$0")/lib.sh"
need openssl

hosts=("$@")
if [ ${#hosts[@]} -eq 0 ]; then
  gw="$(get_env "$ENV_FILE" GATEWAY_URL)"
  h="${gw#https://}"; h="${h%%/*}"; h="${h%%:*}"
  hosts=("${h:-localhost}")
fi
primary="${hosts[0]}"

mkdir -p "$CERT_DIR" "$CA_DIR"
chmod 700 "$CA_DIR"
umask 077

if [ ! -f "$CA_DIR/ca.key" ]; then
  info "Creating a local CA in $CA_DIR (valid 10 years)"
  openssl req -x509 -new -nodes -newkey rsa:3072 -sha256 -days 3650 \
    -subj "/O=DepGate Local CA/CN=DepGate Local CA" \
    -keyout "$CA_DIR/ca.key" -out "$CA_DIR/ca.crt" 2>/dev/null
else
  info "Reusing the CA in $CA_DIR"
fi

# Subject Alternative Names: every host given, plus loopback when one of them is localhost.
san=""; i=0; j=0
for h in "${hosts[@]}"; do
  if [[ "$h" =~ ^[0-9.]+$ || "$h" == *:* ]]; then j=$((j + 1)); san="${san}IP.$j = $h"$'\n'
  else i=$((i + 1)); san="${san}DNS.$i = $h"$'\n'; fi
  if [ "$h" = localhost ]; then j=$((j + 1)); san="${san}IP.$j = 127.0.0.1"$'\n'; fi
done

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cat > "$work/ext.cnf" <<CNF
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
$san
CNF

info "Issuing a certificate for: ${hosts[*]} (valid 397 days, the browser maximum)"
openssl req -new -nodes -newkey rsa:2048 -sha256 -subj "/CN=$primary" \
  -keyout "$work/tls.key" -out "$work/tls.csr" 2>/dev/null
openssl x509 -req -sha256 -days 397 -in "$work/tls.csr" \
  -CA "$CA_DIR/ca.crt" -CAkey "$CA_DIR/ca.key" -CAcreateserial -CAserial "$CA_DIR/ca.srl" \
  -extfile "$work/ext.cnf" -out "$work/tls.crt" 2>/dev/null

# Replace both files together; the app reloads them within a minute.
mv "$work/tls.key" "$CERT_DIR/tls.key"
mv "$work/tls.crt" "$CERT_DIR/tls.crt"
cp "$CA_DIR/ca.crt" "$CERT_DIR/ca.crt"
# The container runs as uid 1000 (node), which must read them.
chmod 644 "$CERT_DIR/tls.crt" "$CERT_DIR/ca.crt"
chmod 640 "$CERT_DIR/tls.key"
if [ "$(uname)" = Linux ] && [ "$(id -u)" != 1000 ]; then
  chown 1000 "$CERT_DIR/tls.key" 2>/dev/null || { chmod 644 "$CERT_DIR/tls.key"; warn "tls.key made world-readable so the container can read it; chown it to uid 1000 instead when you can"; }
fi

openssl verify -CAfile "$CA_DIR/ca.crt" "$CERT_DIR/tls.crt" >/dev/null && ok "certs/tls.crt verifies against certs/ca.crt"
openssl x509 -in "$CERT_DIR/tls.crt" -noout -subject -enddate -ext subjectAltName 2>/dev/null | sed 's/^/    /'

cat <<MSG

Trust the CA (certs/ca.crt; never copy local-ca/ca.key anywhere) on machines that use DepGate:
  curl          --cacert $CERT_DIR/ca.crt
  npm           npm config set cafile $CERT_DIR/ca.crt
  pip           pip config set global.cert $CERT_DIR/ca.crt
  macOS browser sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain $CERT_DIR/ca.crt
Next: ./3-run.sh
MSG
