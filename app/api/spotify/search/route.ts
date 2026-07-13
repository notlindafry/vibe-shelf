import { NextResponse, type NextRequest } from "next/server";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { HttpError } from "@/lib/http";
import { isSpotifyConfigured, searchAlbums } from "@/lib/spotify";
import type { SpotifySearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One token fetch (at most) plus one search; give headroom over the default.
export const maxDuration = 15;

const MAX_QUERY_LEN = 200;

/**
 * GET /api/spotify/search?q=... — album search for the maybe-vibes add flow.
 *
 * Any authenticated session may search (owner or guest); the proxy already
 * required a valid session. Rate-limited per IP. All Spotify calls happen
 * server-side, so the client secret never reaches the browser. Spotify's own
 * 429/Retry-After is surfaced as a generic "busy, try again" message; no upstream
 * error body is ever leaked (rule 8). Fails closed (503) when Spotify is not
 * configured.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  if (!isSpotifyConfigured()) {
    return NextResponse.json({ error: "Spotify search is not configured" }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "spotify-search", limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LEN);
  if (!q) {
    return NextResponse.json({ albums: [] } satisfies SpotifySearchResponse);
  }

  try {
    const albums = await searchAlbums(q);
    return NextResponse.json({ albums } satisfies SpotifySearchResponse);
  } catch (err) {
    // Honor Spotify's rate limit if that's what we hit.
    if (err instanceof HttpError && err.status === 429) {
      return NextResponse.json(
        { error: "Spotify is busy. Try again in a moment." },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSeconds ?? 5) } },
      );
    }
    console.error("[spotify search] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not search Spotify." }, { status: 502 });
  }
}
