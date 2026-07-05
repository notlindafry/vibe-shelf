/**
 * Natural-language, vibe-aware search over the merged catalogue.
 *
 * Two-step pipeline (same shape as recipefinder), with a keyword fallback when
 * no ANTHROPIC_API_KEY is set:
 *   1. Understand — Claude turns the sentence into a record QuerySpec. It is
 *      given the styles and owners present and the vibe-to-style map, and is
 *      told to translate feeling words into styles and loose genre words onto
 *      real Discogs genres/styles. We do NOT send the rows.
 *   2. Prefilter — a fast local pass filters and scores candidates against the
 *      spec, with owner as a hard filter alongside genre/style/mood.
 *   3. Rerank — Claude reranks the top candidates and writes a one-line reason.
 *
 * Everything runs server-side. The Anthropic key never reaches the browser.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { QuerySpec, Record as ShelfRecord, SearchResult } from "@/lib/types";
import { MOODS, presentGenres, presentOwners, presentStyles } from "@/lib/vocab";
import { getMoodIndex, type MoodIndex } from "@/lib/moods";

const MAX_QUERY_LEN = 300;
const CANDIDATE_LIMIT = 60; // records handed to the rerank step
const RESULT_LIMIT = 30; // results returned to the client
const STYLE_HINT_LIMIT = 400; // cap on styles sent to the understand step

function model(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
}

export function aiSearchEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Clamp and sanitise the incoming query (rule 4). */
export function sanitizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LEN);
}

function emptySpec(): QuerySpec {
  return { genres: [], styles: [], moods: [], owners: [], artists: [], keywords: [], excludeStyles: [] };
}

function norm(value: string): string {
  return value.toLowerCase().trim();
}

// ---- Step 1a: understand via Claude ----

/** Tolerantly pull a JSON object out of a model response. */
function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall back to the first balanced-looking {...} span.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildUnderstandSystem(records: ShelfRecord[]): string {
  const genres = presentGenres(records);
  const styles = presentStyles(records).slice(0, STYLE_HINT_LIMIT);
  const owners = presentOwners(records);

  return [
    "You translate a natural-language request about a vinyl record collection into a structured search spec.",
    "The collection is tagged with Discogs genres and styles. 'Mood' is derived at query time — never stored.",
    "",
    "Rules:",
    "- Map feeling/vibe words (e.g. 'angry', 'chill', 'music for a rainy night') to entries in MOODS when they fit.",
    "- Map loose genre words onto real GENRES or STYLES present in the collection. Prefer STYLES for specificity.",
    "- Only use genre/style/owner/mood values from the provided lists. Do not invent tags.",
    "- If the request names a collection owner, put the matching OWNER label in `owners`.",
    "- Put artist names in `artists` and any remaining free-text terms (album titles, words) in `keywords`.",
    "- Use `excludeStyles` for explicit negations (e.g. 'but no metal').",
    "- Leave arrays empty when nothing applies. Do not guess wildly; an empty spec is fine for a vague query.",
    "",
    "Respond with ONLY a JSON object (no prose, no markdown) with these array-of-string keys:",
    "genres, styles, moods, owners, artists, keywords, excludeStyles.",
    "",
    `GENRES: ${genres.join(", ") || "(none)"}`,
    `STYLES: ${styles.join(", ") || "(none)"}`,
    `OWNERS: ${owners.join(", ") || "(none)"}`,
    `MOODS: ${MOODS.join(", ")}`,
  ].join("\n");
}

async function understandWithClaude(
  client: Anthropic,
  query: string,
  records: ShelfRecord[],
): Promise<QuerySpec> {
  const response = await client.messages.create({
    model: model(),
    max_tokens: 700,
    system: buildUnderstandSystem(records),
    messages: [{ role: "user", content: query }],
  });

  const text = firstText(response);
  if (!text) return emptySpec();
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== "object") return emptySpec();
  return normalizeSpec(parsed as Partial<QuerySpec>);
}

