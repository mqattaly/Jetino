#!/usr/bin/env bash
# Prove the newest backup really rebuilds the platform: restore it into a throwaway
# database, compare it with the counts the backup recorded, then drop the copy.
# Usage: DRILL_DATABASE_URL=postgresql://.../postgres ./scripts/restore-drill.sh [backup-dir]
set -euo pipefail

: "${DRILL_DATABASE_URL:?DRILL_DATABASE_URL must point at the maintenance database the drill may create databases in}"

backup_dir="${1:-${BACKUP_DIR:-backups}}"
prefix="${DRILL_DB_PREFIX:-jetino_drill_}"
maintenance="${DRILL_DATABASE_URL%%\?*}"
db_name="${prefix}$(date -u +%Y%m%dT%H%M%SZ)"

dump="$(ls -1t "$backup_dir"/jetino-*.dump 2>/dev/null | head -n 1 || true)"
[ -n "$dump" ] || { echo "no dump found in $backup_dir" >&2; exit 1; }
counts="$backup_dir/$(basename "${dump%.dump}").rows"
[ -f "$counts" ] || { echo "missing row-count sidecar for $(basename "$dump") — a dump nobody can verify is not a backup" >&2; exit 1; }

( cd "$backup_dir" && sha256sum -c "$(basename "$dump").sha256" )

admin_db="$(psql "$maintenance" -X -At -c 'SELECT current_database()')"
connection="${maintenance%/*}/$db_name"
created=0
cleanup() {
  # only ever drop what this run created, and only through the agreed prefix
  if [ "$created" = "1" ] && [ "${KEEP_DRILL_DB:-0}" != "1" ]; then
    psql "$maintenance" -X -q -c "DROP DATABASE IF EXISTS \"$db_name\" WITH (FORCE)" >/dev/null
  fi
}
trap cleanup EXIT

psql "$maintenance" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$db_name\"" >/dev/null
created=1

pg_restore --no-owner --no-privileges -d "$connection" "$dump"

# The migration ledger travels with the dump: a restored database that would
# re-run migrations is a database that will be half-rebuilt in front of users.
ledger="$(psql "$connection" -X -At -c "SELECT count(*) FROM schema_migrations")"
[ "${ledger:-0}" -gt 0 ] || { echo "restored database has no schema_migrations rows — migrate it properly or the restore is not usable" >&2; exit 1; }

restored_tables="$(psql "$connection" -X -At -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
echo "drill: $(basename "$dump") -> $db_name on $admin_db (${restored_tables:-?} tables, $ledger migrations)"

failures=0
while IFS=$'\t' read -r table rows; do
  case "$table" in \#*|"") continue ;; esac
  got="$(psql "$connection" -X -At -c "SELECT count(*) FROM \"$table\"" 2>/dev/null || echo missing)"
  if [ "$got" = "missing" ]; then
    echo "FAIL $table is absent from the restored database"; failures=$((failures + 1))
  elif [ "$got" != "$rows" ]; then
    echo "FAIL $table holds $got rows after restore, backup recorded $rows"; failures=$((failures + 1))
  fi
done < <(grep -v '^#' "$counts")

if [ "$failures" -ne 0 ]; then
  echo "restore drill FAILED: $failures table(s) did not match the backup" >&2
  exit 1
fi
echo "restore drill passed: every table recorded by the backup was rebuilt with the same row count"
