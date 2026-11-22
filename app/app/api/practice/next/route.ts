/**
 * GET /api/practice/next?kind=free_text|match|order&seen=1,2,3 → { question, seconds }
 * A random practice question (never scored), avoiding the ids already seen this session.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { errorResponse } from "@/lib/game/http";
import { nextPractice, type PracticeKind } from "@/lib/game/practice";

export const dynamic = "force-dynamic";
const KINDS = new Set(["free_text", "match", "order"]);

export async function GET(req: NextRequest) {
  try {
    const kind = req.nextUrl.searchParams.get("kind");
    const seen = (req.nextUrl.searchParams.get("seen") ?? "").split(",")
      .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(-500);
    const next = await nextPractice(getPool(), kind && KINDS.has(kind) ? kind as PracticeKind : null, seen);
    if (!next) return NextResponse.json({ error: "empty", message: "No practice questions yet" }, { status: 404 });
    return NextResponse.json(next);
  } catch (e) {
    return errorResponse(e);
  }
}
