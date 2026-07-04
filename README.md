# vibe-shelf

A private, single-login web catalogue of a **shared household vinyl collection**,
deployed on Vercel. Two people each maintain their own Discogs account and buy for
the same physical shelf. The app reads **both** collections server-side, merges
them into one catalogue, stamps each record with its owner, and offers an owner
filter alongside genre, style, and a query-time **mood** layer.

Search is natural-language and vibe-aware: _"angry music"_ surfaces Industrial and
Metal, the way a recipe app maps _"chicken"_ to Poultry. Genre and style come from
Discogs; "mood" is derived at query time and never stored.

## How it works

```
Discogs account 1        Discogs account 2
      \                        /
       \  each read with its own token (server-side only)
        v                      v
vibe-shelf (Next.js on Vercel)
 - lib/discogs.ts : per account -> fetch + paginate + map -> stamp owner
                    -> merge into Record[], cached in memory (TTL)
 - lib/search.ts  : NL query -> QuerySpec -> local prefilter -> Claude rerank
 - proxy.ts + lib/auth + lib/ratelimit : password gate, JWT session, CSP, headers
      v
Browser (password-gated, read-only catalogue with an owner filter)
```

- **All external reads (Discogs, Anthropic) happen server-side.** No secret reaches
  the browser.
- **No database.** The merged collection, cached in memory with a TTL, is the
  source of truth.
- **No write-back.** Records are read-only in the app.

Confirmed constraint: Discogs does not let one account's token read another
account's collection, so each account uses its **own** personal access token.
Account 2 is optional — with only account 1 configured, the app runs
single-account.

## Setup

1. `cp .env.example .env.local` and fill in real values (see `.env.example` for the
   full contract). `.env.local` is gitignored — never commit secrets.
2. `npm install`
3. `npm run dev` (or `npm run build && npm run start`)
4. Set the same variables in the Vercel project (Production scope). The variable
   **names** must match `.env.example` exactly.

Required: `DISCOGS_TOKEN`, `DISCOGS_USERNAME`, `DISCOGS_USER_AGENT`,
`ANTHROPIC_API_KEY`, `APP_PASSWORD`, `SESSION_SECRET` (freshly generated — do not
reuse another app's secret). Optional: the account-2 vars, owner labels,
`APP_GUEST_PASSWORD`, `ANTHROPIC_MODEL`, `DISCOGS_CACHE_TTL_SECONDS`, and Upstash.

## Discogs API (verified, not assumed)

Wired from the current Discogs API docs/forum:

- Collection endpoint: `GET /users/{username}/collection/folders/0/releases`,
  paginated with `page` + `per_page` (max 100); response carries
  `pagination.pages` and a `releases[]` array.
- Auth header: `Authorization: Discogs token=<token>`, per account. A descriptive
  `User-Agent` is required on every request.
- Per release, genre/style/title/artist/year/label/format live under
  `basic_information` (`genres` and `styles` are arrays).
- Rate limit: ~60 req/min authenticated; the layer backs off on HTTP 429 and eases
  off when the `X-Discogs-Ratelimit-Remaining` budget runs low.

## Resolved open decisions

- **A. Data read — cached live fetch (default).** On a cache miss, `lib/discogs.ts`
  fetches every configured account, maps and merges them, and caches in memory for
  `DISCOGS_CACHE_TTL_SECONDS` (~5 min). Switching to periodic sync would only touch
  `lib/discogs.ts` plus a sync job.
- **B. Partial-fetch failure — serve what succeeded (default).** If one account's
  fetch fails, the app serves the accounts that succeeded and logs a server-side
  warning; the UI shows a generic "some records could not be loaded." Only a
  total failure errors the whole load. The specific account/token is never
  surfaced to the client and tokens are never logged.
- **C. Owner in natural-language queries — enabled.** The understand step is given
  the owner labels present and maps an owner named in a query onto the owner
  filter. The explicit owner facet is always available regardless.
- **Owner filter shape:** a multi-select facet matching the genre/style/mood
  facets.
- **Cover art — not shown in this build.** Discogs cover images require auth and
  rate-limit aggressively when rendered in bulk. The spec makes cover art optional;
  skipping it keeps the CSP tight (`img-src 'self' data:`) and avoids image-rate-
  limit fragility. A styled vinyl placeholder stands in. To add cover art later,
  render `basic_information.cover_image` and add the Discogs image CDN
  (`i.discogs.com`) to `img-src` in `proxy.ts`.

## Security notes

- **Auth:** password gate + signed-JWT sessions (HS256, `exp` verified server-side)
  + constant-time password compare. Owner and optional read-only guest roles.
- **Authorization:** the `owner` field is a data attribute for **filtering, not
  access control** — whoever logs in sees both shelves; the owner filter only
  changes the view. That is intended for a shared household shelf.
- **Rate limiting:** per-IP limits on `/api/login` (~5/min, with lockout) and
  `/api/search` (~30/min). **Tradeoff:** the limiter is in-memory and best-effort
  per serverless instance — it resets on cold starts and is not global. For strict
  global limits, back it with Upstash Redis (env vars in `.env.example`).
  **# SECURITY TODO:** Upstash-backed global rate limiting is not wired; see
  `lib/ratelimit.ts`.
- **Headers/CSP:** HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  a referrer policy, a permissions policy, and a per-request nonce-based CSP — all
  applied in `proxy.ts`.
- **Secrets:** every credential lives in env vars, is read only server-side, and is
  never sent to the client, committed, or logged.
- **Input & XSS:** query length capped at 300 chars; facet sizes bounded; all
  Discogs-derived text is validated/trimmed on ingest and rendered as React text
  (never `dangerouslySetInnerHTML`).

## Scripts

- `npm run dev` — dev server
- `npm run build` / `npm run start` — production build & serve
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — Next lint
