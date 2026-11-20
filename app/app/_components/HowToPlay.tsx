/** Rules in plain words, for people who aren't geography experts. */
import { MATCH_PAIR_POINTS, ORDER_POINTS_PER_ITEM, TIER_EMOJI, TIERS } from "@/lib/game/scoring";
import { formatShare } from "@/lib/client/state";

export function HowToPlay() {
  return (
    <details>
      <summary>How to play</summary>
      <p>
        Six geography questions a day, the same for everyone, from easy to hard. Each one is
        timed. Most have lots of right answers: <strong>give as many as you can before time runs
        out</strong>. Every right answer scores, and <strong>the fewer players who think of it, the
        more it&apos;s worth</strong> (points depend on what share of everyone&apos;s answers it is). Wrong answers cost nothing.
      </p>
      <p>Spelling doesn&apos;t have to be perfect: if we&apos;re not sure, we&apos;ll ask &quot;did you mean…?&quot;.</p>
      <ul>
        {TIERS.map((t, i) => (
          <li key={t.tier}>
            {TIER_EMOJI[t.tier]} {t.label}: {t.points} points
            {" "}({i === 0 ? `more than ${formatShare(t.above)}` : i === TIERS.length - 1
              ? `fewer than ${formatShare(TIERS[i - 1].above)}`
              : `${formatShare(t.above)}–${formatShare(TIERS[i - 1].above)}`} of all answers)
          </li>
        ))}
      </ul>
      <p>
        🧩 Matching round (question 4): pair up four items. Each correct pair scores{" "}
        {MATCH_PAIR_POINTS.well_known}–{MATCH_PAIR_POINTS.rarest} points, more for less well-known items.
      </p>
      <p>🔢 Ordering round (some days): put five items in order. {ORDER_POINTS_PER_ITEM} points for each one in the right place.</p>
      <p>Early in the day, points are estimates; they settle overnight once everyone has played.</p>
    </details>
  );
}
