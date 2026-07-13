/**
 * Client-side fetch helpers for the vibe-shelf endpoints. Thin wrappers that
 * return typed payloads and normalise error handling.
 */

import type {
  Bookmark,
  ForgottenPick,
  InsightsResponse,
  MetaResponse,
  PlayedRecord,
  Record as ShelfRecord,
  SearchResponse,
  SearchResult,
  ShelfResponse,
  SpotifyAlbum,
  WishlistEntry,
  WishlistStatus,
} from "@/lib/types";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const message = await extractError(res);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

async function extractError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data.error) return data.error;
  } catch {
    // ignore
  }
  return "Request failed. Please try again.";
}

export interface SearchParams {
  query: string;
  owners: string[];
  genres: string[];
  styles: string[];
  moods: string[];
}

export async function fetchMeta(): Promise<MetaResponse> {
  const res = await fetch("/api/meta", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return (await res.json()) as MetaResponse;
}

export function search(params: SearchParams): Promise<SearchResponse> {
  return postJson<SearchResponse>("/api/search", params);
}

export function surpriseMe(
  filters: Omit<SearchParams, "query">,
): Promise<{ result: SearchResult | null }> {
  return postJson("/api/random", filters);
}

export function moreLikeThis(
  id: string,
  owner: string,
): Promise<{ seed: SearchResult["record"]; results: SearchResult[]; usedLastfm?: boolean }> {
  return postJson("/api/similar", { id, owner });
}

export async function fetchBookmarks(): Promise<Bookmark[]> {
  const res = await fetch("/api/bookmarks", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return ((await res.json()) as { bookmarks: Bookmark[] }).bookmarks;
}

export async function addBookmark(record: ShelfRecord): Promise<void> {
  await postJson("/api/bookmarks", { record });
}

export async function removeBookmark(id: string): Promise<void> {
  const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractError(res));
}

export async function logPlay(id: string): Promise<number> {
  const data = await postJson<{ ok: true; count: number }>("/api/play", { id });
  return data.count;
}

export async function fetchPlays(): Promise<{
  counts: Record<string, number>;
  mostPlayed: PlayedRecord[];
}> {
  const res = await fetch("/api/play", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return (await res.json()) as { counts: Record<string, number>; mostPlayed: PlayedRecord[] };
}

export async function fetchForgotten(force = false): Promise<ForgottenPick | null> {
  const res = await fetch(`/api/forgotten${force ? "?refresh=1" : ""}`, { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return ((await res.json()) as { pick: ForgottenPick | null }).pick;
}

export async function fetchInsights(): Promise<InsightsResponse> {
  const res = await fetch("/api/insights", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return (await res.json()) as InsightsResponse;
}

/**
 * Records for the "On the shelf" grid. `all` requests the full collection (for
 * "View all"); otherwise a small random sample of `limit` records for the
 * home-view preview.
 */
export async function fetchShelf(limit = 8, all = false): Promise<ShelfResponse> {
  const query = all ? "?all=1" : `?limit=${encodeURIComponent(String(limit))}`;
  const res = await fetch(`/api/shelf${query}`, { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return (await res.json()) as ShelfResponse;
}

// ---- maybe-vibes wishlist (Spotify search + shared list) ----

/** Search Spotify albums for the add flow. */
export async function spotifySearch(query: string): Promise<SpotifyAlbum[]> {
  const res = await fetch(`/api/spotify/search?q=${encodeURIComponent(query)}`, { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return ((await res.json()) as { albums: SpotifyAlbum[] }).albums;
}

/** The full shared wishlist, newest first. */
export async function fetchWishlist(): Promise<WishlistEntry[]> {
  const res = await fetch("/api/wishlist", { method: "GET" });
  if (!res.ok) throw new Error(await extractError(res));
  return ((await res.json()) as { entries: WishlistEntry[] }).entries;
}

/**
 * Add an album with a chosen status. Resolves with the stored entry and whether it
 * was already present (`duplicate`), so the caller can point to the existing one
 * instead of creating a copy.
 */
export async function addWishlist(
  album: SpotifyAlbum,
  status: WishlistStatus,
): Promise<{ duplicate: boolean; entry: WishlistEntry }> {
  const data = await postJson<{ ok: true; duplicate?: boolean; entry: WishlistEntry }>(
    "/api/wishlist",
    { ...album, status },
  );
  return { duplicate: Boolean(data.duplicate), entry: data.entry };
}

/** Change an entry's status (vetted <-> unvetted). */
export async function setWishlistStatus(id: string, status: WishlistStatus): Promise<void> {
  const res = await fetch("/api/wishlist", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status }),
  });
  if (!res.ok) throw new Error(await extractError(res));
}

/** Remove an entry from the wishlist. */
export async function removeWishlist(id: string): Promise<void> {
  const res = await fetch(`/api/wishlist?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await extractError(res));
}

export async function login(password: string): Promise<{ ok: true; role: string }> {
  return postJson("/api/login", { password });
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}
