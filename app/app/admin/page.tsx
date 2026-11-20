/** Admin (PLAN.md §8 Phase 6): upcoming puzzles and unrecognised answers. Unstyled. */
import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import { ADMIN_COOKIE, adminAllowed, unmatched, upcoming } from "@/lib/game/admin";
import { gameToday } from "@/lib/game/http";
import { AdminActions, AliasForm } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!adminAllowed((await cookies()).get(ADMIN_COOKIE)?.value)) {
    return <main><h1>Admin</h1><p>Not allowed. Log in with /api/admin/login?token=…</p></main>;
  }
  const db = getPool();
  const today = gameToday();
  const [qs, um] = await Promise.all([upcoming(db, today, 14), unmatched(db, 100)]);
  const byDate = new Map<string, typeof qs>();
  for (const q of qs) byDate.set(q.date, [...(byDate.get(q.date) ?? []), q]);

  return (
    <main style={{ maxWidth: "60rem" }}>
      <h1>Admin</h1>
      <p><a href="#upcoming">Upcoming puzzles</a> · <a href="#unmatched">Unrecognised answers</a></p>

      <h2 id="upcoming">Upcoming puzzles (14 days)</h2>
      {[...byDate.entries()].map(([date, rows]) => (
        <section key={date}>
          <h3>
            {date}{date === today ? " (today)" : ""} · {rows[0].reviewed ? "✓ reviewed" : "not reviewed"}{" "}
            <AdminActions action={{ action: "review", date, reviewed: !rows[0].reviewed }}
                          label={rows[0].reviewed ? "Mark unreviewed" : "Mark reviewed"} />
          </h3>
          <ol start={0}>
            {rows.map((q) => (
              <li key={q.idx} value={q.idx + 1}>
                <strong>{q.text}</strong> <small>[{q.family} · {q.kind} · d{q.difficulty} · {q.nAnswers} answers]</small>
                <br /><small>{q.sample.join(", ")}</small>
                {q.played && <><br /><small>played: {JSON.stringify(q.played)}</small></>}
                {date > today && <> <AdminActions action={{ action: "replace", date, idx: q.idx }} label="Replace" /></>}
              </li>
            ))}
          </ol>
        </section>
      ))}

      <h2 id="unmatched">Unrecognised answers</h2>
      <p><small>Most frequent first. Add an alias so the matcher recognises the text next time.</small></p>
      <table>
        <thead><tr><th>n</th><th>Text</th><th>Question</th><th>Add alias</th></tr></thead>
        <tbody>
          {um.map((u) => (
            <tr key={`${u.date}-${u.idx}-${u.raw}`}>
              <td>{u.n}</td>
              <td>{u.raw}</td>
              <td><small>{u.date} #{u.idx + 1}: {u.question}</small></td>
              <td><AliasForm type={u.entityType} raw={u.raw} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
