"use client";
/** Rules in plain words, for people who aren't geography experts. Opens as a sheet. */
import { useEffect } from "react";
import { formatShare } from "@/lib/client/state";
import { MATCH_PAIR_POINTS, ORDER_POINTS_PER_ITEM, TIERS } from "@/lib/game/scoring";

export function HowToPlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="card sheet" role="dialog" aria-modal="true" aria-labelledby="how-title"
           onClick={(e) => e.stopPropagation()}>
        <h2 id="how-title">How to play</h2>
        <ol>
          <li><b>Six questions a day</b>, the same for everyone, from easy to hard.</li>
          <li>Each one is <b>timed</b>: press Start when you&apos;re ready.</li>
          <li>Most questions have lots of right answers. <b>Give one.</b> If it&apos;s wrong, try again;
            your first right answer is the one that counts.</li>
          <li><b>The fewer players who think of your answer, the more it&apos;s worth.</b> Think past the obvious!</li>
          <li>Spelling doesn&apos;t have to be perfect: we&apos;ll ask &ldquo;did you mean…?&rdquo;.</li>
        </ol>
        <div className="tier-table">
          {TIERS.map((t, i) => (
            <div key={t.tier} style={{ display: "contents", "--tier": `var(--t-${t.tier})` } as React.CSSProperties}>
              <span className="dot" />
              <span>
                <b style={{ fontFamily: "var(--font-display)" }}>{t.label}</b>{" "}
                <small style={{ color: "var(--text-soft)" }}>
                  {i === 0 ? `more than ${formatShare(t.above)} of players`
                    : i === TIERS.length - 1 ? `fewer than ${formatShare(TIERS[i - 1].above)}`
                    : `${formatShare(t.above)}–${formatShare(TIERS[i - 1].above)}`}
                </small>
              </span>
              <b>{t.points}</b>
            </div>
          ))}
        </div>
        <p>
          <b>Matching round</b> (question 4): pair up three items. Each correct pair scores{" "}
          {MATCH_PAIR_POINTS.well_known}–{MATCH_PAIR_POINTS.rarest}, more for less well-known items.
        </p>
        <p><b>Ordering round</b> (some days): put five items in order, {ORDER_POINTS_PER_ITEM} points each in the right place.</p>
        <p className="fine">Points are estimates early in the day; they settle overnight once everyone has played.</p>
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-ink" onClick={onClose} autoFocus>Got it</button>
        </div>
      </div>
    </div>
  );
}
