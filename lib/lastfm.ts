/**
 * Last.fm client + store (collection-first similarity and listener-tag mood
 * grounding). Mirrors lib/tracks.ts: a background cron hydrates data into one
 * Redis hash so the read path stays free, and every read fails open to empty.
 *
 * Two signals Discogs cannot give us:
 *   - artist.getSimilar — cross-artist sonic similarity, with a 0..1 `match`
 *     score usable directly as a ranking weight.
 *   - artist.getTopTags — crowd-sourced descriptive tags ("melancholy", "late
 *     night") that ground the mood classifier in how listeners hear the music.
 *
 * Data model — one Redis hash `vs:lastfm:artist`:
 *   - Field: normalized artist key (lowercase, trailing " (4)"-style Discogs
 *     disambiguator stripped, whitespace collapsed — the same shape as norm() in
 *     lib/tracks.ts / lib/search.ts).
 *   - Value: ArtistData (JSON). An object with empty `similar` AND `tags` marks
 *     an artist hydrated-but-empty (not found, or no data), so the backfill stops
 *     re-fetching it. The field set doubles as the "hydrated" set, exactly like
 *     hydratedIds() in lib/tracks.ts.
 *
 * A companion integer `vs:lastfm:version` is bumped whenever the cron stores new
 * artist data; the mood index folds it into its cache signature so mood tags are
 * picked up once they land (see lib/moods.ts).
 *
 * Runs server-side only. The API key lives in env (LASTFM_API_KEY) and is passed
 * in the query string, so request URLs are NEVER logged (they would leak the key)
 * — callers log the artist name and status only.
 */

import { HttpError, fetchJson } from "@/lib/http";
import { isRedisConfigured, redis } from "@/lib/redis";

const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";
const ARTIST_KEY = "vs:lastfm:artist";
const VERSION_KEY = "vs:lastfm:version";

// Keep stored payloads bounded: plenty for ranking, cheap to read.
const MAX_SIMILAR = 50;
const MAX_TAGS = 8;
// Last.fm top-tag counts are a 0..100 weight relative to the most-used tag.
// Below this the tag is noise; the stoplist removes non-descriptive junk.
const MIN_TAG_COUNT = 10;

/**
 * Non-descriptive folksonomy tags that carry no sonic/mood signal: library
 * bookkeeping ("albums i own"), event tags ("seen live"), bare praise, and
 * demographic/nationality labels. Lowercased; matched exactly after cleaning.
 */
const TAG_STOPLIST = new Set<string>([
  "seen live",
  "favorites",
  "favourites",
  "favorite",
  "favourite",
  "my favorites",
  "my favourites",
  "favorite songs",
  "favorite artists",
  "albums i own",
  "albums i want",
  "want to see live",
  "collection",
  "owned",
  "my music",
  "spotify",
  "vinyl",
  "cd",
  "mp3",
  "under 2000 listeners",
  "love",
  "loved",
  "awesome",
  "amazing",
  "beautiful",
  "good",
  "great",
  "cool",
  "best",
  "the best",
  "good music",
  "male vocalists",
  "female vocalists",
  "male vocalist",
  "female vocalist",
  "american",
  "british",
  "usa",
  "uk",
]);

export interface SimilarArtist {
  name: string;
  /** MusicBrainz id, when Last.fm has one (empty otherwise). Reserved for a v2 mbid match. */
  mbid: string;
  /** 0 (not similar) .. 1 (very similar); usable directly as a ranking weight. */
  match: number;
}

export interface ArtistTag {
  tag: string;
  count: number;
}

/** One artist's Last.fm data, as stored in Redis. */
export interface ArtistData {
  similar: SimilarArtist[];
  tags: ArtistTag[];
  fetchedAt: number;
}

/** True when the Last.fm API key is present (server-side only). */
export function isLastfmConfigured(): boolean {
  return Boolean(process.env.LASTFM_API_KEY);
}

/**
 * Normalized artist key: strip a trailing Discogs disambiguator (" (4)"),
 * collapse whitespace, lowercase. The same shape used across tracks/search so
 * Discogs names and Last.fm names line up.
 */
