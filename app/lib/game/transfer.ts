/**
 * Moving devices and deleting data (PLAN.md §10).
 *
 * - createTransferCode: 8 characters from an alphabet without look-alikes (no 0/O, 1/I),
 *   valid 24 hours, single use. A new code replaces the player's unused ones.
 * - claimTransferCode: the new device becomes the original player. If the new device has its own
 *   history it is merged in: days the original player didn't play move across; days both played
 *   keep the original's. The new device's player is then deleted and the stats rebuilt.
 * - Claims are rate limited per IP and per player in the database.
 * - deletePlayer: removes the player and everything keyed to them (answers, plays, stats...).
 *   Aggregate answer counts stay: they hold no player id.
 */
import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { GameError } from "./answer";
import { refreshPlayerStats } from "./stats";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const CODE_TTL_HOURS = 24;
export const CLAIM_LIMIT = 10;
export const CLAIM_WINDOW_MINUTES = 15;

export function newCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** What a player types: case-insensitive, spaces and dashes ignored ("ab3d-ef7h"). */
export function cleanCode(raw: unknown): string {
  return String(raw ?? "").toUpperCase().replace(/[\s-]/g, "");
}

export async function createTransferCode(db: Pool, playerId: string): Promise<{ code: string; expiresAt: string }> {
  await db.query("DELETE FROM transfer_codes WHERE player_id = $1 AND used_at IS NULL", [playerId]);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const r = await db.query<{ expires_at: Date }>(
      `INSERT INTO transfer_codes (code, player_id, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3))
       ON CONFLICT (code) DO NOTHING RETURNING expires_at`,
      [code, playerId, CODE_TTL_HOURS],
    );
    if (r.rows.length) return { code, expiresAt: r.rows[0].expires_at.toISOString() };
  }
  throw new GameError("internal", "Couldn't make a code, try again", 500);
}

async function allowClaim(db: Pool, keys: string[]): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM claim_attempts
     WHERE key = ANY($1) AND at > now() - make_interval(mins => $2)`,
    [keys, CLAIM_WINDOW_MINUTES],
  );
  if (Number(rows[0].n) >= CLAIM_LIMIT) return false;
  await db.query("INSERT INTO claim_attempts (key) SELECT unnest($1::text[])", [keys]);
  // keep the table small
  await db.query("DELETE FROM claim_attempts WHERE at < now() - interval '1 day'");
  return true;
}

/** Move `from`'s days that `to` hasn't played into `to`. Returns the dates moved. */
async function mergeInto(client: PoolClient, from: string, to: string): Promise<string[]> {
  const { rows } = await client.query<{ date: string }>(
    `SELECT DISTINCT to_char(date, 'YYYY-MM-DD') AS date FROM question_plays f
     WHERE f.player_id = $1
       AND NOT EXISTS (SELECT 1 FROM question_plays t WHERE t.player_id = $2 AND t.date = f.date)`,
    [from, to],
  );
  const dates = rows.map((r) => r.date);
  if (dates.length) {
    for (const table of ["question_plays", "answers", "daily_scores"]) {
      await client.query(
        `UPDATE ${table} SET player_id = $2 WHERE player_id = $1 AND date = ANY($3::date[])`,
        [from, to, dates],
      );
    }
  }
  return dates;
}

export interface ClaimResult {
  playerId: string;
  /** days of the new device's history that were added to the original player */
  mergedDays: number;
}

export async function claimTransferCode(
  db: Pool, rawCode: unknown, currentPlayer: string | null, ip: string, today: string,
): Promise<ClaimResult> {
  const code = cleanCode(rawCode);
  const keys = [`ip:${ip}`, ...(currentPlayer ? [`player:${currentPlayer}`] : [])];
  if (!(await allowClaim(db, keys))) {
    throw new GameError("rate_limited", "Too many tries. Wait a few minutes and try again.", 429);
  }
  if (code.length !== CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) {
    throw new GameError("bad_code", "That code doesn't look right: it's 8 letters and numbers.", 400);
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ player_id: string; expired: boolean; used: boolean }>(
      `SELECT player_id, expires_at < now() AS expired, used_at IS NOT NULL AS used
       FROM transfer_codes WHERE code = $1 FOR UPDATE`,
      [code],
    );
    const row = rows[0];
    if (!row || row.used || row.expired) {
      throw new GameError("bad_code", "That code isn't valid any more. Make a new one on your other device.", 400);
    }
    const target = row.player_id;
    await client.query("UPDATE transfer_codes SET used_at = now() WHERE code = $1", [code]);
    let mergedDays = 0;
    if (currentPlayer && currentPlayer !== target) {
      mergedDays = (await mergeInto(client, currentPlayer, target)).length;
      // anything left (days both played) goes with the old device's player
      await client.query("DELETE FROM players WHERE id = $1", [currentPlayer]);
    }
    await refreshPlayerStats(client, target, today);
    await client.query("COMMIT");
    return { playerId: target, mergedDays };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** "Delete my data": the player row and everything that cascades from it. */
export async function deletePlayer(db: Pool, playerId: string): Promise<void> {
  await db.query("DELETE FROM players WHERE id = $1", [playerId]);
}
