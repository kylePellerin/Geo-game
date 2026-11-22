import type { Metadata } from "next";
import Link from "next/link";
import { Backdrop } from "../_components/Backdrop";
import { Shell } from "../_components/Shell";

export const metadata: Metadata = { title: "Privacy · Geo-rarity" };

export default function Page() {
  return (
    <>
      <Backdrop />
      <Shell>
        <section className="card prose" aria-labelledby="privacy-title">
          <div className="kicker">Privacy</div>
          <h2 id="privacy-title" className="stats-title">What we keep</h2>
          <p>You can play without an account, and we don&apos;t ask for your name or email.</p>
          <ul>
            <li><b>A random id</b> in a cookie (and a copy in your browser&apos;s storage), so we know your answers
              are yours. It isn&apos;t linked to anything about you.</li>
            <li><b>Your answers</b> and when you gave them, to score them against everyone else&apos;s and to work
              out your stats and streak.</li>
            <li><b>Totals</b> of how many players gave each answer. These have no ids in them.</li>
          </ul>
          <p>On leaderboards you appear under a made-up name (like &ldquo;Brave Albatross 42&rdquo;) worked out
            from that random id.</p>
          <p>We don&apos;t use advertising or tracking cookies, and we don&apos;t sell or share your data.
            Your IP address is used to stop people flooding the game. It isn&apos;t stored with your answers;
            if you use a transfer code it&apos;s kept for up to a day to stop code guessing.</p>
          <p><b>Delete everything:</b> go to <Link href="/stats">Your stats</Link> and use &ldquo;Delete my data&rdquo;.
            Your answers, stats and streak are removed for good; only the anonymous totals stay.</p>
          <p className="fine">The game is built on open data: see the <Link href="/credits">credits</Link>.</p>
        </section>
      </Shell>
    </>
  );
}
