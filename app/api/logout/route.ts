import { NextResponse } from "next/server";
import { clearSessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

/** POST /api/logout — clears the session cookie. */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(clearSessionCookieOptions());
  return response;
}
