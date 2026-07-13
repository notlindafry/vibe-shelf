/**
 * Multi-account Discogs data layer (replaces recipefinder's sheet layer).
 *
 * For each configured account it fetches the full collection (folder 0 = "All"),
 * following pagination, maps each release to a `Record`, stamps the account's
 * owner label, and merges everything into one array cached in memory with a TTL.
 *
 * Verified against the current Discogs API (docs + developer forum):
 *   - Endpoint: GET /users/{username}/collection/folders/0/releases
 *   - Pagination: `page` + `per_page` (max 100); response carries
 *     `pagination.pages` and a `releases[]` array.
 *   - Auth: `Authorization: Discogs token=<token>` header, per account.
 *   - A descriptive `User-Agent` is required on every request.
 *   - Rate limit: ~60 req/min authenticated; a 429 means slow down. Rate-limit
 *     state is exposed via the `X-Discogs-Ratelimit-*` headers.
 *   - Per release, genre/style/title/artist/year/label/format live under
 *     `basic_information` with `genres` and `styles` arrays.
 *
 * All reads happen server-side only. Tokens are never logged (rule 5) and
 * upstream error bodies are never surfaced to the client (rule 8).
 */

import { after } from "next/server";
import { HttpError, fetchJson, sleep } from "@/lib/http";
import { isRedisConfigured, redis } from "@/lib/redis";
import type { Record as ShelfRecord, Track } from "@/lib/types";

const DISCOGS_API = "https://api.discogs.com";
const PER_PAGE = 100;
const MAX_PAGES = 100; // safety cap: 100 pages * 100 = 10k records
const PARTIAL_MARKER = "some records could not be loaded";

// Redis keys (see lib spec §0.3). The blob holds only public Discogs metadata.
const COLLECTION_KEY = "vs:collection:merged";
const LOCK_KEY = "vs:lock:collection";
const LOCK_TTL_SECONDS = 30; // auto-expires so a crashed refresh can't wedge the lock

interface AccountConfig {
  username: string;
  token: string;
  label: string;
}

interface CachedCollection {
  records: ShelfRecord[];
  partial: boolean;
  expiresAt: number;
}

/** Shape persisted in Redis. Public metadata only — no tokens, no secrets. */
interface CollectionBlob {
  fetchedAt: number;
  records: ShelfRecord[];
  partial: boolean;
}

// ---- Discogs response shapes (only the fields we read) ----

interface DiscogsArtist {
  name?: string;
}
interface DiscogsLabel {
  name?: string;
}
interface DiscogsFormat {
  name?: string;
  descriptions?: string[];
}
interface DiscogsBasicInformation {
  id?: number;
  title?: string;
  year?: number;
  artists?: DiscogsArtist[];
  labels?: DiscogsLabel[];
  formats?: DiscogsFormat[];
  genres?: string[];
  styles?: string[];
  cover_image?: string;
  thumb?: string;
}
interface DiscogsCollectionItem {
  id?: number;
  basic_information?: DiscogsBasicInformation;
}
interface DiscogsCollectionResponse {
  pagination?: { pages?: number; page?: number };
  releases?: DiscogsCollectionItem[];
}
interface DiscogsTrack {
  position?: string;
  title?: string;
  type_?: string;
}
interface DiscogsRelease {
  tracklist?: DiscogsTrack[];
}

// ---- In-process cache (dedupes concurrent loads to avoid a stampede) ----

let cache: CachedCollection | null = null;
let inFlight: Promise<CachedCollection> | null = null;

