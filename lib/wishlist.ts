/**
 * Data layer for the shared maybe-vibes wishlist. Owns a single Redis hash and all
 * wishlist reads/writes, modeled directly on `lib/bookmarks.ts`.
 *
 * The whole shared list lives in one Redis hash keyed `vibe-shelf:wishlist`, with
 * the Spotify album id as the field and a validated `WishlistEntry` snapshot as the
 * value. Add/remove are O(1), the field key dedups automatically, and listing is a
 * single `hgetall`; ordering by `addedAt` happens after reading.
 *
 * Every write rebuilds a clean snapshot from validated fields only — the client is
 * never trusted. Unlike the base app's read paths, the wishlist fails CLOSED when
 * Redis is unconfigured (the route returns 503): a wishlist that silently loses
 * writes is worse than one that is temporarily unavailable.
 */

import { isRedisConfigured, redis } from "@/lib/redis";
import type { WishlistEntry, WishlistStatus } from "@/lib/types";

const KEY = "vibe-shelf:wishlist";
// Generous cap: years of vinyl shopping fit, and one hgetall of this size is not a
// timeout risk. Bounds growth / abuse (rules 3 and 4). Easy to raise later.
const MAX_WISHLIST = 2000;

/** True when Upstash credentials are present, so the wishlist can persist. */
export function isWishlistConfigured(): boolean {
  return isRedisConfigured();
}

/** Outcome of an add attempt; carries the entry on added/duplicate so the UI can
 *  point to it (on duplicate) without a second round-trip. */
export type AddResult =
  | { result: "added"; entry: WishlistEntry }
  | { result: "duplicate"; entry: WishlistEntry }
  | { result: "full" }
  | { result: "invalid" };

// --- validation: never trust the client (rule 4) ---

/** Spotify album ids are base-62; keep the bound loose rather than asserting 22. */
function isAlbumId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{1,40}$/.test(v);
}

function boundedString(v: unknown, maxLen: number): string {
  return typeof v === "string" ? v.slice(0, maxLen) : "";
}

function toStatus(v: unknown): WishlistStatus | null {
  return v === "unvetted" || v === "vetted" ? v : null;
}

/** Allow only Spotify's image CDN host, and cap length. */
function safeCoverImage(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (!/^https:\/\/i\.scdn\.co\//.test(v)) return undefined;
  return v.slice(0, 500);
}

/** Allow only an album link on open.spotify.com, and cap length. */
function safeSpotifyUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (!/^https:\/\/open\.spotify\.com\/album\//.test(v)) return undefined;
  return v.slice(0, 300);
}

/**
 * Rebuild a clean snapshot from validated fields only; null if the id, link, or
 * status is invalid. The status is chosen at add time and is part of the input.
 */
function toWishlistEntry(input: unknown): WishlistEntry | null {
  if (typeof input !== "object" || input === null) return null;
  const r = input as Record<string, unknown>;
  if (!isAlbumId(r.id)) return null;
  const spotifyUrl = safeSpotifyUrl(r.spotifyUrl);
  if (!spotifyUrl) return null; // an entry with no valid Spotify link is not useful
  const status = toStatus(r.status);
  if (!status) return null; // no default: the caller must pick vetted/unvetted
  return {
    id: r.id,
    name: boundedString(r.name, 300),
    artist: boundedString(r.artist, 300),
    year: typeof r.year === "number" && Number.isFinite(r.year) ? r.year : null,
    coverImage: safeCoverImage(r.coverImage),
    spotifyUrl,
    status,
    addedAt: Date.now(),
  };
}

/** Coerce a stored hash value (object, or a stray JSON string) into an entry. */
function normalizeEntry(value: unknown): WishlistEntry | null {
  let entry: WishlistEntry | null = null;
  if (typeof value === "string") {
    try {
      entry = JSON.parse(value) as WishlistEntry;
    } catch {
      return null;
    }
  } else if (value && typeof value === "object") {
    entry = value as WishlistEntry;
  }
  return entry && typeof entry.id === "string" ? entry : null;
}

// --- operations ---

/** The full list, newest first. Guards stray/malformed hash values. */
export async function listWishlist(): Promise<WishlistEntry[]> {
  const map = await redis().hgetall<Record<string, WishlistEntry>>(KEY);
  if (!map) return [];
  const items: WishlistEntry[] = [];
  for (const value of Object.values(map)) {
    const entry = normalizeEntry(value);
    if (entry) items.push(entry);
  }
  items.sort((a, b) => b.addedAt - a.addedAt);
  return items;
}

/**
 * Add an entry. Validates first; if the id already exists returns "duplicate"
 * WITHOUT overwriting (the UI points to the existing entry); if the list is full
 * returns "full"; else stores and returns "added".
 */
export async function addWishlistEntry(input: unknown): Promise<AddResult> {
  const entry = toWishlistEntry(input);
  if (!entry) return { result: "invalid" };

  const existing = normalizeEntry(await redis().hget<WishlistEntry>(KEY, entry.id));
  if (existing) return { result: "duplicate", entry: existing };

  if ((await redis().hlen(KEY)) >= MAX_WISHLIST) return { result: "full" };
  await redis().hset(KEY, { [entry.id]: entry });
  return { result: "added", entry };
}

/**
 * Toggle/set an entry's status. Validates the id and status, reads the existing
 * snapshot, updates only its status, and writes it back. Returns whether the entry
 * existed. Either person can vet; status can move back and forth.
 */
export async function setWishlistStatus(id: string, status: unknown): Promise<boolean> {
  if (!isAlbumId(id)) return false;
  const next = toStatus(status);
  if (!next) return false;
  const existing = normalizeEntry(await redis().hget<WishlistEntry>(KEY, id));
  if (!existing) return false;
  await redis().hset(KEY, { [id]: { ...existing, status: next } });
  return true;
}

/** Remove an entry by id. Returns whether a field was deleted. */
export async function removeWishlistEntry(id: string): Promise<boolean> {
  if (!isAlbumId(id)) return false;
  return (await redis().hdel(KEY, id)) === 1;
}
