import { NextResponse, type NextRequest } from "next/server";
import { getCollection } from "@/lib/discogs";
import { getMoodIndex } from "@/lib/moods";
import { parseStringArray } from "@/lib/request";
import type { Record as ShelfRecord, SearchResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/random  { owners?, genres?, styles?, moods? }
 *
 * "Surprise me / what should I play" — picks one random record, respecting any
 * active facets. Owner is a hard filter; genre/style/mood match is inclusive.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Empty/invalid body is fine — treat as "surprise me from everything".
  }

  const owners = new Set(parseStringArray(body.owners).map((s) => s.toLowerCase()));
  const genres = new Set(parseStringArray(body.genres).map((s) => s.toLowerCase()));
  const styles = new Set(parseStringArray(body.styles).map((s) => s.toLowerCase()));
  const moods = parseStringArray(body.moods).map((s) => s.toLowerCase());

  try {
    const { records } = await getCollection();
    // Moods are a hard AND filter via the per-record mood index; genre/style
    // remain an inclusive OR — consistent with /api/search.
    const moodIndex = moods.length > 0 ? await getMoodIndex(records) : null;
    const hasContent = genres.size > 0 || styles.size > 0;

    const pool = records.filter((record) => {
      if (owners.size > 0 && !owners.has(record.owner.toLowerCase())) return false;
      if (moodIndex && moods.length > 0) {
        const recMoods = moodIndex.get(record);
        if (!moods.every((m) => recMoods.has(m))) return false;
      }
      if (!hasContent) return true;
      const g = record.genres.some((x) => genres.has(x.toLowerCase()));
      const s = record.styles.some((x) => styles.has(x.toLowerCase()));
      return g || s;
    });

    if (pool.length === 0) {
      return NextResponse.json({ result: null });
    }

    const record = pool[Math.floor(Math.random() * pool.length)];
    const result: SearchResult = { record, reason: playReason(record) };
    return NextResponse.json({ result });
  } catch (err) {
    console.error("[random] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 502 },
    );
  }
}

function playReason(record: ShelfRecord): string {
  const tag = record.styles[0] ?? record.genres[0];
  return tag ? `Put this on — ${tag} from ${record.owner}'s shelf` : `Put this on — from ${record.owner}'s shelf`;
}
