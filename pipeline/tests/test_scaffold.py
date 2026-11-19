from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_initial_migration_enables_required_extensions_and_tables() -> None:
    migrations = ROOT / "db" / "migrations"
    schema = "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(migrations.glob("*.sql"))
    ).lower()

    for extension in ("pg_trgm", "unaccent"):
        assert f"create extension if not exists {extension}" in schema

    for table in (
        "entities",
        "aliases",
        "relations",
        "question_templates",
        "daily_puzzles",
        "puzzle_questions",
        "answers",
        "answer_counts",
        "unmatched_log",
        "entity_facts",
        "players",
        "player_stats",
        "transfer_codes",
    ):
        assert f"create table {table}" in schema

    assert "alter table relations" in schema
    assert "add column attrs jsonb" in schema
