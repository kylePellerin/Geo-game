#!/usr/bin/env bash
# Copy the game content from the local database to a hosted one (DEPLOY.md):
#   DATABASE_URL='postgresql://...' ./db/push.sh      (or: make push-db DATABASE_URL=...)
#
# 1. applies the migrations to the target,
# 2. replaces every content table there (places, aliases, puzzles, practice, facts...) with the
#    local copy. Player data (players, answers, stats, codes) is never copied: the hosted game
#    starts with no players, and the local playtests don't skew its rarity scores.
# Refuses to run if the target already has players, so it can't wipe a live game's puzzles.
# Uses psql/pg_dump inside the local db container, so nothing needs installing.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?set DATABASE_URL to the hosted database (Supabase session pooler, port 5432)}"
case "$DATABASE_URL" in
  *@localhost*|*@127.0.0.1*|*@172.17.0.1*|*@host.docker.internal*|*@db:*|*@db/*)
    echo "DATABASE_URL points at the local database; it should be the hosted one" >&2; exit 1 ;;
esac

# Player data, plus bookkeeping that belongs to each database.
PLAYER_TABLES="players answers question_plays daily_scores player_stats answer_counts unmatched_log
claim_attempts transfer_codes schema_migrations"

local_psql() { docker compose exec -T db psql -U geo_game -d geo_game -v ON_ERROR_STOP=1 -qtA "$@"; }
remote_psql() { docker compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA "$@"; }

echo "== migrations"
./db/migrate.sh

players="$(remote_psql -c "SELECT count(*) FROM players")"
if [[ "$players" != "0" && "${FORCE:-}" != "1" ]]; then
  echo "the hosted database already has $players players; not replacing its content (FORCE=1 to do it anyway)" >&2
  exit 1
fi

skip="$(printf "'%s'," $PLAYER_TABLES)"
tables="$(local_psql -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public'
                          AND tablename NOT IN (${skip%,}) ORDER BY tablename")"
echo "== copying: $(echo $tables)"
list="$(echo $tables | sed 's/ /, /g')"
args=(); for t in $tables; do args+=(-t "public.$t"); done

{
  echo "BEGIN;"
  echo "TRUNCATE $list RESTART IDENTITY CASCADE;"
  docker compose exec -T db pg_dump -U geo_game -d geo_game --data-only --no-owner --no-privileges "${args[@]}" \
    | grep -v '^SET transaction_timeout'   # pg 17 dump option older servers reject
  echo "COMMIT;"
} | docker compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q

echo "== check"
remote_psql -c "SELECT 'entities ' || count(*) FROM entities
                UNION ALL SELECT 'puzzle days ' || count(*) || ' (' || min(date) || ' to ' || max(date) || ')' FROM daily_puzzles
                UNION ALL SELECT 'practice questions ' || count(*) FROM practice_questions
                UNION ALL SELECT 'database size ' || pg_size_pretty(pg_database_size(current_database()))"
echo "done"
