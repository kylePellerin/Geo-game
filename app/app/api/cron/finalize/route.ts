/**
 * GET /api/cron/finalize → finalise yesterday's scores (the nightly job, PLAN.md §6).
 * Called by Vercel Cron (vercel.json) with `Authorization: Bearer $CRON_SECRET`; refuses without
 * it. Idempotent, so a retry is harmless. Locally: `make finalize`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { finalizeDay } from "@/lib/game/finalize";
import { errorResponse } from "@/lib/game/http";
import { utcToday } from "@/lib/game/puzzle";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden", message: "Not allowed" }, { status: 403 });
  }
  try {
    const today = utcToday();
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const r = await finalizeDay(getPool(), date, today);
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
