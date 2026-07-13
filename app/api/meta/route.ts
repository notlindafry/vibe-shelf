import { NextResponse, type NextRequest } from "next/server";
import { getCollection } from "@/lib/discogs";
import { aiSearchEnabled } from "@/lib/search";
import { MOODS, availableMoods, presentGenres, presentOwners, presentStyles } from "@/lib/vocab";
import { getRole } from "@/lib/request";
import { isWishlistConfigured } from "@/lib/wishlist";
import type { MetaResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/meta — facets (genres, styles, owners, moods) actually present in the
 * merged collection, plus feature flags for the UI.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const role = await getRole(request);

  try {
    const { records, partial } = await getCollection();
    const payload: MetaResponse = {
      genres: presentGenres(records),
      styles: presentStyles(records),
      owners: presentOwners(records),
      // With AI classification, moods can apply beyond a record's literal styles
      // (e.g. "party" for Andrew W.K.), so offer the full mood vocabulary. Without
      // an API key, fall back to moods that at least resolve to a present style.
      moods: aiSearchEnabled() ? MOODS : availableMoods(records),
      total: records.length,
      partial,
      features: {
        aiSearch: aiSearchEnabled(),
        similar: true,
        random: true,
        guest: role === "guest",
        wishlist: isWishlistConfigured(),
      },
    };
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[meta] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Something went wrong loading the catalogue. Please try again." },
      { status: 502 },
    );
  }
}
