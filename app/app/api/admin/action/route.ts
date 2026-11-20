/**
 * POST /api/admin/action { action, ... } — admin actions:
 *   review  { date, reviewed }      mark a puzzle reviewed / unreviewed
 *   replace { date, idx }           regenerate one question (pipeline)
 *   search  { type, q }             find entities to attach an alias to
 *   alias   { entity_id, alias }    add a manual alias
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import {
  ADMIN_COOKIE, addAlias, adminAllowed, replaceQuestion, searchEntities, setReviewed,
} from "@/lib/game/admin";
import { isIsoDate } from "@/lib/game/http";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!adminAllowed(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getPool();
  try {
    switch (b.action) {
      case "review":
        if (typeof b.date !== "string" || !isIsoDate(b.date)) throw new Error("bad date");
        await setReviewed(db, b.date, b.reviewed !== false);
        return NextResponse.json({ ok: true });
      case "replace":
        if (typeof b.date !== "string" || !isIsoDate(b.date) || !Number.isInteger(b.idx)) throw new Error("bad question");
        return NextResponse.json(await replaceQuestion(b.date, b.idx as number));
      case "search":
        return NextResponse.json(await searchEntities(db, String(b.type ?? ""), String(b.q ?? "")));
      case "alias":
        if (typeof b.entity_id !== "string" || typeof b.alias !== "string") throw new Error("bad alias");
        return NextResponse.json({ ok: true, alias_norm: await addAlias(db, b.entity_id, b.alias) });
      default:
        throw new Error("unknown action");
    }
  } catch (e) {
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 400 });
  }
}
