/**
 * Admin (PLAN.md §8 Phase 6, extended 2026-11-20): plan upcoming days, write questions by hand,
 * replace generated ones, and turn unrecognised answers into aliases.
 */
import { cookies } from "next/headers";
import { getPool } from "@/lib/db";
import { ADMIN_COOKIE, adminAllowed, CONTINENTS, ENTITY_TYPES, unmatched } from "@/lib/game/admin";
import { gameToday } from "@/lib/game/http";
import { FAMILY_LABELS } from "@/lib/game/puzzle";
import { AdminApp } from "./AdminClient";
import "./admin.css";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!adminAllowed((await cookies()).get(ADMIN_COOKIE)?.value)) {
    return (
      <main className="admin">
        <h1>Admin</h1>
        <p>Not allowed. Log in with <code>/api/admin/login?token=…</code></p>
      </main>
    );
  }
  const um = await unmatched(getPool(), 100);
  return (
    <AdminApp today={gameToday()} unmatched={um} families={FAMILY_LABELS}
              types={[...ENTITY_TYPES]} continents={CONTINENTS} />
  );
}
