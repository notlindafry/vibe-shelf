/**
 * Spotify integration for maybe-vibes album search.
 *
 * Server-side only. Uses the Client Credentials flow (an app-level token, no user
 * login), which reaches public catalog data — all album search needs. The client
 * id and secret live in env vars, are never logged, and never reach the browser
 * bundle: every Spotify call happens here, in the Next.js server.
 *
 * The app token is cached in-process until shortly before it expires and reused
 * across searches; concurrent callers share one in-flight token fetch. A single
 * serverless instance thus requests roughly one token per hour. (This could move
 * to Redis to share tokens across instances, but per-instance caching is enough at
 * this scale — see the note on getAppToken.)
 */

import { HttpError, fetchJson } from "@/lib/http";
import type { SpotifyAlbum } from "@/lib/types";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";
// Without a market and no user token, Spotify treats content as unavailable, so
// results can come back empty; always pass one.
const SEARCH_MARKET = "US";
// Spotify capped the search `limit` at 10 (down from 50) in its February 2026 Web
// API change; sending anything higher now returns HTTP 400. Keep at the max of 10.
const SEARCH_LIMIT = 10;
// Refresh a minute before the real expiry so a token can't lapse mid-request.
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

/** True when both Spotify credentials are configured (server-side only). */
export function isSpotifyConfigured(): boolean {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

// ---- app token (Client Credentials), cached in-process ----

interface CachedToken {
  token: string;
  /** Epoch ms when the token actually expires. */
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let inFlightToken: Promise<string> | null = null;

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/** Request a fresh app token via Client Credentials and cache it. */
async function fetchAppToken(): Promise<string> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Spotify is not configured");

  // HTTP Basic auth: base64(client_id:client_secret). Server-side only; the
  // header (and the secret in it) is never logged.
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!res.ok) {
    // Never surface Spotify's error body upward; keep only the status for callers.
    await res.text().catch(() => undefined);
    throw new HttpError(res.status, `Spotify token request failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error("Spotify token response missing access_token");

  const ttlSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };
  return data.access_token;
}

/**
 * A valid app token, cached until shortly before expiry. Concurrent callers share
 * a single in-flight fetch so a burst of searches can't fan out into many token
 * requests.
 */
async function getAppToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS > Date.now()) {
    return cachedToken.token;
  }
  if (!inFlightToken) {
    inFlightToken = fetchAppToken().finally(() => {
      inFlightToken = null;
    });
  }
  return inFlightToken;
}

// ---- search ----

interface SpotifyImage {
  url?: string;
  height?: number;
  width?: number;
}
interface SpotifyArtist {
  name?: string;
}
interface SpotifyExternalUrls {
  spotify?: string;
}
interface SpotifyAlbumItem {
  id?: string;
  name?: string;
  artists?: SpotifyArtist[];
  release_date?: string;
  images?: SpotifyImage[];
  external_urls?: SpotifyExternalUrls;
}
interface SpotifySearchResult {
  albums?: { items?: SpotifyAlbumItem[] };
}

/** Year from `release_date` ("YYYY", "YYYY-MM", or "YYYY-MM-DD"); null if absent. */
function albumYear(releaseDate: unknown): number | null {
  if (typeof releaseDate !== "string") return null;
  const year = Number(releaseDate.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

/**
 * Pick a cover image. `images` is widest-first; take the mid-size (index 1) when
 * present, else the widest. Allowlist Spotify's image CDN host so only trusted
 * URLs reach the client (and, later, storage).
 */
function albumCover(images: SpotifyImage[] | undefined): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const pick = images[1]?.url ?? images[0]?.url;
  if (typeof pick !== "string") return undefined;
  if (!/^https:\/\/i\.scdn\.co\//.test(pick)) return undefined;
  return pick.slice(0, 500);
}

/** Allowlist the album link host; anything else is dropped. */
function albumSpotifyUrl(external: SpotifyExternalUrls | undefined): string | undefined {
  const url = external?.spotify;
  if (typeof url !== "string") return undefined;
  if (!/^https:\/\/open\.spotify\.com\/album\//.test(url)) return undefined;
  return url.slice(0, 300);
}

/** Map one Spotify album item to the UI shape, or null if it isn't usable. */
function mapAlbum(item: SpotifyAlbumItem): SpotifyAlbum | null {
  const id = item.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(id)) return null;
  const spotifyUrl = albumSpotifyUrl(item.external_urls);
  if (!spotifyUrl) return null; // without a valid open.spotify.com link it isn't addable
  const name = typeof item.name === "string" ? item.name.slice(0, 300) : "";
  if (!name) return null;
  const artist = (item.artists ?? [])
    .map((a) => (typeof a?.name === "string" ? a.name.trim() : ""))
    .filter(Boolean)
    .join(", ")
    .slice(0, 300);
  return {
    id,
    name,
    artist,
    year: albumYear(item.release_date),
    coverImage: albumCover(item.images),
    spotifyUrl,
  };
}

/**
 * Search Spotify albums for a query. Returns mapped, host-validated albums; `[]`
 * for a blank query. Throws `HttpError` on a non-2xx Spotify response so the route
 * can honor a 429 `Retry-After` and otherwise return a generic message. A 401
 * drops the cached token so the next call re-mints one.
 */
export async function searchAlbums(query: string): Promise<SpotifyAlbum[]> {
  const q = query.trim();
  if (!q) return [];

  const token = await getAppToken();
  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(q)}` +
    `&type=album&market=${SEARCH_MARKET}&limit=${SEARCH_LIMIT}`;

  let data: SpotifySearchResult;
  try {
    ({ data } = await fetchJson<SpotifySearchResult>(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeoutMs: 10_000,
    }));
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) cachedToken = null;
    throw err;
  }

  const out: SpotifyAlbum[] = [];
  for (const item of data.albums?.items ?? []) {
    const mapped = mapAlbum(item);
    if (mapped) out.push(mapped);
  }
  return out;
}
