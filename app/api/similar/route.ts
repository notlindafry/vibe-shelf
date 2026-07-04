import { NextResponse, type NextRequest } from "next/server";
import { getCollection } from "@/lib/discogs";
import { similarRecords } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/similar  { id: string, owner?: string }
 *
 * "More like this," recast as similar-by-style/genre.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let id: unknown;
  let owner: unknown;
  try {
    const body = (await request.json()) as { id?: unknown; owner?: unknown };
    id = body.id;
    owner = body.owner;
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof id !== "string" || !id) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const { records } = await getCollection();
    const seed =
      records.find((r) => r.id === id && (typeof owner !== "string" || r.owner === owner)) ??
      records.find((r) => r.id === id);
    if (!seed) {
      return NextResponse.json({ error: "Record not found" }, { status: 404 });
    }
    const results = similarRecords(seed, records);
    return NextResponse.json({ seed, results });
  } catch (err) {
    console.error("[similar] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 502 },
    );
  }
}
