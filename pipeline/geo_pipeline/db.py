"""Postgres connection for pipeline scripts."""

from __future__ import annotations

import os
import socket
import struct
from pathlib import Path

import psycopg


def _default_gateway() -> str | None:
    """IPv4 default gateway from /proc/net/route (the Docker host, inside a container)."""
    try:
        for line in Path("/proc/net/route").read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == "00000000" and int(fields[3], 16) & 2:
                return socket.inet_ntoa(struct.pack("<L", int(fields[2], 16)))
    except (OSError, ValueError, IndexError):
        pass
    return None


def _default_host() -> str:
    # Inside the devcontainer, Compose publishes Postgres on the Docker host, not on localhost.
    # The bridge gateway is reliable; host.docker.internal can hang after a Docker Desktop restart.
    if Path("/.dockerenv").exists():
        return _default_gateway() or "host.docker.internal"
    return "localhost"


def database_url() -> str:
    return os.environ.get(
        "DATABASE_URL", f"postgresql://geo_game:geo_game_dev@{_default_host()}:5432/geo_game"
    )


def connect() -> psycopg.Connection:
    return psycopg.connect(database_url(), connect_timeout=10)
