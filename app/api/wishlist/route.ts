import { NextResponse, type NextRequest } from "next/server";
import { getRole, isSameOrigin } from "@/lib/request";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import {
  addWishlistEntry,
  isWishlistConfigured,
  listWishlist,
  removeWishlistEntry,
  setWishlistStatus,
} from "@/lib/wishlist";
import type { WishlistResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Config + rate-limit guard shared by every method. The wishlist fails CLOSED when
 * Redis is unconfigured (503): losing writes silently is worse than being briefly
 * unavailable. Returns a response to short-circuit, or null to proceed.
 */
async function baseGuard(
  request: NextRequest,
  namespace: string,
  limit: number,
): Promise<NextResponse | null> {
  if (!isWishlistConfigured()) {
    return NextResponse.json({ error: "The wishlist is not configured" }, { status: 503 });
  }
  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace, limit, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }
  return null;
}

/**
 * Write guard: base guard, then same-origin (CSRF defense alongside SameSite=Lax),
 * then owner-only (deny by default). Guests can read the wishlist but never mutate
 * it; the role is read server-side from the session, never from the client.
 */
async function writeGuard(request: NextRequest): Promise<NextResponse | null> {
  const blocked = await baseGuard(request, "wishlist-write", 30);
  if (blocked) return blocked;
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const role = await getRole(request);
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/** GET /api/wishlist — the full shared list. Owner or guest. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await baseGuard(request, "wishlist-read", 60);
  if (blocked) return blocked;
  try {
    return NextResponse.json({ entries: await listWishlist() } satisfies WishlistResponse);
  } catch (err) {
    console.error("[wishlist GET] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the wishlist." }, { status: 502 });
  }
}

/**
 * POST /api/wishlist — add an album with a chosen status. Owner only. Body is the
 * album fields plus `status`. On duplicate, returns the existing entry (200) so the
 * UI can point to it instead of creating a copy.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await writeGuard(request);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const outcome = await addWishlistEntry(body);
    if (outcome.result === "invalid") {
      return NextResponse.json({ error: "Invalid album" }, { status: 400 });
    }
    if (outcome.result === "full") {
      return NextResponse.json({ error: "The wishlist is full." }, { status: 409 });
    }
    if (outcome.result === "duplicate") {
      return NextResponse.json({ ok: true, duplicate: true, entry: outcome.entry });
    }
    return NextResponse.json({ ok: true, entry: outcome.entry }, { status: 201 });
  } catch (err) {
    console.error("[wishlist POST] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not add to the wishlist." }, { status: 502 });
  }
}

/**
 * PATCH /api/wishlist — change an entry's status. Owner only. Body `{ id, status }`.
 */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await writeGuard(request);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const fields = (body as { id?: unknown; status?: unknown }) ?? {};
  const id = typeof fields.id === "string" ? fields.id : "";
  if (fields.status !== "unvetted" && fields.status !== "vetted") {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }
  if (!id) {
    return NextResponse.json({ error: "Invalid album" }, { status: 400 });
  }

  try {
    const ok = await setWishlistStatus(id, fields.status);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[wishlist PATCH] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not update the entry." }, { status: 502 });
  }
}

/** DELETE /api/wishlist?id=... — remove an entry. Owner only, id validated. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  sweepExpired();
  const blocked = await writeGuard(request);
  if (blocked) return blocked;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const removed = await removeWishlistEntry(id);
    if (!removed) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[wishlist DELETE] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not remove the entry." }, { status: 502 });
  }
}
