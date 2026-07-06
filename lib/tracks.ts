/**
 * Release tracklist storage + deterministic song lookup (feature 5).
 *
 * Tracklists are hydrated in the background (see the hydrate-tracks cron) into a
 * single Redis hash so a song search is one read:
 *   - vs:release:tracks — hash. Field: release id. Value: Track[] (JSON). An empty
 *     array marks a release hydrated-but-empty (e.g. gone), so the backfill does
 *     not keep re-fetching it. The hash's field set doubles as the "hydrated" set.
 *
 * A tracklist is effectively immutable per pressing, so entries are long-lived.
 * All reads fail open to empty so search degrades to "nothing hydrated yet".
 */

import { isRedisConfigured, redis } from "@/lib/redis";
import type { Record as ShelfRecord, SearchResult, Track } from "@/lib/types";

const TRACKS_KEY = "vs:release:tracks";
const SONG_RESULT_LIMIT = 30;

function norm(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Store a release's tracklist. An empty array still marks the release hydrated. */
export async function storeTracks(id: string, tracks: Track[]): Promise<void> {
  await redis().hset(TRACKS_KEY, { [id]: tracks });
}

/** Release ids already hydrated (present as fields). Empty when unconfigured. */
export async function hydratedIds(): Promise<Set<string>> {
  if (!isRedisConfigured()) return new Set();
  const keys = await redis().hkeys(TRACKS_KEY);
  return new Set(Array.isArray(keys) ? keys.map(String) : []);
}

/** How many releases are hydrated so far. */
export async function hydratedCount(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const n = await redis().hlen(TRACKS_KEY);
  return typeof n === "number" ? n : 0;
}

/** All hydrated tracklists, keyed by release id. Empty on any failure. */
async function allTracks(): Promise<Map<string, Track[]>> {
  const out = new Map<string, Track[]>();
  if (!isRedisConfigured()) return out;
  const map = await redis().hgetall<Record<string, Track[]>>(TRACKS_KEY);
  if (!map) return out;
  for (const [id, value] of Object.entries(map)) {
    // The client deserializes JSON by default; guard a stray string value.
    const tracks = typeof value === "string" ? (JSON.parse(value) as Track[]) : value;
    if (Array.isArray(tracks)) out.set(id, tracks);
  }
  return out;
}

/**
 * Deterministic song lookup: records whose tracklist contains the query as a
 * case-insensitive title match. Exact-title matches rank ahead of substring
 * matches. One record per release. Empty on any failure (nothing hydrated yet).
 */
export async function songSearch(query: string, records: ShelfRecord[]): Promise<SearchResult[]> {
  const q = norm(query);
  if (!q) return [];

  let tracksById: Map<string, Track[]>;
  try {
    tracksById = await allTracks();
  } catch {
    return [];
  }
  if (tracksById.size === 0) return [];

  const recordById = new Map<string, ShelfRecord>();
  for (const r of records) if (!recordById.has(r.id)) recordById.set(r.id, r);

  const exact: SearchResult[] = [];
  const partial: SearchResult[] = [];
  for (const [id, tracks] of tracksById) {
    const record = recordById.get(id);
    if (!record) continue;
    let best: { track: Track; exact: boolean } | null = null;
    for (const t of tracks) {
      const title = norm(t.title);
      if (title === q) {
        best = { track: t, exact: true };
        break;
      }
      if (!best && title.includes(q)) best = { track: t, exact: false };
    }
    if (!best) continue;
    const pos = best.track.position ? ` (${best.track.position})` : "";
    const result: SearchResult = { record, reason: `Track: “${best.track.title}”${pos}` };
    (best.exact ? exact : partial).push(result);
  }
  return [...exact, ...partial].slice(0, SONG_RESULT_LIMIT);
}
