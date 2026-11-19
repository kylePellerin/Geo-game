.PHONY: db db-down db-reset migrate psql test lint

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