function cacheTtlMs(): number {
  const raw = Number(process.env.DISCOGS_CACHE_TTL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : 300;
  return seconds * 1000;
}

/**
 * Read configured accounts from env into a list. Account 2 is optional; modeled
 * as a list so a third account could be added later.
 */
export function getAccounts(): AccountConfig[] {
  const accounts: AccountConfig[] = [];

  const u1 = process.env.DISCOGS_USERNAME?.trim();
  const t1 = process.env.DISCOGS_TOKEN?.trim();
  if (u1 && t1) {
    accounts.push({ username: u1, token: t1, label: process.env.DISCOGS_LABEL?.trim() || u1 });
  }

  const u2 = process.env.DISCOGS_USERNAME_2?.trim();
  const t2 = process.env.DISCOGS_TOKEN_2?.trim();
  if (u2 && t2) {
    accounts.push({ username: u2, token: t2, label: process.env.DISCOGS_LABEL_2?.trim() || u2 });
  }

  return accounts;
}

function userAgent(): string {
  // Discogs requires a descriptive UA. Fall back to a sane default rather than
  // sending an empty header, but the deployment should set DISCOGS_USER_AGENT.
  return process.env.DISCOGS_USER_AGENT?.trim() || "vibe-shelf/1.0 (+https://vibe-shelf.vercel.app)";
}

// ---- String hygiene (rule 4: validate/trim third-party text on ingest) ----

/** Trim, collapse whitespace, and cap length of untrusted Discogs text. */
function clean(value: unknown, maxLen = 300): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

/** Discogs appends " (2)"-style disambiguation numbers to duplicate names. */
function stripDisambiguation(name: string): string {
  return name.replace(/\s+\(\d+\)$/, "").trim();
}

function cleanList(values: unknown, maxItems = 25): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    const c = clean(v, 60);
    if (c) out.push(c);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Only accept https image URLs on Discogs' own CDN, matching the `img-src`
 * allowlist in proxy.ts. Anything else (spacer/placeholder hosts, other origins)
 * becomes undefined so the card falls back to the styled placeholder.
 */
function discogsImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^https:\/\/(i|img)\.discogs\.com\//.test(value)) return undefined;
  return value.length > 500 ? value.slice(0, 500) : value;
}

function mapRelease(item: DiscogsCollectionItem, owner: string): ShelfRecord | null {
  const info = item.basic_information;
  const releaseId = info?.id ?? item.id;
  if (!info || typeof releaseId !== "number") return null;

  const artist = (info.artists ?? [])
    .map((a) => stripDisambiguation(clean(a?.name, 120)))
    .filter(Boolean)
    .join(", ");

  const label = stripDisambiguation(clean(info.labels?.[0]?.name, 120));

  const format = (info.formats ?? [])
    .map((f) => {
      const parts = [clean(f?.name, 40), ...cleanList(f?.descriptions, 6)].filter(Boolean);
      return parts.join(", ");
    })
    .filter(Boolean)
    .join(" + ");

  const year = typeof info.year === "number" && info.year > 0 ? info.year : null;

  // Prefer the larger cover_image; fall back to the thumb. Both are Discogs-hosted.
  const coverImage = discogsImageUrl(info.cover_image) ?? discogsImageUrl(info.thumb);

  return {
    id: String(releaseId),
    artist: artist || "Unknown Artist",
    title: clean(info.title, 200) || "Untitled",
    year,
    label,
    format,
    genres: cleanList(info.genres),
    styles: cleanList(info.styles),
    owner,
    discogsUrl: `https://www.discogs.com/release/${releaseId}`,
    coverImage,
  };
}

/**
 * Respect Discogs rate limiting between pages: if the remaining budget in the
 * current window is low, pause briefly so we don't trip a 429.
 */
async function respectRateLimit(headers: Headers): Promise<void> {
  const remaining = Number(headers.get("x-discogs-ratelimit-remaining"));
  if (Number.isFinite(remaining) && remaining <= 2) {
    // The window is a 60s moving average; a short pause lets it drain.
    await sleep(2_000);
  }
}

