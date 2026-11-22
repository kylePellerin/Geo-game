"use client";
/**
 * A day's leaderboard: the top players (generated travel names, no personal data) and your own
 * rank if you finished. Points are estimates until the nightly job settles them.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { LeaderboardResponse } from "@/lib/client/types";

export function Leaderboard({ date, limit = 10, title = "Today's top players", refreshKey }: {
  date: string; limit?: number; title?: string; refreshKey?: unknown;
}) {
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    setError(false);
    api<LeaderboardResponse>(`/api/leaderboard/${date}`).then(
      (b) => { if (live) setBoard(b); },
      () => { if (live) setError(true); },
    );
    return () => { live = false; };
  }, [date, refreshKey]);

  if (error) return null;
  if (!board) return <div className="leaderboard"><div className="skeleton" style={{ width: "60%" }} /></div>;
  const top = board.top.slice(0, limit);
  const youShown = top.some((r) => r.you);
  return (
    <section className="leaderboard" aria-label={title}>
      <h3 className="kicker">{title}</h3>
      {board.players === 0 ? (
        <p className="hint">Nobody has finished this day yet.</p>
      ) : (
        <ol className="board">
          {top.map((r, i) => (
            <li key={`${r.rank}-${r.name}-${i}`} data-you={r.you || undefined} data-podium={r.rank <= 3 ? r.rank : undefined}>
              <span className="rank">{r.rank}</span>
              <span className="who">{r.name}{r.you && <b> (you)</b>}</span>
              <span className="pts">{r.points}</span>
            </li>
          ))}
          {board.you && !youShown && (
            <li data-you className="board-you">
              <span className="rank">{board.you.rank}</span>
              <span className="who">{board.you.name} <b>(you)</b></span>
              <span className="pts">{board.you.points}</span>
            </li>
          )}
        </ol>
      )}
      <p className="fine">
        {board.players} player{board.players === 1 ? "" : "s"} finished
        {board.final ? "." : " · points settle overnight."}
      </p>
    </section>
  );
}
