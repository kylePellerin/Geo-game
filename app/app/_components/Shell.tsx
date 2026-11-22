/** The page frame: masthead, content and footer links. Shared by the game, practice and stats. */
import Link from "next/link";
import type { ReactNode } from "react";
import { CountUp, Globe } from "./Bits";

export function Shell({ children, onHelp, dateline, total, here }: {
  children: ReactNode; onHelp?: () => void;
  /** e.g. "No. 3 · Sun 22 Nov" + "daily puzzle" */
  dateline?: ReactNode; total?: number;
  /** which footer link is the current page */
  here?: "play" | "practice" | "stats";
}) {
  const link = (href: string, label: string, key: typeof here) =>
    key === here ? <span aria-current="page">{label}</span> : <Link href={href}>{label}</Link>;
  return (
    <main className="page">
      <header className="masthead">
        <h1 className="wordmark" aria-label="Geo-rarity">
          <Link href="/" className="wordmark-link"><Globe /><span className="geo">Geo</span><span className="rarity">rarity</span></Link>
        </h1>
        <div className="masthead-right">
          {dateline && <div className="dateline">{dateline}</div>}
          {total !== undefined && (
            <div className="scorebox" aria-label={`${total} points`}>
              <b><CountUp value={total} /></b><small>points</small>
            </div>
          )}
          {onHelp && <button type="button" className="icon-btn" onClick={onHelp} aria-label="How to play">?</button>}
        </div>
      </header>
      {children}
      <footer className="footer">
        <nav className="footer-nav" aria-label="Pages">
          {link("/", "Today's puzzle", "play")} · {link("/practice", "Practice", "practice")} ·{" "}
          {link("/stats", "Your stats", "stats")} · <Link href="/privacy">Privacy</Link> ·{" "}
          <Link href="/credits">Credits</Link>
        </nav>
        Same six questions for everyone, every day · new puzzle at 00:00 UTC
      </footer>
    </main>
  );
}