/** Fetch one account's full collection, following pagination. */
async function fetchAccountCollection(account: AccountConfig): Promise<ShelfRecord[]> {
  const headers = {
    Authorization: `Discogs token=${account.token}`,
    "User-Agent": userAgent(),
    Accept: "application/json",
  };

  const records: ShelfRecord[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= MAX_PAGES) {
    const url =
      `${DISCOGS_API}/users/${encodeURIComponent(account.username)}` +
      `/collection/folders/0/releases?per_page=${PER_PAGE}&page=${page}`;

    const { data, headers: resHeaders } = await fetchWithBackoff<DiscogsCollectionResponse>(url, headers);

    const pages = data.pagination?.pages;
    if (typeof pages === "number" && pages > 0) totalPages = pages;

    for (const item of data.releases ?? []) {
      const mapped = mapRelease(item, account.label);
      if (mapped) records.push(mapped);
    }

    await respectRateLimit(resHeaders);
    page += 1;
  }

  return records;
}

/**
 * Fetch one release's tracklist (feature 5). Uses the same rate-limit-aware fetch
 * discipline as the collection paginate — bounded backoff on 429/5xx, then a pause
 * when the remaining Discogs budget is low. Titles are trimmed on ingest (rule 4).
 * Authenticated with the first configured account's token (release data is public;
 * auth just raises the rate limit).
 */
export async function fetchReleaseTracks(id: string): Promise<Track[]> {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error("No Discogs accounts configured (DISCOGS_USERNAME / DISCOGS_TOKEN)");
  }
  const headers = {
    Authorization: `Discogs token=${accounts[0].token}`,
    "User-Agent": userAgent(),
    Accept: "application/json",
  };
  const url = `${DISCOGS_API}/releases/${encodeURIComponent(id)}`;
  const { data, headers: resHeaders } = await fetchWithBackoff<DiscogsRelease>(url, headers);
  await respectRateLimit(resHeaders);

  const tracks: Track[] = [];
  for (const t of data.tracklist ?? []) {
    const title = clean(t?.title, 200);
    if (!title) continue; // skip section headings and blank rows
    tracks.push({ position: clean(t?.position, 12), title });
  }
  return tracks;
}

/**
 * A timeout (our AbortController firing) or a transient network blip surfaces as
 * an AbortError / generic fetch failure rather than an HttpError. These callers
 * never pass an external abort signal, so any abort here is our own timeout and is
 * safe to retry — a single slow Discogs page shouldn't fail the whole load.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof HttpError) return false;
  if (!(err instanceof Error)) return false;
  return (
    err.name === "AbortError" ||
    err.name === "TimeoutError" ||
    /abort|timed?\s?out|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(err.message)
  );
}

/** Fetch with a bounded retry/backoff on 429, transient 5xx, and timeouts. */
async function fetchWithBackoff<T>(
  url: string,
  headers: Record<string, string>,
): Promise<{ data: T; headers: Headers }> {
  const maxAttempts = 5;
  let attempt = 0;
  // Backoff schedule in ms for retryable failures without a Retry-After hint.
  const backoff = [1_000, 2_000, 4_000, 8_000];

  for (;;) {
    attempt += 1;
    try {
      return await fetchJson<T>(url, { headers, timeoutMs: 20_000 });
    } catch (err) {
      const retryable =
        (err instanceof HttpError && (err.status === 429 || (err.status >= 500 && err.status < 600))) ||
        isTransientNetworkError(err);
      if (!retryable || attempt >= maxAttempts) throw err;

      const hintSeconds = err instanceof HttpError ? err.retryAfterSeconds : undefined;
      const waitMs = hintSeconds != null ? hintSeconds * 1000 : backoff[Math.min(attempt - 1, backoff.length - 1)];
      await sleep(waitMs);
    }
  }
}

/**
 * Load and merge all configured accounts. Partial-failure behavior (decision B):
 * serve the accounts that succeeded and log a server-side warning if one fails,
 * rather than failing the whole load. Only when EVERY account fails do we throw.
 */
