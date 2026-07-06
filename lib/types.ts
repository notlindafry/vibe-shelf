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
  /** Epoch milliseconds when the bookmark was added. */
  addedAt: number;
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
  };
}
