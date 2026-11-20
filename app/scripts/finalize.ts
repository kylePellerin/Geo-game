/**
 * Nightly job (PLAN.md §6): finalise a finished day's scores.
 *   npm run finalize            # yesterday (UTC)
 *   npm run finalize -- 2026-11-21
 * Run it shortly after 00:00 UTC (cron / scheduled function). Idempotent.
 */
import { closePool, getPool } from "../lib/db";
import { finalizeDay } from "../lib/game/finalize";
import { utcToday } from "../lib/game/puzzle";

const today = utcToday();
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const date = process.argv[2] ?? yesterday;
if (date >= today) {
  console.error(`refusing to finalise ${date}: the day isn't over (today is ${today} UTC)`);
  process.exit(1);
}
finalizeDay(getPool(), date, today)
  .then((r) => console.log(`finalised ${r.date}: ${r.answersFinalized} answers, ${r.players} players`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closePool);