async function loadCollection(): Promise<CachedCollection> {
  const accounts = getAccounts();
  if (accounts.length === 0) {
    throw new Error("No Discogs accounts configured (DISCOGS_USERNAME / DISCOGS_TOKEN)");
  }

  const settled = await Promise.allSettled(accounts.map((a) => fetchAccountCollection(a)));

  const merged: ShelfRecord[] = [];
  let failures = 0;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
    } else {
      failures += 1;
      // Log server-side only, WITHOUT the token or account identity beyond the
      // username (never the secret). This is the honest partial-failure signal.
      console.warn(
        `[discogs] failed to load collection for account "${accounts[index].username}": ${describeError(result.reason)}`,
      );
    }
  });

  if (failures === accounts.length) {
    // Total failure — throw with detail for server logs; the route returns a
    // generic client message (rule 8).
    throw new Error(`All Discogs account loads failed (${failures}/${accounts.length})`);
  }

  return {
    records: merged,
    partial: failures > 0,
    expiresAt: Date.now() + cacheTtlMs(),
  };
}

function describeError(reason: unknown): string {
  if (reason instanceof HttpError) return `HTTP ${reason.status}`;
  if (reason instanceof Error) return reason.message;
  return "unknown error";
}

/**
 * Return the merged collection. Three layers, each failing open to the next:
 *   1. In-process cache (fast, per instance).
 *   2. Redis blob shared across instances. Served even when slightly stale; a
 *      background refresh is kicked so the next read is fresh, and Vercel Cron
 *      also refreshes on a schedule.
 *   3. A live Discogs fetch (cold miss, or Redis unconfigured/unreachable).
 * Any Redis error is logged and drops through to the live path, so the catalogue
 * always loads (fail open, feature spec §0.4).
 */
