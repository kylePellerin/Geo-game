.PHONY: worldmap db db-down db-reset migrate push-db psql test lint e2e data ingest popularity flags load facts report generate replace finalize rebuild-stats practice dev play

db:
	docker compose up -d --wait db
	./db/migrate.sh

migrate:
	./db/migrate.sh

# Copy the game content (not player data) to the hosted database: make push-db DATABASE_URL=...
push-db:
	./db/push.sh

db-down:
	docker compose down

# Destroys all local data, then recreates the schema.
db-reset:
	docker compose down -v
	$(MAKE) db

psql:
	docker compose exec db psql -U geo_game -d geo_game

test:
	python -m pytest -c pipeline/pyproject.toml pipeline/tests
	npm --prefix app test

# Browser test: plays a whole day in headless Chromium (needs `make db` + generated puzzles).
# First time: cd app && npx playwright install --with-deps chromium
e2e:
	npm --prefix app run e2e

lint:
	python -m ruff check pipeline
	npm --prefix app run lint

# ---- data pipeline (each step is cached and re-runnable; pass ARGS=--refresh to re-download)
PY := cd pipeline && python -m

ingest:
	$(PY) geo_pipeline.ingest.countries $(ARGS)
	$(PY) geo_pipeline.ingest.cities $(ARGS)
	$(PY) geo_pipeline.ingest.airports $(ARGS)
	$(PY) geo_pipeline.ingest.enrich $(ARGS)
	$(PY) geo_pipeline.ingest.shapes $(ARGS)
	$(PY) geo_pipeline.locators
	$(PY) geo_pipeline.ingest.features $(ARGS)
	$(PY) geo_pipeline.ingest.symbols $(ARGS)

popularity:
	$(PY) geo_pipeline.popularity

flags:
	$(PY) geo_pipeline.flags

# Pixel world map for the game background (needs ingest.shapes + mountains/cities ingested)
worldmap:
	$(PY) geo_pipeline.worldmap

# Until flags_tags.yaml is reviewed, load with: make load LOAD_ARGS=--allow-unreviewed-flags
load:
	$(PY) geo_pipeline.load $(LOAD_ARGS)

report:
	$(PY) geo_pipeline.report

# Fact cards from the loaded data (reviewed ones are never overwritten)
facts:
	$(PY) geo_pipeline.facts

# Replace one question of an upcoming day: make replace DATE=2026-12-01 IDX=2 (0-based)
replace:
	$(PY) geo_pipeline.replace_question --date $(DATE) --idx $(IDX)

data: ingest popularity load facts practice report

# Generate puzzles (FROM defaults to tomorrow UTC). Add GEN_ARGS="--print" to see them,
# "--dry-run" to not write, "--replace" to regenerate unreviewed, unanswered future dates.
DAYS ?= 30
generate:
	$(PY) geo_pipeline.generate_puzzles --days $(DAYS) $(if $(FROM),--from $(FROM)) $(GEN_ARGS)

# Practice pool (never scored): all passing free-text questions + some rounds; re-run after `load`
practice:
	$(PY) geo_pipeline.generate_practice

# ---- game (Phase 4)
dev:
	npm --prefix app run dev

# Production build on http://localhost:3000: much faster to click through than `make dev`, which
# compiles each route on first use (several seconds per new screen).
play:
	npm --prefix app run build && npm --prefix app run start

# Nightly: finalise yesterday's scores (DATE=YYYY-MM-DD for another finished day)
finalize:
	npm --prefix app run finalize -- $(DATE)

rebuild-stats:
	npm --prefix app run rebuild-stats
