"use client";
/**
 * End of the day, as a passport page: one stamp per question, the total, percentile and the share
 * text. Renders at once from the player's local cache (or from what the game screen already
 * knows) and refreshes from the server in the background.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { cachedResults, storeResults } from "@/lib/client/cache";
import { untilNextPuzzle } from "@/lib/client/state";
import type { DayResults } from "@/lib/client/types";
import Link from "next/link";
import { Atlas } from "./Atlas";
import { CountUp, roundTier, Stamp, tilt } from "./Bits";
import { Leaderboard } from "./Leaderboard";

type QResult = DayResults["questions"][number];

function QuestionStamp({ q }: { q: QResult }) {
  const rot = tilt(`${q.idx}-${q.text}`, 10);
  if (q.state === "not_started") return <Stamp tier="wrong" label="—" round rotate={rot} />;
  if (q.pairCount !== undefined) {
    const right = q.correctPairs ?? 0;
    const tier = roundTier(right, q.pairCount);
    return <Stamp tier={tier} label={`${right}/${q.pairCount}`} points={q.points} round rotate={rot} />;
  }
  const valid = q.answers.find((a) => a.status === "valid");
  return valid
    ? <Stamp tier={valid.tier} points={q.points} round rotate={rot} />
    : <Stamp tier="wrong" label="Missed" points="0" round rotate={rot} />;
}

export function EndScreen({ date, local, remaining, onResume }: {
  date: string; local: DayResults; remaining: number; onResume: () => void;
}) {
  const [res, setRes] = useState<DayResults>(() => {
    const cached = cachedResults(date);
    // a cached copy is good if it describes the same progress as now
    return cached && cached.finished === local.finished && cached.total === local.total ? cached : local;
  });
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    api<DayResults>(`/api/results/${date}`).then((r) => {
      if (!live) return;
      setRes(r);
      storeResults(date, r);
    }, () => { /* keep showing what we have */ });
    return () => { live = false; };
  }, [date, remaining]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(res.shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the text is on screen to select by hand */
    }
  }

  const finalChanged = res.finalTotal !== null && res.finalTotal !== res.total;
  return (
    <section className="card passport" aria-labelledby="results-title">
      <div className="passport-head">
        <div>
          <div className="kicker">Expedition log · {date}</div>
          <h2 id="results-title">{res.finished ? "Today's results" : "Results so far"}</h2>
        </div>
        <div className="total">
          <CountUp value={finalChanged ? res.finalTotal! : res.total} ms={750} />
          <small>points</small>
        </div>
      </div>

      {!res.finished && (
        <div className="btn-row">
          <span>{remaining} question{remaining === 1 ? "" : "s"} left.</span>
          <button type="button" className="btn btn-gold" onClick={onResume}>Keep playing</button>
        </div>
      )}

      <div className="stamp-grid">
        {res.questions.map((q, i) => {
          const valid = q.answers.find((a) => a.status === "valid");
          return (
            <div key={q.idx} className="stamp-cell" style={{ "--d": `${0.07 * i}s` } as React.CSSProperties}>
              <QuestionStamp q={q} />
              <div className="a">
                {q.state === "not_started" ? "Not played"
                  : q.pairCount !== undefined ? `${q.kind === "order" ? "Order" : "Matching"}`
                  : valid ? valid.name : "—"}
              </div>
              <div className="q">{q.text ?? `Question ${i + 1}`}</div>
            </div>
          );
        })}
      </div>

      {res.percentile !== null && (
        <div className="percentile">
          <div className="bar"><i style={{ width: `${Math.round(res.percentile)}%` }} /></div>
          <p>You scored better than <b>{Math.round(res.percentile)}%</b> of players today.</p>
        </div>
      )}

      {res.finished && (
        <>
          <Atlas />
          <Leaderboard date={date} limit={5} refreshKey={res.total} />
          <p className="fine" style={{ textAlign: "right" }}><Link href="/stats">Your stats, streak and full leaderboard →</Link></p>
          {res.shareText
            ? <pre className="telegram">{res.shareText}</pre>
            : <div className="telegram"><div className="skeleton" style={{ width: "60%" }} /></div>}
          <div className="btn-row">
            <button type="button" className="btn" onClick={copy} disabled={!res.shareText}>
              {copied ? "Copied!" : "Copy result"}
            </button>
          </div>
          <p className="next-in">Next puzzle in <b>{untilNextPuzzle(now)}</b></p>
          <p className="fine">
            {finalChanged
              ? <>Points settled overnight on everyone&apos;s answers: {res.total} → {res.finalTotal}.</>
              : <>Points are estimates until tonight&apos;s update, when they settle on everyone&apos;s answers.</>}
          </p>
        </>
      )}
    </section>
  );
}
