import { NextResponse, type NextRequest } from "next/server";
import { isAuthorizedCron } from "@/lib/cron";
import { fetchReleaseTracks, getCollection } from "@/lib/discogs";
import { HttpError } from "@/lib/http";
import { hydratedIds, storeTracks } from "@/lib/tracks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One Discogs call per release, paced under the rate limit — keep the batch small
// enough to finish within the function budget; the next run continues where this
// one stopped.
export const maxDuration = 60;

const BATCH_SIZE = 20;

/**
 * GET /api/cron/hydrate-tracks
 *
 * Backfills release tracklists into Redis a bounded batch at a time (feature 5).
 * Guarded by the cron secret like the collection refresh. Idempotent and
 * resumable: it hydrates only ids not already stored, so repeated runs (cron or
 * manual) march through the collection and then just pick up new records.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { records } = await getCollection();
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const r of records) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        ids.push(r.id);
      }
    }

    const hydrated = await hydratedIds();
    const pending = ids.filter((id) => !hydrated.has(id));
    const batch = pending.slice(0, BATCH_SIZE);

    let done = 0;
    for (const id of batch) {
      try {
        const tracks = await fetchReleaseTracks(id);
        await storeTracks(id, tracks);
        done += 1;
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          // Release is gone/unavailable — mark it hydrated-empty so we stop retrying.
          await storeTracks(id, []);
          done += 1;
        } else {
          // Transient (429/5xx/network) — leave it for a later run.
          console.error(
            `[cron hydrate-tracks] ${id} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    return NextResponse.json({
      ok: true,
      hydratedThisRun: done,
      remaining: Math.max(0, pending.length - done),
      total: ids.length,
    });
  } catch (err) {
    console.error("[cron hydrate-tracks] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Hydration failed" }, { status: 502 });
  }
}
