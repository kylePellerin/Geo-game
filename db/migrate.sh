#!/usr/bin/env bash
# Apply db/migrations/*.sql in order, each in its own transaction, recording applied files in
# schema_migrations. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# Local database by default. With DATABASE_URL set (e.g. Supabase, see DEPLOY.md) the same psql in
# the local db container connects to that URL instead.
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql_db() { docker compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }
else
  psql_db() { docker compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql -U geo_game -d geo_game -v ON_ERROR_STOP=1 -q "$@"; }
fi

psql_db -c "CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for file in db/migrations/*.sql; do
  name="$(basename "$file")"
  applied="$(psql_db -tA -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")"
  if [[ -z "$applied" ]]; then
    echo "applying $name"
    { cat "$file"; echo; echo "INSERT INTO schema_migrations (filename) VALUES ('$name');"; } \
      | psql_db -1
  fi
done
echo "migrations up to date"
