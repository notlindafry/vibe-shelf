import { NextResponse, type NextRequest } from "next/server";
import { getCollection } from "@/lib/discogs";
import { searchRecords } from "@/lib/search";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { parseStringArray } from "@/lib/request";
import type { SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/search
 * { query?: string, owners?: string[], genres?: string[], styles?: string[], moods?: string[] }
 *
 * The route is gated by middleware. It rate-limits per IP and returns a generic
 * error on any internal failure (rule 8) while logging detail server-side.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const limit = await enforceRateLimit(ip, { namespace: "search", limit: 30, windowMs: 60_000 });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many searches. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.slice(0, 300) : "";
  const owners = parseStringArray(body.owners);
  const genres = parseStringArray(body.genres);
  const styles = parseStringArray(body.styles);
  const moods = parseStringArray(body.moods);

  try {
    const { records, partial } = await getCollection();
    const outcome = await searchRecords(query, records, { owners, genres, styles, moods });
    const payload: SearchResponse = {
      results: outcome.results,
      spec: outcome.spec,
      reranked: outcome.reranked,
      partial,
      songMatch: outcome.songMatch,
    };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[search] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Something went wrong loading the catalogue. Please try again." },
      { status: 502 },
    );
  }
}
