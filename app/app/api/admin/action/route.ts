/**
 * POST /api/admin/action { action, ... } — admin actions:
 *   review   { date, reviewed }        mark a puzzle reviewed / unreviewed
 *   replace  { date, idx }             regenerate one question (pipeline)
 *   generate { date }                  auto-fill a day (pipeline), keeping hand-written questions
 *   day      { date }                  everything about one day (day editor)
 *   calendar { from?, days? }          days with question counts
 *   save     { date, idx, question }   write a question by hand (see CustomQuestion)
 *   text     { date, idx, text }       fix a question's wording
 *   clear    { date, idx }             empty a slot
 *   search   { type, q }               find entities (type "" = any)
 *   resolve  { type, lines }           pasted names → entities
 *   where    { type, continent?, country_id?, kind? }   all entities matching
 *   alias    { entity_id, alias }      add a manual alias
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import {
  ADMIN_COOKIE, addAlias, adminAllowed, calendar, clearSlot, dayDetail, editText, entitiesWhere,
  generateDay, replaceQuestion, resolveNames, saveCustom, searchEntities, setReviewed,
  type CustomQuestion,
} from "@/lib/game/admin";
import { gameToday, isIsoDate } from "@/lib/game/http";

export const dynamic = "force-dynamic";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export async function POST(req: NextRequest) {
  if (!adminAllowed(req.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = getPool();
  const today = gameToday();
  const date = () => {
    if (typeof b.date !== "string" || !isIsoDate(b.date)) throw new Error("bad date");
    return b.date;
  };
  const idx = () => {
    if (!Number.isInteger(b.idx)) throw new Error("bad slot");
    return b.idx as number;
  };
  try {
    switch (b.action) {
      case "review":
        await setReviewed(db, date(), b.reviewed !== false);
        return NextResponse.json({ ok: true });
      case "replace":
        return NextResponse.json(await replaceQuestion(date(), idx()));
      case "generate":
        return NextResponse.json(await generateDay(db, date(), today));
      case "day":
        return NextResponse.json({ ok: true, today, ...(await dayDetail(db, date())) });
      case "calendar":
        return NextResponse.json(await calendar(db, str(b.from) && isIsoDate(b.from as string) ? b.from as string : today,
                                                Math.min(90, Number(b.days) || 35)));
      case "save":
        await saveCustom(db, date(), idx(), b.question as CustomQuestion, today);
        return NextResponse.json({ ok: true });
      case "text":
        await editText(db, date(), idx(), String(b.text ?? ""), today);
        return NextResponse.json({ ok: true });
      case "clear":
        await clearSlot(db, date(), idx(), today);
        return NextResponse.json({ ok: true });
      case "search":
        return NextResponse.json(await searchEntities(db, String(b.type ?? ""), String(b.q ?? "")));
      case "resolve":
        return NextResponse.json(await resolveNames(db, String(b.type ?? ""),
          Array.isArray(b.lines) ? b.lines.map(String) : []));
      case "where":
        return NextResponse.json(await entitiesWhere(db, String(b.type ?? ""), {
          continent: str(b.continent), countryId: str(b.country_id), kind: str(b.kind),
        }));
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
