import { NextResponse, type NextRequest } from "next/server";
import { getRole } from "@/lib/request";
import { checkRateLimit, clientIpFromHeaders, sweepExpired } from "@/lib/ratelimit";
import {
  addBookmark,
  isBookmarksConfigured,
  listBookmarks,
  removeBookmark,
} from "@/lib/bookmarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shared guards: config present, rate limit ok, and owner role. */
async function guard(
  request: NextRequest,
  namespace: string,
  limit: number,
): Promise<NextResponse | null> {
  if (!isBookmarksConfigured()) {
    // Fail closed if Upstash is not configured (rules 5 and 9).
    return NextResponse.json({ error: "Bookmarks are not configured" }, { status: 503 });
  }
  const ip = clientIpFromHeaders(request.headers);
  const rl = checkRateLimit(ip, { namespace, limit, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }
  const role = await getRole(request); // proxy already required a valid session
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 }); // deny by default
  }
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await guard(request, "bookmarks-read", 60);
  if (blocked) return blocked;
  try {
    return NextResponse.json({ bookmarks: await listBookmarks() });
  } catch (err) {
    console.error("[bookmarks GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load bookmarks." }, { status: 502 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await guard(request, "bookmarks-write", 30);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await addBookmark((body as { record?: unknown })?.record ?? body);
    if (result === "invalid") return NextResponse.json({ error: "Invalid record" }, { status: 400 });
    if (result === "full") {
      return NextResponse.json({ error: "Your saved list is full." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bookmarks POST] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not save the bookmark." }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await guard(request, "bookmarks-write", 30);
  if (blocked) return blocked;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const removed = await removeBookmark(id);
    if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[bookmarks DELETE] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not remove the bookmark." }, { status: 502 });
  }
}
