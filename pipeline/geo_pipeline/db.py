"""Postgres connection for pipeline scripts."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg

# Inside the devcontainer, Compose publishes Postgres on the Docker host, not on localhost.
_DEFAULT_HOST = "host.docker.internal" if Path("/.dockerenv").exists() else "localhost"
DEFAULT_URL = f"postgresql://geo_game:geo_game_dev@{_DEFAULT_HOST}:5432/geo_game"


def database_url() -> str:
    return os.environ.get("DATABASE_URL", DEFAULT_URL)


def connect() -> psycopg.Connection:
    return psycopg.connect(database_url())