export function normArtist(name: string): string {
  return name
    .replace(/\s+\(\d+\)$/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim, collapse whitespace, and cap length of untrusted Last.fm text. */
function clean(value: unknown, maxLen = 120): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---- Last.fm response shapes (only the fields we read) ----

interface LastfmErrorBody {
  error?: number;
  message?: string;
}
interface SimilarResponse extends LastfmErrorBody {
  similarartists?: { artist?: Array<{ name?: string; mbid?: string; match?: string | number }> };
}
interface TopTagsResponse extends LastfmErrorBody {
  toptags?: { tag?: Array<{ name?: string; count?: string | number }> };
}

/**
 * Last.fm returns HTTP 200 even for logical failures, with an `{error, message}`
 * body. Map its error codes onto HTTP-like statuses so the cron can branch the
 * same way it does for Discogs: 404 → store soft-empty, 429/5xx → retry later.
 */
function lastfmError(code: number): HttpError {
  if (code === 6 || code === 7) return new HttpError(404, "Last.fm: resource not found");
  if (code === 29) return new HttpError(429, "Last.fm: rate limit exceeded");
  if (code === 8 || code === 11 || code === 16) return new HttpError(503, "Last.fm: temporary failure");
  // 10 invalid key, 26 suspended key, 4 auth, etc. — a hard, non-retryable fault.
  return new HttpError(400, `Last.fm error ${code}`);
}

/**
 * Call one Last.fm method for an artist. Reads LASTFM_API_KEY server-side. The
 * URL (which carries the key) is never returned or logged. Throws HttpError on
 * both transport failures and Last.fm error bodies so callers can branch on status.
 */
async function callLastfm<T extends LastfmErrorBody>(method: string, artist: string): Promise<T> {
  const key = process.env.LASTFM_API_KEY;
  if (!key) throw new Error("LASTFM_API_KEY not configured");

  const url = new URL(LASTFM_API);
  url.searchParams.set("method", method);
  url.searchParams.set("artist", artist);
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("autocorrect", "1");

  const { data } = await fetchJson<T>(url.toString(), { timeoutMs: 15_000 });
  if (typeof data.error === "number" && data.error !== 0) throw lastfmError(data.error);
  return data;
}

/** Fetch similar artists (0..1 match), best matches first. Throws on failure. */
export async function fetchSimilarArtists(name: string): Promise<SimilarArtist[]> {
  const data = await callLastfm<SimilarResponse>("artist.getsimilar", name);
  const raw = data.similarartists?.artist ?? [];
  const out: SimilarArtist[] = [];
  for (const a of raw) {
    const nm = clean(a?.name);
    if (!nm) continue;
    out.push({
      name: nm,
      mbid: clean(a?.mbid, 60),
      match: clamp01(Number(a?.match)),
    });
    if (out.length >= MAX_SIMILAR) break;
  }
  return out;
}

/** Fetch filtered top tags (junk stoplisted, below-threshold dropped). Throws on failure. */
export async function fetchArtistTags(name: string): Promise<ArtistTag[]> {
  const data = await callLastfm<TopTagsResponse>("artist.gettoptags", name);
  const raw = data.toptags?.tag ?? [];
  const out: ArtistTag[] = [];
  for (const t of raw) {
    const tag = clean(t?.name, 40).toLowerCase();
    if (!tag || TAG_STOPLIST.has(tag)) continue;
    const count = Number(t?.count);
    if (!Number.isFinite(count) || count < MIN_TAG_COUNT) continue;
    out.push({ tag, count });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// ---- Store (Redis hash, one field per artist) ----

/** Store an artist's combined data. Empty similar + tags marks it hydrated-empty. */
export async function storeArtist(key: string, data: ArtistData): Promise<void> {
  await redis().hset(ARTIST_KEY, { [key]: data });
}

/** One artist's data, or null when unconfigured / missing / on any read error. */
export async function getArtist(key: string): Promise<ArtistData | null> {
  if (!isRedisConfigured()) return null;
  try {
    const data = await redis().hget<ArtistData>(ARTIST_KEY, key);
    return data ?? null;
  } catch {
    return null;
  }
}

/** Artist keys already hydrated (present as fields). Empty when unconfigured. */
export async function hydratedArtistKeys(): Promise<Set<string>> {
  if (!isRedisConfigured()) return new Set();
  const keys = await redis().hkeys(ARTIST_KEY);
  return new Set(Array.isArray(keys) ? keys.map(String) : []);
}

/** All hydrated artist data, keyed by normalized artist. Empty on any failure. */
export async function allArtistData(): Promise<Map<string, ArtistData>> {
  const out = new Map<string, ArtistData>();
  if (!isRedisConfigured()) return out;
  const map = await redis().hgetall<Record<string, ArtistData>>(ARTIST_KEY);
  if (!map) return out;
  for (const [key, value] of Object.entries(map)) {
    // The client deserializes JSON by default; guard a stray string value.
    const data = typeof value === "string" ? (JSON.parse(value) as ArtistData) : value;
    if (data && typeof data === "object") out.set(key, data);
  }
  return out;
}

// ---- Hydration version (mood-cache invalidation, see lib/moods.ts) ----

/** Bump the hydration version so the mood index recomputes with the new tags. */
export async function bumpLastfmVersion(): Promise<void> {
  try {
    await redis().incr(VERSION_KEY);
  } catch {
    // Best-effort: a missed bump just delays mood recompute to the next change.
  }
}

/** Current hydration version, or 0 when unconfigured / on any read error. */
export async function getLastfmVersion(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  try {
    const v = await redis().get<number>(VERSION_KEY);
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
