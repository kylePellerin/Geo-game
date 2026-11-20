/** Rebuild player_stats for every player from `answers` (PLAN.md §10: stats are a cache). */
import { closePool, getPool } from "../lib/db";
import { utcToday } from "../lib/game/puzzle";
import { rebuildAllPlayerStats } from "../lib/game/stats";

rebuildAllPlayerStats(getPool(), utcToday())
  .then((n) => console.log(`rebuilt stats for ${n} players`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closePool);
