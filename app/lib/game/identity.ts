/**
 * Anonymous player identity (PLAN.md §10).
 * - player_id: random UUID in an httpOnly, SameSite=Lax cookie (Secure in production), 2 years.
 * - The client mirrors it in localStorage; POST /api/identity/reconcile repairs a lost cookie or
 *   local copy. It never silently creates a second player while either id still exists.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const PLAYER_COOKIE = "gr_pid";
export const COOKIE_MAX_AGE = 2 * 365 * 24 * 3600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);

export const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: COOKIE_MAX_AGE,
};

/** The player for a cookie value: reuses a known id, otherwise creates a player. */
export async function ensurePlayer(db: Pool, cookieId: string | undefined): Promise<{ id: string; created: boolean }> {
  if (isUuid(cookieId)) {
    // also accepts an id the DB doesn't know (e.g. after a dev reset): keep the player's id
    const r = await db.query(
      `INSERT INTO players (id) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now() RETURNING (xmax = 0) AS created`,
      [cookieId],
    );
    return { id: cookieId, created: Boolean(r.rows[0]?.created) };
  }
  const id = randomUUID();
  await db.query("INSERT INTO players (id) VALUES ($1)", [id]);
  return { id, created: true };
}

async function answerCount(db: Pool, id: string): Promise<number | null> {
  const { rows } = await db.query<{ exists: boolean; n: string }>(
    `SELECT EXISTS (SELECT 1 FROM players WHERE id = $1) AS exists,
            (SELECT count(*) FROM answers WHERE player_id = $1) AS n`,
    [id],
  );
  return rows[0].exists ? Number(rows[0].n) : null;
}

/**
 * Cookie and localStorage disagree (or one is missing): keep the id with history.
 * Returns the id both should be set to.
 */
export async function reconcile(db: Pool, cookieId: unknown, localId: unknown): Promise<string> {
  const cookie = isUuid(cookieId) ? cookieId : null;
  const local = isUuid(localId) ? localId : null;
  const cn = cookie ? await answerCount(db, cookie) : null;
  const ln = local && local !== cookie ? await answerCount(db, local) : null;
  if (cookie && cn !== null && (ln === null || cn >= ln)) return cookie;
  if (local && ln !== null) return local;
  return (await ensurePlayer(db, cookie ?? undefined)).id;
}
