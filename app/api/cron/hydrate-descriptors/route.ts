import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isAuthorizedCron } from "@/lib/cron";
import { getCollection } from "@/lib/discogs";
import {
  DESCRIPTOR_CHUNK_SIZE,
  DESCRIPTOR_VERSION,
  descriptorStatus,
  generateDescriptors,
  storeDescriptor,
} from "@/lib/descriptors";
import type { Record as ShelfRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A few Claude calls per run, paced to finish within the function budget; the
// next run continues where this one stopped.
export const maxDuration = 60;

// One Claude call per DESCRIPTOR_CHUNK_SIZE releases. Bound the per-run batch so
// a handful of chunks (plus their Redis writes) finish inside maxDuration.
const BATCH_SIZE = 100;

/**
 * GET /api/cron/hydrate-descriptors
 *
 * Backfills per-release descriptors into Redis a bounded batch at a time,
 * mirroring hydrate-tracks. Guarded by the cron secret. Idempotent and
 * resumable: it generates only ids without a current-version descriptor, so
 * repeated runs (cron or manual) march through the collection and then just
 * pick up new records or a DESCRIPTOR_VERSION bump.
 *
 * Fails open: with no ANTHROPIC_API_KEY there is nothing to generate, so it
 * no-ops and search keeps running on its tag-and-title behavior. A Claude
 * failure on a chunk is transient (there is no "not found" case, unlike a 404
 * on a tracklist), so those ids are simply left for the next run.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: true, skipped: "ANTHROPIC_API_KEY not configured" });
  }

  try {
    const { records } = await getCollection();

    // Distinct release ids (a descriptor is keyed by id — two owners of the same
    // release share one entry), each with a representative record for generation.
    const byId = new Map<string, ShelfRecord>();
    for (const r of records) if (!byId.has(r.id)) byId.set(r.id, r);
    const ids = [...byId.keys()];

    const current = await descriptorStatus();
    const pending = ids.filter((id) => !current.has(id));
    const batch = pending.slice(0, BATCH_SIZE).map((id) => byId.get(id)!);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let done = 0;
    for (let i = 0; i < batch.length; i += DESCRIPTOR_CHUNK_SIZE) {
      const chunk = batch.slice(i, i + DESCRIPTOR_CHUNK_SIZE);
      try {
        const generated = await generateDescriptors(client, chunk);
        for (const [id, text] of generated) {
          await storeDescriptor(id, { v: DESCRIPTOR_VERSION, text });
          done += 1;
        }
      } catch (err) {
        // Transient (rate limit / 5xx / network) — leave this chunk's ids pending.
        console.error(
          "[cron hydrate-descriptors] chunk failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      hydratedThisRun: done,
      remaining: Math.max(0, pending.length - done),
      total: ids.length,
    });
  } catch (err) {
    console.error("[cron hydrate-descriptors] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Hydration failed" }, { status: 502 });
  }
}
