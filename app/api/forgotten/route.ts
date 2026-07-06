import { NextResponse, type NextRequest } from "next/server";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { getForgottenPick } from "@/lib/forgotten";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The first request of the day may call Claude to write the blurb.
export const maxDuration = 30;

/**
 * GET /api/forgotten — the daily Forgotten Shelf pick (feature 4b). Any
 * authenticated session may read (the proxy already required one). Read-only, so
 * no RBAC-on-write or CSRF concern beyond the play log it reads. Degrades
 * gracefully: no Redis → no daily cache; no Anthropic key → record without blurb.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "forgotten", limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    // ?refresh=1 (the Refresh button) rolls a fresh pick instead of the cached one.
    const force = request.nextUrl.searchParams.get("refresh") === "1";
    const pick = await getForgottenPick({ force });
    return NextResponse.json({ pick });
  } catch (err) {
    console.error("[forgotten GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the forgotten shelf." }, { status: 502 });
  }
}
