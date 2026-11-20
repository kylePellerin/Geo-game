/**
 * Nightly finalise job (PLAN.md §6): once a day is over, recompute every valid free-text answer's
 * share from that day's final counts (still blended with the prior, which matters only when few
 * people played), store final points next to the instant ones, total them in daily_scores and
 * refresh the stats of everyone who played. Instant points shown to players are never changed.
 * Idempotent: running it again gives the same result.
 */
import type { Pool } from "pg";
import { loadPuzzle } from "./puzzle";
import { scoreAnswer } from "./scoring";
import { refreshPlayerStats } from "./stats";

export async function finalizeDay(db: Pool, date: string, today: string) {
  const puzzle = await loadPuzzle(db, date);
  if (!puzzle) throw new Error(`no puzzle for ${date}`);
  const client = await db.connect();
  let updated = 0;
  try {
    await client.query("BEGIN");
    // the day is over: close every question still open (players who left mid-question)
    await client.query(
      "UPDATE question_plays SET ended_at = deadline WHERE date = $1 AND ended_at IS NULL", [date],
    );
    for (const q of puzzle.filter((x) => x.kind === "free_text")) {
      const total = Number((await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM answers WHERE date = $1 AND idx = $2", [date, q.idx],
      )).rows[0].n);
      const counts = (await client.query<{ entity_id: string; n: number }>(
        "SELECT entity_id, n FROM answer_counts WHERE date = $1 AND idx = $2", [date, q.idx],
      )).rows;
      for (const c of counts) {
        if (!q.validIds.includes(c.entity_id)) continue;
        const s = scoreAnswer(c.n, total, q.prior.get(c.entity_id) ?? 0);
        const res = await client.query(
          `UPDATE answers SET final_points = $1, final_tier = $2, final_share = $3
           WHERE date = $4 AND idx = $5 AND matched_entity_id = $6 AND status = 'valid'`,
          [s.points, s.tier, s.share, date, q.idx, c.entity_id],
        );
        updated += res.rowCount ?? 0;
      }
      await client.query(
        `UPDATE answers SET final_points = 0 WHERE date = $1 AND idx = $2 AND status <> 'valid'`,
        [date, q.idx],
      );
    }
    await client.query(
      `INSERT INTO daily_scores (date, player_id, instant_points, final_points, finished)
       SELECT $1, p.player_id,
              coalesce((SELECT sum(points) FROM answers a WHERE a.player_id = p.player_id AND a.date = $1), 0),
              coalesce((SELECT sum(coalesce(final_points, points)) FROM answers a
                        WHERE a.player_id = p.player_id AND a.date = $1), 0),
              count(*) >= $2
       FROM question_plays p WHERE p.date = $1 GROUP BY p.player_id
       ON CONFLICT (date, player_id) DO UPDATE SET instant_points = EXCLUDED.instant_points,
         final_points = EXCLUDED.final_points, finished = EXCLUDED.finished`,
      [date, puzzle.length],
    );
    const players = (await client.query<{ player_id: string }>(
      "SELECT DISTINCT player_id FROM question_plays WHERE date = $1", [date],
    )).rows;
    for (const p of players) await refreshPlayerStats(client, p.player_id, today);
    await client.query("COMMIT");
    return { date, answersFinalized: updated, players: players.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
