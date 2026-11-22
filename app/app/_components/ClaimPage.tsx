"use client";
/**
 * Enter a transfer code from another device (or arrive here from its QR code). This browser
 * becomes that player; anything already played here is merged in (days the other device didn't
 * play move across).
 */
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { Shell } from "./Shell";

export function ClaimPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ merged: number } | null>(null);

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("code");
    if (c) setCode(c.toUpperCase());
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ player_id: string; merged_days: number }>("/api/identity/claim", { code });
      try { localStorage.setItem("gr_pid", r.player_id); } catch { /* storage blocked */ }
      setDone({ merged: r.merged_days });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <section className="card" aria-labelledby="claim-title">
        <div className="kicker">Moving devices</div>
        <h2 id="claim-title" className="stats-title">Enter your code</h2>
        {done ? (
          <>
            <p><b>All set.</b> This browser now has your streak and stats.
              {done.merged > 0 && <> We also kept {done.merged} day{done.merged === 1 ? "" : "s"} you&apos;d played here.</>}</p>
            <div className="btn-row">
              <Link href="/" className="btn">Play today&apos;s puzzle</Link>
              <Link href="/stats" className="btn btn-ghost">See your stats</Link>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <p>Make a code on your other device under <b>Your stats → Play on another device</b>.</p>
            <div className="answer-form">
              <input className="answer-input code-input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
                     placeholder="ABCD-EF23" aria-label="Transfer code" autoComplete="off" autoCapitalize="characters"
                     spellCheck={false} maxLength={12} />
              <button type="submit" className="btn" disabled={busy || code.replace(/[\s-]/g, "").length !== 8}>
                {busy ? "Checking…" : "Use code"}
              </button>
            </div>
            {error && <p className="note" role="alert">{error}</p>}
            <p className="fine">If you&apos;ve played here too, those days are kept unless both devices played the same day.</p>
          </form>
        )}
      </section>
    </Shell>
  );
}
