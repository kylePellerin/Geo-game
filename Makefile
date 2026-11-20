.PHONY: db db-down db-reset migrate psql test lint data ingest popularity flags load report generate

db:
	docker compose up -d --wait db
	./db/migrate.sh

migrate:
	./db/migrate.sh

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

lint:
	python -m ruff check pipeline
	npm --prefix app run lint

# ---- data pipeline (each step is cached and re-runnable; pass ARGS=--refresh to re-download)
PY := cd pipeline && python -m

ingest:
	$(PY) geo_pipeline.ingest.countries $(ARGS)
	$(PY) geo_pipeline.ingest.cities $(ARGS)
	$(PY) geo_pipeline.ingest.airports $(ARGS)

popularity:
	$(PY) geo_pipeline.popularity

flags:
	$(PY) geo_pipeline.flags

# Until flags_tags.yaml is reviewed, load with: make load LOAD_ARGS=--allow-unreviewed-flags
load:
	$(PY) geo_pipeline.load $(LOAD_ARGS)

report:
	$(PY) geo_pipeline.report

data: ingest popularity load report

# Generate puzzles (FROM defaults to tomorrow UTC). Add GEN_ARGS="--print" to see them,
# "--dry-run" to not write, "--replace" to regenerate unreviewed, unanswered future dates.
DAYS ?= 30
generate:
	$(PY) geo_pipeline.generate_puzzles --days $(DAYS) $(if $(FROM),--from $(FROM)) $(GEN_ARGS)
