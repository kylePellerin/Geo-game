import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";

/** IPv4 default gateway (the Docker host when running inside the devcontainer). */
function defaultGateway(): string | null {
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === "00000000" && (parseInt(f[3], 16) & 2) !== 0) {
        const hex = f[2];
        return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join(".");
      }
    }
  } catch {
    /* not Linux */
  }
  return null;
}

export function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Same default as pipeline/geo_pipeline/db.py: Compose publishes Postgres on the Docker host.
  const host = existsSync("/.dockerenv") ? (defaultGateway() ?? "host.docker.internal") : "localhost";
  return `postgresql://geo_game:geo_game_dev@${host}:5432/geo_game`;
}

let pool: Pool | null = null;

export function getPool(): Pool {
  pool ??= new Pool({ connectionString: databaseUrl(), max: 10, connectionTimeoutMillis: 5000 });
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}
