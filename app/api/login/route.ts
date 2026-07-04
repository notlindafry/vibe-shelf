import { NextResponse, type NextRequest } from "next/server";
import {
  checkPassword,
  createSessionToken,
  isAuthConfigured,
  sessionCookieOptions,
} from "@/lib/auth";
import { checkRateLimit, clientIpFromHeaders, sweepExpired } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * POST /api/login  { password: string }
 *
 * Per-IP rate limited to ~5 attempts/minute with lockout (rule 3). Returns a
 * generic error on failure so we never reveal which password matched (rule 8).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  if (!isAuthConfigured()) {
    // Fail closed if the app isn't configured with a password + session secret.
    return NextResponse.json({ error: "Authentication is not configured" }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const limit = checkRateLimit(ip, { namespace: "login", limit: 5, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let password: unknown;
  try {
    const body = (await request.json()) as { password?: unknown };
    password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof password !== "string" || password.length === 0 || password.length > 200) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const role = checkPassword(password);
  if (!role) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const token = await createSessionToken(role);
  const response = NextResponse.json({ ok: true, role });
  response.cookies.set({ ...sessionCookieOptions(), value: token });
  return response;
}
