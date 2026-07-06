/**
 * Forgotten Shelf (feature 4b): a daily "record you haven't thought about" pick
 * with a short Claude blurb, biased toward genuinely neglected records using the
 * play log.
 *
 * Selection: records never logged as played are maximally forgotten; among logged
 * ones, least-recently-played first. We pick randomly among the most-neglected
 * few so the pick varies day to day while the pool is stable. The pick is cached
 * under a date-stamped key so it is stable across reloads and Claude runs at most
 * once per day.
 *
 * Fails gracefully: without Redis it selects without a cache; without an Anthropic
 * key (or on a Claude error) it returns the record with an empty blurb.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getCollection } from "@/lib/discogs";
import { lastPlayedTimes } from "@/lib/plays";
import { isRedisConfigured, redis } from "@/lib/redis";
import type { ForgottenPick, Record as ShelfRecord } from "@/lib/types";

const CANDIDATE_POOL = 12; // randomise among the N most-neglected to avoid repeats

function model(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
}

function todayKey(): string {
  const d = new Date();
  const iso =
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`;
  return `vs:forgotten:${iso}`;
}

/** Dedupe by release id — the same release can sit on both shelves. */
function dedupeById(records: ShelfRecord[]): ShelfRecord[] {
  const seen = new Set<string>();
  const out: ShelfRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function selectNeglected(records: ShelfRecord[], lastPlayed: Map<string, number>): ShelfRecord | null {
  if (records.length === 0) return null;
  // Never-played (absent → 0) sort first; among played, oldest last-play first.
  const ranked = records
    .map((r) => ({ r, lastAt: lastPlayed.get(r.id) ?? 0 }))
    .sort((a, b) => a.lastAt - b.lastAt);
  const pool = ranked.slice(0, Math.min(ranked.length, CANDIDATE_POOL));
  return pool[Math.floor(Math.random() * pool.length)].r;
}

async function generateBlurb(record: ShelfRecord): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = [
    "You nudge someone to revisit a record from their own vinyl shelf.",
    "Write ONE warm, specific sentence (max ~30 words). No hype, no emoji, no markdown, no quotes.",
    "Ground it in the metadata (artist, era, genre/style); do not invent facts you are not given.",
  ].join(" ");
  const user = JSON.stringify({
    artist: record.artist,
    title: record.title,
    year: record.year,
    genres: record.genres,
    styles: record.styles,
  });
  const response = await client.messages.create({
    model: model(),
    max_tokens: 120,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = response.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text : "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * The pick for today. Served from the daily cache when present and still valid;
 * `force` (the Refresh action) skips the cache and rolls a fresh pick. A cached
 * pick that has since been logged as played is discarded and re-selected, so a
 * record you just marked played stops being "forgotten". Null if the shelf is
 * empty.
 */
export async function getForgottenPick(options: { force?: boolean } = {}): Promise<ForgottenPick | null> {
  const key = todayKey();

  // Play recency drives both cache validation and selection, so read it first.
  let lastPlayed = new Map<string, number>();
  try {
    lastPlayed = await lastPlayedTimes();
  } catch (err) {
    console.error(
      "[forgotten] play read failed; treating all as unplayed:",
      err instanceof Error ? err.message : err,
    );
  }

  if (!options.force && isRedisConfigured()) {
    try {
      const cached = await redis().get<ForgottenPick>(key);
      if (cached && cached.record && typeof cached.record.id === "string") {
        // Keep the cached pick only if it hasn't been played since it was chosen.
        const playedAt = lastPlayed.get(cached.record.id) ?? 0;
        if (playedAt < cached.generatedAt) return cached;
      }
    } catch (err) {
      console.error("[forgotten] cache read failed:", err instanceof Error ? err.message : err);
    }
  }

  const { records } = await getCollection();
  const record = selectNeglected(dedupeById(records), lastPlayed);
  if (!record) return null;

  let blurb = "";
  try {
    blurb = await generateBlurb(record);
  } catch (err) {
    console.error("[forgotten] blurb generation failed:", err instanceof Error ? err.message : err);
  }

  const pick: ForgottenPick = { record, blurb, generatedAt: Date.now() };

  if (isRedisConfigured()) {
    try {
      // The date-stamped key rotates the pick daily; the TTL is just cleanup.
      await redis().set(key, pick, { ex: 24 * 60 * 60 });
    } catch (err) {
      console.error("[forgotten] cache write failed:", err instanceof Error ? err.message : err);
    }
  }

  return pick;
}
