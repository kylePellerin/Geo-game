"use client";
/** End of the day: per-question summary, percentile and the share text. */
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { formatShare, TIER_LABEL, untilNextPuzzle } from "@/lib/client/state";
import type { DayResults } from "@/lib/client/types";

export function EndScreen({ date, prefetched, remaining, onResume }: {
  date: string; prefetched: DayResults | null; remaining: number; onResume: () => void;
}) {
  const [res, setRes] = useState<DayResults | null>(prefetched);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (prefetched && prefetched.finished === (remaining === 0)) {
      setRes(prefetched);
      return;
    }
    api<DayResults>(`/api/results/${date}`).then(setRes, (e: Error) => setError(e.message));
  }, [date, remaining, prefetched]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function copy() {
    if (!res) return;
    try {
      await navigator.clipboard.writeText(res.shareText);
      setCopied(true);
    } catch {
      setError("Couldn't copy; select the text above instead.");
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (!res) return <p>Loading results…</p>;

  return (
    <section>
      <h2>{res.finished ? "Today's results" : "Results so far"}</h2>
      {!res.finished && (
        <p>
          {remaining} question{remaining === 1 ? "" : "s"} left.{" "}
          <button type="button" onClick={onResume}>Keep playing</button>
        </p>
      )}
      <table>
        <thead><tr><th>#</th><th>Question</th><th>Your answers</th><th>Points</th></tr></thead>
        <tbody>
          {res.questions.map((q, i) => (
            <tr key={q.idx}>
              <td>{i + 1}</td>
              <td>{q.text ?? "—"}</td>
              <td>
                {q.state === "not_started" ? "—"
                  : q.pairCount !== undefined ? `${q.correctPairs ?? 0}/${q.pairCount} right`
                  : q.answers.length === 0 ? "none"
                  : q.answers.map((a, j) => (
                    <span key={j}>
                      {j > 0 && ", "}
                      {a.status === "valid"
                        ? `${a.name} (${a.tier ? TIER_LABEL[a.tier] : ""}${a.share !== undefined ? `, ${formatShare(a.share)}` : ""})`
                        : <s>{a.name}</s>}
                    </span>
                  ))}
              </td>
              <td>{q.points}{q.finalPoints !== undefined && q.finalPoints !== q.points ? ` → ${q.finalPoints}` : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td /><td><strong>Total</strong></td><td />
            <td><strong>{res.total}</strong>{res.finalTotal !== null && res.finalTotal !== res.total ? ` → ${res.finalTotal}` : ""}</td></tr>
        </tfoot>
      </table>
      {res.percentile !== null && <p>You scored better than {Math.round(res.percentile)}% of players today.</p>}
      {res.finished && (
        <>
          <pre>{res.shareText}</pre>
          <button type="button" onClick={copy}>{copied ? "Copied!" : "Copy result"}</button>
          <p>Next puzzle in {untilNextPuzzle(now)}.</p>
          <p><small>Points shown are estimates until tonight&apos;s update, when they settle on everyone&apos;s answers.</small></p>
        </>
      )}
    </section>
  );
}
