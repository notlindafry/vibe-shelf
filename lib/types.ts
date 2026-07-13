/**
 * Shared types for vibe-shelf.
 *
 * `Record` is the mapped, owner-stamped shape of a single release, merged from
 * one or more Discogs accounts. `QuerySpec` is the structured search intent the
 * "understand" step produces from a natural-language query.
 */

/** A single record in the merged catalogue. */
export interface Record {
  /** Discogs release id (stringified). Stable per release. */
  id: string;
  artist: string;
  title: string;
  /** Release year, or null when Discogs has none / 0. */
  year: number | null;
  /** Primary label name, or empty string when unknown. */
  label: string;
  /** Format summary, e.g. "Vinyl, LP, Album". */
  format: string;
  genres: string[];
  styles: string[];
  /** The friendly label of the account this record was read from. */
  owner: string;
  /** Public Discogs release page, when derivable. */
  discogsUrl?: string;
  /** Discogs-hosted cover art URL, when the release has one. */
  coverImage?: string;
}

/** A saved record: the catalogue fields the card renders, plus when it was saved. */
export interface Bookmark {
  id: string;
  artist: string;
  title: string;
  year: number | null;
  label: string;
  format: string;
  genres: string[];
  styles: string[];
  owner: string;
  discogsUrl?: string;
  /** Discogs-hosted cover art URL, when the release has one. */
  coverImage?: string;
  /** Epoch milliseconds when the bookmark was added. */
  addedAt: number;
}

/** One entry of a release tracklist (feature 5). */
export interface Track {
  /** Discogs track position, e.g. "A1" (may be empty). */
  position: string;
  title: string;
}

/** A record plus how many times it has been logged as played (feature 4). */
export interface PlayedRecord {
  record: Record;
  count: number;
}

/** The daily Forgotten Shelf pick: a neglected record and a short nudge. */
export interface ForgottenPick {
  record: Record;
  /** One-line Claude blurb, or empty string when no key / generation failed. */
  blurb: string;
  /** Epoch milliseconds when this pick was generated. */
  generatedAt: number;
}

/**
 * Structured search intent. The understand step maps a sentence onto this; the
 * prefilter scores records against it; the rerank step orders the survivors.
 *
 * `moods` are feeling words (e.g. "angry", "chill") that the prefilter expands
 * to styles via the vibe-to-style map. `owners`, `genres`, and `styles` act as
 * hard filters when present.
 */
export interface QuerySpec {
  genres: string[];
  styles: string[];
  moods: string[];
  owners: string[];
  artists: string[];
  keywords: string[];
  excludeStyles?: string[];
}

/** A record plus a one-line reason, returned from a search. */
export interface SearchResult {
  record: Record;
  reason: string;
}

/** Response shape for /api/search. */
export interface SearchResponse {
  results: SearchResult[];
  /** The interpreted spec, echoed back so the UI can show how it read the query. */
  spec: QuerySpec;
  /** True when Claude reranking was used; false for the keyword fallback. */
  reranked: boolean;
  /** True when some accounts failed to load but others succeeded. */
  partial: boolean;
  /** True when these results came from a deterministic song-title match (feature 5). */
  songMatch?: boolean;
}

/** Response shape for /api/meta. */
export interface MetaResponse {
  genres: string[];
  styles: string[];
  owners: string[];
  moods: string[];
  total: number;
  partial: boolean;
  features: {
    /** True when ANTHROPIC_API_KEY is set (natural-language search available). */
    aiSearch: boolean;
    similar: boolean;
    random: boolean;
    /** True when the logged-in session is a read-only guest. */
    guest: boolean;
    /** True when wishlist storage (Redis) is configured, so maybe-vibes persists. */
    wishlist: boolean;
  };
}

/**
 * A tap-to-search action an insight card can dispatch (feature 6). The value is
 * validated server-side against the collection (and re-checked client-side)
 * before it can drive a search, so a card can only ever route to a real facet or
 * a bounded free-text query. `mood` is intentionally absent (it needs the fixed
 * Mood vocabulary to route correctly).
 */
export type InsightAction =
  | { type: "genre"; value: string }
  | { type: "style"; value: string }
  | { type: "owner"; value: string }
  | { type: "search"; value: string };

/**
 * One observation about the merged collection, shown as a card in the home-view
 * carousel. Usually model-generated from precomputed aggregates; falls back to
 * code-computed stat cards when no batch is cached. All fields render as escaped
 * React text.
 */
export interface Insight {
  title: string;
  body: string;
  /** Short free-text label the model coins for the kind of observation. */
  kind: string;
  /** Optional tap-to-search action, or null. */
  action: InsightAction | null;
}

/** Response shape for /api/insights. */
export interface InsightsResponse {
  insights: Insight[];
  /** Epoch ms the batch was generated (or, for the fallback, served). */
  generatedAt: number;
  /** True when these are code-computed stat cards rather than a cached model batch. */
  fallback?: boolean;
}

/** Response shape for /api/shelf — records for the home-view "On the shelf" grid. */
export interface ShelfResponse {
  records: Record[];
  /** Total records in the merged collection (for the "View all {count}" link). */
  total: number;
  /** True when some accounts failed to load but others succeeded. */
  partial: boolean;
}

// ---- maybe-vibes wishlist (Spotify-sourced shared shortlist) ----

/** Wishlist entry status: shortlisted vs listened-through-and-confirmed. */
export type WishlistStatus = "unvetted" | "vetted";

/**
 * One entry on the shared maybe-vibes wishlist: a validated snapshot of a Spotify
 * album, its status, and when it was added. There is intentionally no per-user
 * attribution (no addedBy / vettedBy).
 */
export interface WishlistEntry {
  /** Spotify album id (base-62). */
  id: string;
  name: string;
  /** Album artists joined, e.g. "Artist A, Artist B". */
  artist: string;
  /** Release year (first 4 chars of release_date), or null. */
  year: number | null;
  /** Spotify-hosted cover art (i.scdn.co), when present. */
  coverImage?: string;
  /** The album's open.spotify.com/album/{id} link. */
  spotifyUrl: string;
  status: WishlistStatus;
  /** Epoch milliseconds when the entry was added. */
  addedAt: number;
}

/**
 * An album from Spotify search, mapped to the fields the UI needs. Not persisted;
 * the client posts these fields plus a chosen status to add an entry.
 */
export interface SpotifyAlbum {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  coverImage?: string;
  spotifyUrl: string;
}

/** Response shape for /api/spotify/search. */
export interface SpotifySearchResponse {
  albums: SpotifyAlbum[];
}

/** Response shape for /api/wishlist (GET). */
export interface WishlistResponse {
  entries: WishlistEntry[];
}
