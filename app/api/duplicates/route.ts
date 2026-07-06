import { NextResponse, type NextRequest } from "next/server";
import { getRole } from "@/lib/request";
import { clientIpFromHeaders, enforceRateLimit, sweepExpired } from "@/lib/ratelimit";
import { getCollection } from "@/lib/discogs";
import { findDuplicates } from "@/lib/duplicates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/duplicates — a one-off scan for albums both partners own (same album,
 * any pressing). Owner only. Open it in the browser while logged in, or fetch it;
 * `report` is a readable summary, `duplicates` has the per-pressing detail.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  sweepExpired();

  const ip = clientIpFromHeaders(request.headers);
  const rl = await enforceRateLimit(ip, { namespace: "duplicates", limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const role = await getRole(request);
  if (role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { records, partial } = await getCollection();
    const duplicates = findDuplicates(records);
    const report = duplicates.map((d) => {
      const copies = d.copies
        .map((c) => `${c.owner}${c.year ? ` (${c.year})` : ""}`)
        .join(" · ");
      return `${d.artist} — ${d.title}  [${copies}]`;
    });
    return NextResponse.json({ count: duplicates.length, partial, report, duplicates });
  } catch (err) {
    console.error("[duplicates] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not scan for duplicates." }, { status: 502 });
  }
}
