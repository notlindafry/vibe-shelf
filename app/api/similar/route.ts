import { NextResponse, type NextRequest } from "next/server";
import { getCollection } from "@/lib/discogs";
import { getArtist, normArtist } from "@/lib/lastfm";
import { similarRecords } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/similar  { id: string, owner?: string }
 *
 * "More like this": similar-by-style/genre, widened by Last.fm sonic similarity
 * when the seed artist has been hydrated. `usedLastfm` tells the UI whether to
 * show the Last.fm attribution.
 */
async function buildSimilarArtistMap(seedArtist: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    // One Redis read; fails open to null when unconfigured / not hydrated.
    const entry = await getArtist(normArtist(seedArtist));
    if (entry) {
      for (const s of entry.similar) {
        const key = normArtist(s.name);
        if (!key) continue;
        map.set(key, Math.max(map.get(key) ?? 0, s.match));
      }
    }
  } catch (err) {
    // Style-based results still stand; log server-side and move on.
    console.error("[similar] Last.fm read failed:", err instanceof Error ? err.message : err);
  }
  return map;
}

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
    const similarArtists = await buildSimilarArtistMap(seed.artist);
    const results = similarRecords(seed, records, similarArtists);
    return NextResponse.json({ seed, results, usedLastfm: similarArtists.size > 0 });
  } catch (err) {
    console.error("[similar] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 502 },
    );
  }
}
