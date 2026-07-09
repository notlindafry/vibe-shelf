import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { getCollection } from "@/lib/discogs";
import { HttpError, sleep } from "@/lib/http";
import {
  bumpLastfmVersion,
  fetchArtistTags,
  fetchSimilarArtists,
  hydratedArtistKeys,
  isLastfmConfigured,
  normArtist,
  storeArtist,
  type ArtistData,
} from "@/lib/lastfm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Two Last.fm calls per artist, paced under the rate limit — keep the batch small
// enough to finish within the function budget; the next run continues where this
// one stopped.
export const maxDuration = 60;

// Two calls per artist. At ~2 artists/sec (below Last.fm's ~5 req/s per-IP limit)
// a batch of 25 is ~50 calls ≈ 18s, comfortably inside maxDuration.
const BATCH_SIZE = 25;
// Delay before each Last.fm call so peak request rate stays well under the limit.
const CALL_DELAY_MS = 350;

/** The primary artist of a (possibly multi-artist) record, normalized; "" to skip. */
function primaryArtistKey(artist: string): string {
  // Discogs joins multiple artists with ", " — take the primary for v1.
  const primary = artist.split(",")[0] ?? "";
  const key = normArtist(primary);
  if (!key || key === "various" || key === "various artists") return "";
  return key;
}

/**
 * GET /api/cron/hydrate-lastfm
 *
 * Backfills Last.fm similar-artists + top-tags into Redis a bounded batch at a
 * time (mirrors hydrate-tracks). Guarded by the cron secret. Idempotent and
 * resumable: it hydrates only artists not already stored, so repeated runs march
 * through the collection and then just pick up new artists.
 *
 * Fails open: with no API key (or no Redis) there is nothing to do, so the app
 * keeps using style-based similarity and the Claude-plus-heuristic mood path.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isLastfmConfigured()) {
    return NextResponse.json({ ok: true, skipped: "LASTFM_API_KEY not configured" });
  }

  try {
    const { records } = await getCollection();

    // Distinct normalized artists across the collection (primary artist only).
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      const key = primaryArtistKey(r.artist);
      if (key && !seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }

    const hydrated = await hydratedArtistKeys();
    const pending = keys.filter((k) => !hydrated.has(k));
    const batch = pending.slice(0, BATCH_SIZE);

    let done = 0;
    let rateLimited = false;
    for (const key of batch) {
      try {
        await sleep(CALL_DELAY_MS);
        const similar = await fetchSimilarArtists(key);
        await sleep(CALL_DELAY_MS);
        const tags = await fetchArtistTags(key);

        const data: ArtistData = { similar, tags, fetchedAt: Date.now() };
        await storeArtist(key, data);
        done += 1;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // Artist not found on Last.fm — mark hydrated-empty so we stop retrying.
          await storeArtist(key, { similar: [], tags: [], fetchedAt: Date.now() });
          done += 1;
        } else if (err instanceof HttpError && err.status === 429) {
          // Rate limited — stop this run and let the window recover. Log the
          // artist and status only (never the URL: it carries the API key).
          console.warn(`[cron hydrate-lastfm] rate limited on "${key}"; stopping batch`);
          rateLimited = true;
          break;
        } else {
          // Transient (5xx/network) or a hard fault — leave it for a later run.
          console.error(
            `[cron hydrate-lastfm] "${key}" failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    // Bump the hydration version so the mood index recomputes with the new tags.
    if (done > 0) await bumpLastfmVersion();

    return NextResponse.json({
      ok: true,
      hydratedThisRun: done,
      rateLimited,
      remaining: Math.max(0, pending.length - done),
      total: keys.length,
    });
  } catch (err) {
    console.error("[cron hydrate-lastfm] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Hydration failed" }, { status: 502 });
  }
}