function firstText(response: Anthropic.Message): string | null {
  for (const block of response.content) {
    if (block.type === "text") return block.text;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

function normalizeSpec(raw: Partial<QuerySpec>): QuerySpec {
  return {
    genres: asStringArray(raw.genres),
    styles: asStringArray(raw.styles),
    moods: asStringArray(raw.moods),
    owners: asStringArray(raw.owners),
    artists: asStringArray(raw.artists),
    keywords: asStringArray(raw.keywords),
    excludeStyles: asStringArray(raw.excludeStyles),
  };
}

// ---- Step 1b: keyword fallback (no API key) ----

function understandWithKeywords(query: string, records: ShelfRecord[]): QuerySpec {
  const lower = norm(query);
  const tokens = lower.split(/[^a-z0-9&/+-]+/i).filter((t) => t.length >= 2);
  const tokenSet = new Set(tokens);

  const genreSet = new Map(presentGenres(records).map((g) => [norm(g), g]));
  const styleSet = new Map(presentStyles(records).map((s) => [norm(s), s]));
  const ownerSet = new Map(presentOwners(records).map((o) => [norm(o), o]));

  const spec = emptySpec();

  // Multi-word genre/style names: substring match against the whole query.
  for (const [key, value] of genreSet) if (lower.includes(key)) spec.genres.push(value);
  for (const [key, value] of styleSet) if (lower.includes(key)) spec.styles.push(value);
  for (const [key, value] of ownerSet) if (tokenSet.has(key) || lower.includes(key)) spec.owners.push(value);
  for (const mood of MOODS) if (tokenSet.has(mood)) spec.moods.push(mood);

  // Everything else becomes a keyword to match against artist/title/label.
  spec.keywords = tokens;
  return spec;
}

// ---- Step 2: local prefilter + scoring ----

interface Scored {
  record: ShelfRecord;
  score: number;
}

function scoreRecords(spec: QuerySpec, records: ShelfRecord[], moodIndex?: MoodIndex | null): Scored[] {
  const genres = new Set(spec.genres.map(norm));
  const owners = new Set(spec.owners.map(norm));
  const artists = spec.artists.map(norm).filter(Boolean);
  const keywords = spec.keywords.map(norm).filter(Boolean);
  const excludeStyles = new Set((spec.excludeStyles ?? []).map(norm));
  const explicitStyles = spec.styles.map(norm);

  // Moods combine with AND, using the (Claude-derived, cached) per-record mood
  // index: a record must be tagged with EVERY selected mood.
  const selectedMoods = Array.from(new Set(spec.moods.map(norm)));
  const hasMoodFilter = selectedMoods.length > 0 && !!moodIndex;

  // Genre / style / artist / keyword are scored as an OR pool; moods are a
  // separate hard AND filter, applied per-record below.
  const hasContentConstraint =
    genres.size > 0 || explicitStyles.length > 0 || artists.length > 0 || keywords.length > 0;
  const hasAnyConstraint = hasContentConstraint || hasMoodFilter;

  const scored: Scored[] = [];

  for (const record of records) {
    // Hard filter: owner.
    if (owners.size > 0 && !owners.has(norm(record.owner))) continue;

    const recStyles = record.styles.map(norm);
    // Hard filter: excluded styles.
    if (excludeStyles.size > 0 && recStyles.some((s) => excludeStyles.has(s))) continue;

    // Hard filter: moods (AND) — the record must be tagged with every selected mood.
    if (hasMoodFilter) {
      const recMoods = moodIndex!.get(record);
      if (!selectedMoods.every((m) => recMoods.has(m))) continue;
    }

    if (!hasAnyConstraint) {
      // Pure browse (e.g. owner-only or empty query): keep everything, flat score.
      scored.push({ record, score: 0 });
      continue;
    }

    let score = 0;
    const recGenres = record.genres.map(norm);
    const haystack = `${norm(record.artist)} ${norm(record.title)} ${norm(record.label)}`;

    for (const g of recGenres) if (genres.has(g)) score += 1.5;
    for (const s of recStyles) if (explicitStyles.includes(s)) score += 2;
    for (const a of artists) if (haystack.includes(a)) score += 3;
    for (const k of keywords) if (haystack.includes(k)) score += 1;
    // The AND gate already passed; give mood-matched records a positive score so
    // mood-only browses surface (and keep them above pure genre noise).
    if (hasMoodFilter) score += selectedMoods.length * 1.5;

    if (score > 0) scored.push({ record, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: newer first, then title.
    const ay = a.record.year ?? 0;
    const by = b.record.year ?? 0;
    if (by !== ay) return by - ay;
    return a.record.title.localeCompare(b.record.title);
  });

  return scored;
}

// ---- Step 3: rerank via Claude ----

interface RerankItem {
  id: string;
  reason: string;
}

async function rerankWithClaude(
  client: Anthropic,
  query: string,
  candidates: ShelfRecord[],
): Promise<SearchResult[] | null> {
  // Give the model a compact view — never the whole collection.
  const compact = candidates.map((r) => ({
    id: r.id,
    artist: r.artist,
    title: r.title,
    year: r.year,
    genres: r.genres,
    styles: r.styles,
    owner: r.owner,
  }));

  const system = [
    "You are re-ranking vinyl records for a natural-language request.",
    "From the CANDIDATES, return the best matches most-relevant first.",
    "For each, write a short one-line reason (max ~16 words) tying it to the request — mention genre/style/mood/owner where relevant.",
    "Only include records that genuinely fit. Do not invent ids. Return at most 30.",
    "",
    'Respond with ONLY a JSON object (no prose, no markdown): {"results": [{"id": "<id>", "reason": "<one line>"}]}.',
  ].join("\n");

  const user = `REQUEST: ${query}\n\nCANDIDATES (JSON):\n${JSON.stringify(compact)}`;

  const response = await client.messages.create({
    model: model(),
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = firstText(response);
  if (!text) return null;

  const parsed = extractJsonObject(text) as { results?: RerankItem[] } | null;
  const items: RerankItem[] = parsed && Array.isArray(parsed.results) ? parsed.results : [];

  const byId = new Map(candidates.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== "string") continue;
    if (seen.has(item.id)) continue;
    const record = byId.get(item.id);
    if (!record) continue;
    seen.add(item.id);
    results.push({ record, reason: sanitizeReason(item.reason) });
    if (results.length >= RESULT_LIMIT) break;
  }
  return results;
}

function sanitizeReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return reason.replace(/\s+/g, " ").trim().slice(0, 160);
}

// ---- Local reason (fallback / when rerank unavailable) ----

function localReason(record: ShelfRecord, spec: QuerySpec): string {
  const tags = [...record.styles.slice(0, 2), ...record.genres.slice(0, 1)];
  const bits: string[] = [];
  if (tags.length) bits.push(tags.join(" · "));
  if (spec.owners.length) bits.push(record.owner);
  return bits.join(" — ") || `${record.genres[0] ?? "Record"} from ${record.owner}`;
}

// ---- Orchestration ----

export interface SearchOptions {
  /** Restrict to these owner labels (from the owner facet), applied as a hard filter. */
  owners?: string[];
  /** Restrict to these genres (facet). */
  genres?: string[];
  /** Restrict to these styles (facet). */
  styles?: string[];
  /** Restrict to these moods (facet). */
  moods?: string[];
}

/** Merge explicit facet selections into a spec derived from the query. */
function mergeFacets(spec: QuerySpec, options: SearchOptions): QuerySpec {
  const uniq = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));
  return {
    ...spec,
    owners: uniq(spec.owners, options.owners ?? []),
    genres: uniq(spec.genres, options.genres ?? []),
    styles: uniq(spec.styles, options.styles ?? []),
    moods: uniq(spec.moods, options.moods ?? []),
  };
}

export interface SearchOutcome {
  results: SearchResult[];
  spec: QuerySpec;
  reranked: boolean;
}

export async function searchRecords(
  rawQuery: string,
  records: ShelfRecord[],
  options: SearchOptions = {},
): Promise<SearchOutcome> {
  const query = sanitizeQuery(rawQuery);
  const hasFacets = Boolean(
    options.owners?.length || options.genres?.length || options.styles?.length || options.moods?.length,
  );

  // Understand.
  let spec: QuerySpec;
  let client: Anthropic | null = null;
  if (aiSearchEnabled() && query) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    try {
      spec = await understandWithClaude(client, query, records);
    } catch {
      spec = understandWithKeywords(query, records);
      client = null; // fall through to non-AI path for reasons
    }
  } else {
    spec = query ? understandWithKeywords(query, records) : emptySpec();
  }

  spec = mergeFacets(spec, options);

  // Nothing to search on at all → return an empty, deterministic result.
  if (!query && !hasFacets) {
    return { results: [], spec, reranked: false };
  }

  // Prefilter + score. When moods are in play, classify (or reuse cached) moods
  // for the collection so the AND filter uses Claude's per-record tags.
  const moodIndex = spec.moods.length > 0 ? await getMoodIndex(records) : null;
  const scored = scoreRecords(spec, records, moodIndex);
  const candidates = scored.slice(0, CANDIDATE_LIMIT).map((s) => s.record);

  if (candidates.length === 0) {
    return { results: [], spec, reranked: false };
  }

  // Rerank (only worthwhile when there's a natural-language query to interpret).
  if (client && query) {
    try {
      const reranked = await rerankWithClaude(client, query, candidates);
      if (reranked && reranked.length > 0) {
        return { results: reranked, spec, reranked: true };
      }
    } catch {
      // fall through to local ordering
    }
  }

  const results = candidates
    .slice(0, RESULT_LIMIT)
    .map((record) => ({ record, reason: localReason(record, spec) }));
  return { results, spec, reranked: false };
}

