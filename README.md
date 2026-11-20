# Geo-rarity

## Open the development environment

Install VS Code, Docker Desktop (Windows/macOS) or Docker Engine with Compose (Linux), and the
**Dev Containers** VS Code extension. Clone this repository, open its folder in VS Code, then run
**Dev Containers: Reopen in Container** from the Command Palette.

The container provides Python 3.12 and Node.js 22, installs the pipeline and app dependencies, and
starts the local PostgreSQL database when the container opens. The database includes `pg_trgm` and
`unaccent`; its development credentials are defined in `compose.yaml` and must not be used in a
deployed environment.

The first open needs internet access to download the container image and dependencies. Docker is
still required on each computer to run the Dev Container and database; Python and Node do not need
to be installed on the host.

To move to another computer, commit and push this repository to a Git remote, then clone it there
and use **Dev Containers: Reopen in Container**. The Dev Container configuration lives in the
repository so the toolchain setup travels with the code.

## Common commands

Run these in the VS Code terminal inside the container:

```sh
make db        # start Postgres and apply any new migrations
make migrate   # apply new migrations only
make db-reset  # wipe local data and rebuild the schema
make psql      # open a psql shell
make test
make lint
npm --prefix app run dev
```

The web app is available at `http://localhost:3000`. To stop PostgreSQL, run `make db-down`.

## Database migrations

Add new files as `db/migrations/NNN_description.sql`. `make db` / `make migrate` applies any not yet
recorded in `schema_migrations`, each in its own transaction. Never edit a migration that has
already been applied; add a new one.

## Data pipeline (Phase 1: countries, cities, airports, flags)

```sh
make ingest       # countries -> cities -> airports into pipeline/out/*.parquet (cached in pipeline/raw/)
make popularity   # popularity per entity (sitelinks estimate for now; see PLAN.md §12)
make flags        # regenerate pipeline/flags_tags.yaml (draft flag tags, needs human review)
make load LOAD_ARGS="--allow-unreviewed-flags --prune"   # upsert into Postgres
make report       # data-quality report -> pipeline/out/quality_report.md
```

Pass `ARGS=--refresh` to `make ingest` to re-download sources. A cold run takes ~30–40 min, mostly
Wikidata SPARQL; cached runs take a couple of minutes. Inside the devcontainer the pipeline reaches
Postgres at `host.docker.internal`; set `DATABASE_URL` to override.

## Question engine (Phase 2)

Templates live in `pipeline/templates/*.yaml` (format notes at the top of `flags.yaml`).

```sh
make generate GEN_ARGS="--dry-run --print"   # preview 30 days from tomorrow
make generate                                # write them to daily_puzzles / puzzle_questions
make generate FROM=2027-01-01 DAYS=90
```

Each puzzle question stores its frozen answer set plus generation stats (answer count, rarity
category counts, per-answer category) in `puzzle_questions.stats`.

## Answer matcher (Phase 3)

`app/lib/matcher.ts` turns free text into an entity (`valid`, `real_but_wrong`, `did_you_mean`,
`unrecognised`); see PLAN.md §5. Fixtures are in `pipeline/tests/match_cases.yaml` and run with
`npm --prefix app test` (they need the local database; they're skipped if it isn't running).
To fix a missed alias, add it to `pipeline/data/aliases_curated.yaml` and run `make load`.

## Game API (Phase 4)

```sh
make dev                                  # http://localhost:3000, API under /api
GAME_TODAY=2026-11-21 npm --prefix app run dev   # play a generated date (dev only)
make finalize                             # nightly: finalise yesterday's scores
make rebuild-stats                        # rebuild all player stats from answers
```

Endpoints: `GET /api/daily`, `POST /api/answer`, `GET /api/results/:date`, `GET /api/stats`,
`POST /api/identity/reconcile`, `GET /api/flag/:date/:idx/:pos`. See PLAN.md §7. The 500-player
simulation is `app/lib/game/game.integration.test.ts` (runs with `make test`, needs the DB).
