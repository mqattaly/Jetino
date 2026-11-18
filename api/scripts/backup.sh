#!/usr/bin/env bash
# Write a timestamped, checksummed custom-format dump plus the row counts a restore must match.
# Usage: DATABASE_URL=postgresql://... ./scripts/backup.sh [output-dir]
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set to the database being backed up}"

# ?schema=public and friends belong to the application driver, not to libpq:
# psql and pg_dump reject unknown URI parameters, so the tools get the bare URL
source_url="${DATABASE_URL%%\?*}"
out_dir="${1:-${BACKUP_DIR:-backups}}"
keep="${BACKUP_KEEP:-14}"
mkdir -p "$out_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$out_dir/jetino-$stamp.dump"

# Record what the dump is supposed to contain, so the drill compares a restore
# against the database as it was at backup time instead of racing a live one.
tables="$(psql "$source_url" -X -At -c "
  SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'jetino_drill%' ORDER BY tablename")"
counts="$out_dir/jetino-$stamp.rows"
: > "$counts.tmp"
{
  echo "# database=$(psql "$source_url" -X -At -c 'SELECT current_database()')"
  echo "# taken_at=$stamp"
} >> "$counts.tmp"
while IFS= read -r table; do
  [ -n "$table" ] || continue
  rows="$(psql "$source_url" -X -At -c "SELECT count(*) FROM \"$table\"")"
  printf '%s\t%s\n' "$table" "$rows" >> "$counts.tmp"
done <<< "$tables"
mv "$counts.tmp" "$counts"

pg_dump "$source_url" --format=custom --compress=9 --no-owner --no-privileges --file "$dump"
( cd "$out_dir" && sha256sum "$(basename "$dump")" > "$(basename "$dump").sha256" )

# Keep the newest $keep backups; a directory that grows forever is how a backup
# turns into an outage.
ls -1t "$out_dir"/jetino-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do
  rm -f "$old" "${old%.dump}.dump.sha256" "${old%.dump}.rows"
done

echo "backup: $dump"
echo "rows:   $counts"
