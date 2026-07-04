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

import { HttpError, fetchJson, sleep } from "@/lib/http";
import type { Record as ShelfRecord } from "@/lib/types";

const DISCOGS_API = "https://api.discogs.com";
const PER_PAGE = 100;
const MAX_PAGES = 100; // safety cap: 100 pages * 100 = 10k records
const PARTIAL_MARKER = "some records could not be loaded";

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
}
interface DiscogsCollectionItem {
  id?: number;
  basic_information?: DiscogsBasicInformation;
}
interface DiscogsCollectionResponse {
  pagination?: { pages?: number; page?: number };
  releases?: DiscogsCollectionItem[];
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

/** Fetch with a bounded retry/backoff on 429 and transient 5xx responses. */
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
        err instanceof HttpError && (err.status === 429 || (err.status >= 500 && err.status < 600));
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
 * Return the merged collection, served from cache when fresh. Concurrent callers
 * during a cache miss share a single in-flight load.
 */
export async function getCollection(): Promise<{ records: ShelfRecord[]; partial: boolean }> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return { records: cache.records, partial: cache.partial };
  }

  if (!inFlight) {
    inFlight = loadCollection()
      .then((result) => {
        cache = result;
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  const result = await inFlight;
  return { records: result.records, partial: result.partial };
}

/** Test/ops hook: drop the cache so the next read re-fetches. */
export function clearCollectionCache(): void {
  cache = null;
}

export { PARTIAL_MARKER };
