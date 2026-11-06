#!/usr/bin/env bash
set -euo pipefail
umask 077

tls=/var/lib/postgresql/data/tls
if [[ $# == 1 && $1 == export-ca ]]; then
  test -f "$tls/root.pem"
  cat "$tls/root.pem"
  exit 0
fi
fail() { printf '%s\n' 'TradeFlow dedicated database preflight failed; existing files were preserved.' >&2; exit 1; }
[[ $# == 1 && $1 == postgres ]] || fail
[[ ${PGDATA:-} == /var/lib/postgresql/data/pgdata ]] || fail
[[ ${POSTGRES_USER:-postgres} == postgres ]] || fail
[[ ${POSTGRES_DB:-} =~ ^tradeflow_public_demo_[a-f0-9]{16}$ ]] || fail
[[ ${TF_DEMO_OWNER_NONCE:-} =~ ^[a-f0-9]{32}$ ]] || fail
[[ ${TF_DB_DNS:-} =~ ^[a-z0-9][a-z0-9-]{0,61}\.railway\.internal$ ]] || fail
passwords=()
for name in POSTGRES_PASSWORD TF_APP_PASSWORD TF_MIGRATOR_PASSWORD TF_RECONCILER_PASSWORD TF_MAINTENANCE_PASSWORD; do
  [[ ${!name:-} =~ ^[A-Za-z0-9_-]{43}$ ]] || fail
  for previous in "${passwords[@]}"; do [[ ${!name} != "$previous" ]] || fail; done
  passwords+=("${!name}")
done
[[ ! -L /var/lib/postgresql/data && ! -L "$PGDATA" && ! -L "$tls" ]] || fail
if [[ -f $PGDATA/PG_VERSION ]]; then
  [[ $(cat "$PGDATA/PG_VERSION") == 17 ]] || fail
  [[ -f $tls/identity && -f $tls/root.pem && -f $tls/root.key ]] || fail
fi
identity="TradeFlow public demo $TF_DEMO_OWNER_NONCE $POSTGRES_DB"
if [[ -e $tls/identity ]]; then
  [[ $(cat "$tls/identity") == "$identity" ]] || fail
elif [[ -d $tls && -n $(find "$tls" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
  fail
fi
install -d -m 0700 -o postgres -g postgres "$PGDATA" "$tls"
if [[ ! -f $tls/identity ]]; then
  printf '%s\n' "$identity" > "$tls/identity"
  openssl req -x509 -newkey rsa:3072 -nodes -keyout "$tls/root.key" -out "$tls/root.pem" \
    -days 3650 -subj '/CN=TradeFlow dedicated synthetic database CA' \
    -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' >/dev/null 2>&1
fi
openssl x509 -in "$tls/root.pem" -noout -checkend 0 >/dev/null 2>&1 || fail
root_key=$(openssl pkey -in "$tls/root.key" -pubout 2>/dev/null | sha256sum)
root_certificate_key=$(openssl x509 -in "$tls/root.pem" -pubkey -noout 2>/dev/null | sha256sum)
[[ $root_key == "$root_certificate_key" ]] || fail
renew=true
if [[ -f $tls/server.pem && -f $tls/server.key ]]; then
  if openssl verify -CAfile "$tls/root.pem" -verify_hostname "$TF_DB_DNS" "$tls/server.pem" >/dev/null 2>&1 && \
     openssl x509 -in "$tls/server.pem" -noout -checkend 2592000 >/dev/null 2>&1; then
    public_key=$(openssl pkey -in "$tls/server.key" -pubout 2>/dev/null | sha256sum)
    certificate_key=$(openssl x509 -in "$tls/server.pem" -pubkey -noout 2>/dev/null | sha256sum)
    [[ $public_key == "$certificate_key" ]] || fail
    renew=false
  fi
fi
if [[ $renew == true ]]; then
  temporary=$(mktemp -d "$tls/renew-XXXXXXXX")
  trap 'rm -rf -- "$temporary"' EXIT
  printf '%s\n' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' "subjectAltName=DNS:$TF_DB_DNS" > "$temporary/extensions"
  openssl req -newkey rsa:2048 -nodes -keyout "$temporary/server.key" -out "$temporary/server.csr" \
    -subj "/CN=$TF_DB_DNS" >/dev/null 2>&1
  openssl x509 -req -in "$temporary/server.csr" -CA "$tls/root.pem" -CAkey "$tls/root.key" \
    -CAcreateserial -out "$temporary/server.pem" -days 90 -extfile "$temporary/extensions" >/dev/null 2>&1
  openssl verify -CAfile "$tls/root.pem" -verify_hostname "$TF_DB_DNS" "$temporary/server.pem" >/dev/null 2>&1 || fail
  mv "$temporary/server.key" "$tls/server.key"
  mv "$temporary/server.pem" "$tls/server.pem"
  rm -rf -- "$temporary"
  trap - EXIT
fi
chmod 0600 "$tls/root.key" "$tls/server.key"
chown -R postgres:postgres "$tls"
export POSTGRES_INITDB_ARGS='--auth-host=scram-sha-256 --auth-local=peer'
exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file="$tls/server.pem" -c ssl_key_file="$tls/server.key" \
  -c ssl_min_protocol_version=TLSv1.2 -c password_encryption=scram-sha-256 \
  -c shared_buffers=64MB -c max_connections=20 -c log_statement=none \
  -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0
