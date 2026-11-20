/** GET /api/admin/login?token=... → sets the admin cookie and redirects to /admin. */
import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE } from "@/lib/game/admin";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const res = NextResponse.redirect(new URL("/admin", req.url));
  if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
    res.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}