/**
 * Similar-by-style: records that share one or more STYLES with the seed, or are
 * by the same artist. A shared broad Discogs GENRE (e.g. "Rock") does NOT qualify
 * a record on its own, since that umbrella lumps indie rock in with doo-wop,
 * metal, and punk. Genre overlap is used only as a minor tiebreak.
 */
export function similarRecords(seed: ShelfRecord, records: ShelfRecord[], limit = 20): SearchResult[] {
  const seedStyles = new Set(seed.styles.map(norm));
  const seedGenres = new Set(seed.genres.map(norm));
  const seedArtist = norm(seed.artist);

  const scored: Scored[] = [];
  for (const record of records) {
    if (record.id === seed.id && record.owner === seed.owner) continue;

    let sharedStyles = 0;
    for (const s of record.styles) if (seedStyles.has(norm(s))) sharedStyles += 1;
    const sameArtist = norm(record.artist) === seedArtist;

    // Qualify only on a shared style or same artist. Broad genre alone is not enough.
    if (sharedStyles === 0 && !sameArtist) continue;

    let score = sharedStyles * 2;
    if (sameArtist) score += 1.5;

    let sharedGenres = 0;
    for (const g of record.genres) if (seedGenres.has(norm(g))) sharedGenres += 1;
    score += sharedGenres * 0.25; // minor tiebreak only

    scored.push({ record, score });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ay = a.record.year ?? 0;
    const by = b.record.year ?? 0;
    if (by !== ay) return by - ay;
    return a.record.title.localeCompare(b.record.title);
  });

  return scored.slice(0, limit).map(({ record }) => ({
    record,
    reason: sharedTags(record, seed),
  }));
}

function sharedTags(record: ShelfRecord, seed: ShelfRecord): string {
  const seedStyles = new Set(seed.styles.map(norm));
  const shared = record.styles.filter((s) => seedStyles.has(norm(s))).slice(0, 3);
  if (shared.length) return `Shares ${shared.join(" · ")}`;
  if (norm(record.artist) === norm(seed.artist)) return "Same artist";
  const seedGenres = new Set(seed.genres.map(norm));
  const sharedG = record.genres.filter((g) => seedGenres.has(norm(g))).slice(0, 2);
  if (sharedG.length) return `Shares ${sharedG.join(" · ")}`;
  return `Also ${record.owner}'s`;
}
