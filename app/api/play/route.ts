import { NextResponse, type NextRequest } from "next/server";
import { getRole, isReleaseId, isSameOrigin } from "@/lib/request";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { isRedisConfigured } from "@/lib/redis";
import { getCollection } from "@/lib/discogs";
import { logPlay, mostPlayedIds, playCounts } from "@/lib/plays";
import type { PlayedRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MOST_PLAYED_LIMIT = 12;

/**
 * POST /api/play  { id }  — log a play. Owner only (deny by default), same-origin
 * only (CSRF), rate-limited, and the id must exist in the current collection so
 * arbitrary values cannot be written (rule 4).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Plays are not configured" }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "play-write", limit: 20, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // CSRF: this is a state-changing write, so require a same-origin request.
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const role = await getRole(request);
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const fields = (body as { id?: unknown; release_id?: unknown }) ?? {};
  const id = typeof fields.id === "string" ? fields.id : typeof fields.release_id === "string" ? fields.release_id : "";
  if (!isReleaseId(id)) {
    return NextResponse.json({ error: "Invalid record" }, { status: 400 });
  }

  try {
    const { records } = await getCollection();
    if (!records.some((r) => r.id === id)) {
      return NextResponse.json({ error: "Unknown record" }, { status: 404 });
    }
    const count = await logPlay(id);
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    console.error("[play POST] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not log the play." }, { status: 502 });
  }
}

/**
 * GET /api/play — play counts (id → count) plus the most-played records joined to
 * their metadata. Any authenticated session may read (the proxy already required
 * one); writes stay owner-only above.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Plays are not configured" }, { status: 503 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "play-read", limit: 60, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  try {
    const [counts, top, collection] = await Promise.all([
      playCounts(),
      mostPlayedIds(MOST_PLAYED_LIMIT),
      getCollection(),
    ]);
    const byId = new Map(collection.records.map((r) => [r.id, r] as const));
    const mostPlayed: PlayedRecord[] = [];
    for (const { id, count } of top) {
      const record = byId.get(id);
      if (record) mostPlayed.push({ record, count });
    }
    return NextResponse.json({ counts: Object.fromEntries(counts), mostPlayed });
  } catch (err) {
    console.error("[play GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load plays." }, { status: 502 });
  }
}