export async function getCollection(): Promise<{ records: ShelfRecord[]; partial: boolean }> {
  const now = Date.now();
  const ttl = cacheTtlMs();

  // L1: in-process cache.
  if (cache && cache.expiresAt > now) {
    return { records: cache.records, partial: cache.partial };
  }

  // L2: Redis, shared across instances. Fail open on any error.
  if (isRedisConfigured()) {
    try {
      const blob = await redis().get<CollectionBlob>(COLLECTION_KEY);
      if (blob && Array.isArray(blob.records)) {
        const fetchedAt = typeof blob.fetchedAt === "number" ? blob.fetchedAt : 0;
        cache = { records: blob.records, partial: Boolean(blob.partial), expiresAt: fetchedAt + ttl };
        // Stale-while-revalidate: past the TTL, serve it now but refresh in the
        // background (cron also refreshes; this self-heals between cron runs).
        if (now - fetchedAt >= ttl) triggerBackgroundRefresh();
        return { records: blob.records, partial: Boolean(blob.partial) };
      }
    } catch (err) {
      console.error(
        "[discogs] Redis read failed; falling back to live fetch:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // L3: live fetch (cold miss or Redis down). Concurrent callers share one load.
  if (!inFlight) {
    inFlight = refreshCollection().finally(() => {
      inFlight = null;
    });
  }
  const result = await inFlight;
  return { records: result.records, partial: result.partial };
}

/** Kick a non-blocking refresh, deduped against any in-flight load. */
function triggerBackgroundRefresh(): void {
  if (inFlight) return;
  const refresh = refreshCollection()
    .catch((err) => {
      console.error(
        "[discogs] background refresh failed:",
        err instanceof Error ? err.message : err,
      );
      // Keep serving whatever we last had rather than surfacing an error here.
      return cache ?? { records: [], partial: false, expiresAt: 0 };
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = refresh;

  // On serverless, work started after the response is sent is frozen and its
  // in-flight fetches are aborted ("This operation was aborted"), so a bare
  // fire-and-forget refresh never completes. after() keeps the function alive
  // until the refresh settles. Outside a request context after() throws, so fall
  // back to the running promise (best effort; the daily cron still refreshes).
  try {
    after(refresh);
  } catch {
    // no request scope — refresh is already running best-effort
  }
}

/**
 * The last-known-good collection snapshot, preferring the shared Redis blob and
 * falling back to the in-process cache. Used to decide whether a partial load
 * should be allowed to replace a fuller cached collection.
 */
async function lastKnownGoodCollection(
  haveRedis: boolean,
): Promise<{ records: ShelfRecord[]; partial: boolean } | null> {
  if (haveRedis) {
    try {
      const blob = await redis().get<CollectionBlob>(COLLECTION_KEY);
      if (blob && Array.isArray(blob.records)) {
        return { records: blob.records, partial: Boolean(blob.partial) };
      }
    } catch (err) {
      console.error(
        "[discogs] last-known-good read failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (cache && Array.isArray(cache.records)) {
    return { records: cache.records, partial: cache.partial };
  }
  return null;
}

/**
 * Fetch every account, map, merge, then write the result to Redis and the
 * in-process cache. Exported so the Vercel Cron route can warm the cache on a
 * schedule. A short Redis lock keeps a cold-start stampede from fanning out into
 * many concurrent Discogs paginates; it is best-effort and always fails open to a
 * direct fetch.
 *
 * Partial loads never shrink a good cache: when one account fails (decision B),
 * the merged set is smaller, so if a previously cached snapshot has more records
 * we keep serving that one instead of overwriting it. The good snapshot is
 * re-stamped so reads don't treat it as stale and hammer Discogs; the next
 * TTL/cron cycle retries the failed account, so the shelf self-heals once that
 * account recovers. Only a cold start with no prior cache serves the partial set.
 */
export async function refreshCollection(): Promise<CachedCollection> {
  const haveRedis = isRedisConfigured();
  let lockAcquired = false;

  if (haveRedis) {
    try {
      const res = await redis().set(LOCK_KEY, "1", { nx: true, ex: LOCK_TTL_SECONDS });
      lockAcquired = res === "OK";
      if (!lockAcquired) {
        // Another instance is refreshing. Wait briefly and reuse its result.
        await sleep(1_500);
        const blob = await redis().get<CollectionBlob>(COLLECTION_KEY).catch(() => null);
        if (blob && Array.isArray(blob.records)) {
          const result: CachedCollection = {
            records: blob.records,
            partial: Boolean(blob.partial),
            expiresAt: (typeof blob.fetchedAt === "number" ? blob.fetchedAt : Date.now()) + cacheTtlMs(),
          };
          cache = result;
          return result;
        }
        // Nothing published yet; fetch ourselves rather than block (fail open).
      }
    } catch (err) {
      console.error("[discogs] lock step failed:", err instanceof Error ? err.message : err);
    }
  }

  try {
    const loaded = await loadCollection();

    // Guard: a partial load (one account failed) must not overwrite a fuller
    // cached collection. Keep the last-known-good snapshot whenever it has more
    // records, re-stamping it so the next TTL/cron cycle retries the failed
    // account rather than every read hammering Discogs.
    if (loaded.partial) {
      const prev = await lastKnownGoodCollection(haveRedis);
      if (prev && prev.records.length > loaded.records.length) {
        const kept: CachedCollection = {
          records: prev.records,
          partial: prev.partial,
          expiresAt: Date.now() + cacheTtlMs(),
        };
        cache = kept;
        if (haveRedis) {
          const blob: CollectionBlob = {
            fetchedAt: Date.now(),
            records: prev.records,
            partial: prev.partial,
          };
          try {
            await redis().set(COLLECTION_KEY, blob);
          } catch (err) {
            console.error("[discogs] Redis write failed:", err instanceof Error ? err.message : err);
          }
        }
        console.warn(
          `[discogs] partial load (${loaded.records.length} records); kept last-known-good (${prev.records.length} records)`,
        );
        return kept;
      }
    }

    cache = loaded;
    if (haveRedis) {
      const blob: CollectionBlob = {
        fetchedAt: Date.now(),
        records: loaded.records,
        partial: loaded.partial,
      };
      try {
        await redis().set(COLLECTION_KEY, blob);
      } catch (err) {
        console.error("[discogs] Redis write failed:", err instanceof Error ? err.message : err);
      }
    }
    return loaded;
  } finally {
    if (lockAcquired) {
      await redis().del(LOCK_KEY).catch(() => undefined); // lock also auto-expires
    }
  }
}

/** Test/ops hook: drop the in-process cache so the next read re-fetches. */
export function clearCollectionCache(): void {
  cache = null;
}

export { PARTIAL_MARKER };
