/**
 * Data layer for the shared bookmarks feature. Owns the Redis connection and all
 * bookmark reads/writes; nothing else in the app imports `@upstash/redis`.
 *
 * The whole shared list lives in one Redis hash keyed by `vibe-shelf:bookmarks`,
 * with the Discogs release id as the field and a validated `Bookmark` snapshot as
 * the value. Add/remove are O(1), the field key dedups automatically, and listing
 * is a single `hgetall`; ordering by `addedAt` happens after reading.
 */

import { Redis } from "@upstash/redis";
import { parseStringArray } from "@/lib/request"; // existing bounded-array helper
import type { Bookmark, Record as ShelfRecord } from "@/lib/types";

const KEY = "vibe-shelf:bookmarks";
const MAX_BOOKMARKS = 500; // bound growth / abuse (rules 3 and 4)

/** True when Upstash credentials are present in the environment. */
export function isBookmarksConfigured(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
}

let client: Redis | null = null;
function redis(): Redis {
  if (!client) client = Redis.fromEnv(); // reads UPSTASH_* or falls back to KV_REST_API_*
  return client;
}

// --- validation: never trust the client (rule 4) ---

function isReleaseId(v: unknown): v is string {
  // Record.id is a stringified Discogs release id (numeric). Loosen if your ids
  // can be non-numeric. VERIFY this assumption against your data.
  return typeof v === "string" && /^[0-9]{1,15}$/.test(v);
}

function boundedString(v: unknown, maxLen: number): string {
  return typeof v === "string" ? v.slice(0, maxLen) : "";
}

function safeDiscogsUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (!/^https:\/\/(www\.)?discogs\.com\//.test(v)) return undefined; // https Discogs only
  return v.slice(0, 300);
}

/** Rebuild a clean snapshot from validated fields only; null if invalid. */
function toBookmark(input: unknown): Bookmark | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Partial<ShelfRecord>;
  if (!isReleaseId(r.id)) return null;
  return {
    id: r.id,
    artist: boundedString(r.artist, 300),
    title: boundedString(r.title, 300),
    year: typeof r.year === "number" && Number.isFinite(r.year) ? r.year : null,
    label: boundedString(r.label, 200),
    format: boundedString(r.format, 200),
    genres: parseStringArray(r.genres),
    styles: parseStringArray(r.styles),
    owner: boundedString(r.owner, 100),
    discogsUrl: safeDiscogsUrl(r.discogsUrl),
    addedAt: Date.now(),
  };
}

// --- operations ---

export async function listBookmarks(): Promise<Bookmark[]> {
  const map = await redis().hgetall<Record<string, Bookmark>>(KEY);
  if (!map) return [];
  const items: Bookmark[] = [];
  for (const value of Object.values(map)) {
    // The client deserializes JSON by default; guard a stray string value.
    const b = typeof value === "string" ? (JSON.parse(value) as Bookmark) : value;
    if (b && typeof b.id === "string") items.push(b);
  }
  items.sort((a, b) => b.addedAt - a.addedAt);
  return items;
}

/** "added" | "full" | "invalid". Re-saving an existing id overwrites it. */
export async function addBookmark(input: unknown): Promise<"added" | "full" | "invalid"> {
  const bookmark = toBookmark(input);
  if (!bookmark) return "invalid";
  if ((await redis().hlen(KEY)) >= MAX_BOOKMARKS) return "full";
  await redis().hset(KEY, { [bookmark.id]: bookmark });
  return "added";
}

export async function removeBookmark(id: string): Promise<boolean> {
  if (!isReleaseId(id)) return false;
  return (await redis().hdel(KEY, id)) === 1;
}
