"use client";
/**
 * Your stats (PLAN.md §10): games, streaks, best and average score, a score histogram, 100-point
 * answers, rarest answer ever, best and worst question family, today's percentile. Plus the
 * daily leaderboard, moving to another device (transfer code + QR) and deleting your data.
 */
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { formatShare } from "@/lib/client/state";
import type { StatsResponse } from "@/lib/client/types";
import { Leaderboard } from "./Leaderboard";
import { Shell } from "./Shell";

const LOCAL_ID_KEY = "gr_pid";

function prettyDate(d: string | null): string {
  if (!d) return "";
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function StatsPage() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<"today" | "yesterday">("today");

  useEffect(() => {
    api<StatsResponse>("/api/stats").then(setData, (e: Error) => setError(e.message));
  }, []);

  const s = data?.stats;
  const maxBar = Math.max(1, ...(s?.histogram.map((h) => h.n) ?? [1]));
  return (
    <Shell here="stats">
      <section className="card stats" aria-labelledby="stats-title">
        <div className="kicker">Explorer&apos;s logbook</div>
        <h2 id="stats-title" className="stats-title">{data ? data.name : "Your stats"}</h2>
        {error && <p className="note">{error}</p>}
        {!data && !error && <div className="skeleton" style={{ width: "70%", height: "2rem" }} />}
        {data && !s && (
          <p>No finished days yet. Play <Link href="/">today&apos;s puzzle</Link> to start your logbook.</p>
        )}
        {s && (
          <>
            <div className="stat-grid">
              <Stat n={s.gamesPlayed} label="days played" />
              <Stat n={s.currentStreak} label="day streak" hot={s.currentStreak >= 3} />
              <Stat n={s.maxStreak} label="best streak" />
              <Stat n={s.bestScore ?? 0} label={`best score${s.bestScoreDate ? ` · ${prettyDate(s.bestScoreDate)}` : ""}`} />
              <Stat n={s.average} label="average" />
              <Stat n={s.hundredPointAnswers} label="100-point answers" />
            </div>
            {s.todayPercentile !== null && (
              <p className="stats-line">Today you beat <b>{s.todayPercentile}%</b> of players.</p>
            )}
            {s.rarestAnswer && (
              <p className="stats-line">
                Rarest answer ever: <b>{s.rarestAnswer.name}</b>, given by {formatShare(s.rarestAnswer.share)} of
                players{s.rarestAnswer.date ? ` (${prettyDate(s.rarestAnswer.date)})` : ""}.
              </p>
            )}
            {(s.bestFamily || s.worstFamily) && (
              <p className="stats-line">
                {s.bestFamily && <>Strongest: <b>{s.bestFamily.family}</b> ({s.bestFamily.avg} avg)</>}
                {s.bestFamily && s.worstFamily && " · "}
                {s.worstFamily && <>Weakest: <b>{s.worstFamily.family}</b> ({s.worstFamily.avg} avg)</>}
              </p>
            )}
            <h3 className="kicker" style={{ marginTop: "1.4rem" }}>Scores</h3>
            <div className="histogram" role="img"
                 aria-label={s.histogram.map((h) => `${h.from}-${h.from + 99}: ${h.n}`).join(", ")}>
              {s.histogram.map((h) => (
                <div key={h.from} className="hbar">
                  <i style={{ height: h.n ? `${Math.max(8, (h.n / maxBar) * 100)}%` : "3px" }} />
                  <span className="hn">{h.n}</span>
                  <span className="hl">{h.from}+</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="seg" role="tablist" aria-label="Leaderboard day">
          {(["today", "yesterday"] as const).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={day === d} onClick={() => setDay(d)}>
              {d === "today" ? "Today" : "Yesterday"}
            </button>
          ))}
        </div>
        <Leaderboard date={day} limit={20}
                     title={day === "today" ? "Today's top players" : "Yesterday's top players"} />
      </section>

      <Transfer />
      <DeleteData />
    </Shell>
  );
}

function Stat({ n, label, hot }: { n: number; label: string; hot?: boolean }) {
  return (
    <div className="stat" data-hot={hot || undefined}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function Transfer() {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [qr, setQr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const c = await api<{ code: string; expiresAt: string }>("/api/identity/transfer", {});
      setCode(c);
      const url = `${window.location.origin}/claim?code=${c.code}`;
      setQr(await QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#1a1430", light: "#fff8e6" } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card transfer" aria-labelledby="transfer-title">
      <h3 id="transfer-title" className="kicker">Play on another device</h3>
      <p>Your progress lives in this browser. To carry it to a phone or another computer, make a code
        and enter it there (or scan the QR code). It works once, for 24 hours.</p>
      {!code && (
        <div className="btn-row">
          <button type="button" className="btn" onClick={make} disabled={busy}>{busy ? "Making a code…" : "Make a code"}</button>
          <Link href="/claim" className="btn btn-ghost">I have a code</Link>
        </div>
      )}
      {code && (
        <div className="code-box">
          <div className="code" aria-label={`Code ${code.code.split("").join(" ")}`}>
            {code.code.slice(0, 4)}-{code.code.slice(4)}
          </div>
          {/* the QR is generated locally from our own URL */}
          <div className="qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="fine">Valid until {new Date(code.expiresAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.</p>
        </div>
      )}
      {error && <p className="note">{error}</p>}
    </section>
  );
}

function DeleteData() {
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState(false);

  async function remove() {
    await api("/api/identity/delete", {});
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k === LOCAL_ID_KEY || k?.startsWith("gr_")) localStorage.removeItem(k);
      }
    } catch { /* storage blocked */ }
    setDone(true);
  }

  return (
    <section className="card danger" aria-labelledby="delete-title">
      <h3 id="delete-title" className="kicker">Your data</h3>
      <p>We keep no personal details: just a random id in a cookie, your answers and your stats.
        See the <Link href="/privacy">privacy note</Link>.</p>
      {done ? (
        <p><b>Deleted.</b> Everything tied to this browser is gone. <Link href="/">Start fresh</Link>.</p>
      ) : !sure ? (
        <button type="button" className="btn btn-ghost" onClick={() => setSure(true)}>Delete my data</button>
      ) : (
        <div className="btn-row">
          <span>This removes your answers, stats and streak for good.</span>
          <button type="button" className="btn" onClick={remove}>Yes, delete everything</button>
          <button type="button" className="btn btn-ghost" onClick={() => setSure(false)}>Keep it</button>
        </div>
      )}
    </section>
  );
}
