/** Rules in plain words, for people who aren't geography experts. */
import { MATCH_PAIR_POINTS, TIER_EMOJI, TIERS } from "@/lib/game/scoring";
import { formatShare } from "@/lib/client/state";

export function HowToPlay() {
  return (
    <details>
      <summary>How to play</summary>
      <p>
        Six geography questions a day, the same for everyone. Most have lots of right answers:
        any one counts, and <strong>the fewer players who think of your answer, the more points it
        scores</strong>. Spelling doesn&apos;t have to be perfect. You get one answer per question.
      </p>
      <ul>
        {TIERS.map((t, i) => (
          <li key={t.tier}>
            {TIER_EMOJI[t.tier]} {t.label}: {t.points} points
            {" "}({i === 0 ? `more than ${formatShare(t.above)}` : i === TIERS.length - 1
              ? `fewer than ${formatShare(TIERS[i - 1].above)}`
              : `${formatShare(t.above)}–${formatShare(TIERS[i - 1].above)}`} of players)
          </li>
        ))}
        <li>{TIER_EMOJI.wrong} Wrong: 0 points</li>
      </ul>
      <p>
        🧩 Matching rounds: pair up four items. Each correct pair scores {MATCH_PAIR_POINTS.famous}–
        {MATCH_PAIR_POINTS.rarest} points, more for less well-known items.
      </p>
      <p>
        Early in the day, points are estimated; they settle overnight once everyone has played.
      </p>
    </details>
  );
}
