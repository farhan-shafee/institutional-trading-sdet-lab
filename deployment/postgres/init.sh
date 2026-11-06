#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/tradeflow
sha256sum --check --status SHA256SUMS
[[ ${POSTGRES_DB:-} =~ ^tradeflow_public_demo_[a-f0-9]{16}$ ]] || exit 1
[[ ${TF_DEMO_OWNER_NONCE:-} =~ ^[a-f0-9]{32}$ ]] || exit 1
for name in TF_APP_PASSWORD TF_MIGRATOR_PASSWORD TF_RECONCILER_PASSWORD TF_MAINTENANCE_PASSWORD; do
  [[ ${!name:-} =~ ^[A-Za-z0-9_-]{43}$ ]] || exit 1
done
# Fresh-cluster only: never adopt or reset an existing TradeFlow role set.
roles=$(psql --no-psqlrc --username postgres --dbname "$POSTGRES_DB" -Atqc \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('tf_owner','tf_migrator','tf_app','tf_reconciler','tf_maintenance')")
[[ $roles == 0 ]] || { printf '%s\n' 'Refusing to overwrite existing database roles.' >&2; exit 1; }
{
  printf '%s\n' 'BEGIN;' "SET LOCAL log_statement='none';" "SET LOCAL log_min_error_statement='panic';" \
    "SET LOCAL log_parameter_max_length=0;" "SET LOCAL log_parameter_max_length_on_error=0;"
  cat db/public-demo/roles.sql
  # Strictly generated base64url inputs enter psql through stdin, never process arguments.
  printf "ALTER ROLE tf_app PASSWORD '%s';\n" "$TF_APP_PASSWORD"
  printf "ALTER ROLE tf_migrator PASSWORD '%s';\n" "$TF_MIGRATOR_PASSWORD"
  printf "ALTER ROLE tf_reconciler PASSWORD '%s';\n" "$TF_RECONCILER_PASSWORD"
  printf "ALTER ROLE tf_maintenance PASSWORD '%s';\n" "$TF_MAINTENANCE_PASSWORD"
  printf 'GRANT CREATE ON DATABASE %s TO tf_owner;\nSET LOCAL ROLE tf_owner;\n' "$POSTGRES_DB"
  for path in db/migrations/[0-9][0-9][0-9]_*.sql; do
    filename=${path##*/}; version=${filename:0:3}; version=$((10#$version))
    checksum=$(sha256sum "$path"); checksum=${checksum%% *}
    cat "$path"
    printf "\nINSERT INTO fi_control.schema_migrations(version,checksum) VALUES(%s,'%s');\n" "$version" "$checksum"
  done
  cat db/public-demo/001_profile.sql
  checksum=$(sha256sum db/public-demo/001_profile.sql);checksum=${checksum%% *}
  printf "\nINSERT INTO fi_control.public_demo_profile VALUES(true,'public-workflow-v1',1,'%s',current_database());\n" "$checksum"
  printf "RESET ROLE;\nCOMMENT ON DATABASE %s IS 'TradeFlow public demo owner %s';\nCOMMIT;\n" "$POSTGRES_DB" "$TF_DEMO_OWNER_NONCE"
} | psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 --username postgres --dbname "$POSTGRES_DB"
printf '%s\n' 'local all all peer' 'hostnossl all all all reject' 'hostssl all all all scram-sha-256' > "$PGDATA/pg_hba.conf"
printf '%s\n' 'TradeFlow dedicated public profile initialized.'
