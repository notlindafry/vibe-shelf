/**
 * Play log data layer (feature 4a). Two Redis sorted sets, aggregate across the
 * household — both partners share the owner login, so plays are not attributed
 * per person:
 *   - vs:play:last  — member: release id, score: last-played epoch ms. ZADD
 *     overwrites, so it always holds the latest play time per record. ZRANGE
 *     ascending gives least-recently-played first (the Forgotten Shelf signal).
 *   - vs:play:count — member: release id, score: play count, bumped with ZINCRBY.
 *
 * Reads return empty when Redis is unconfigured; Redis errors propagate so the
 * caller can decide (routes translate them into generic errors, the Forgotten
 * Shelf treats them as "all unplayed").
 */

import { isRedisConfigured, redis } from "@/lib/redis";

const LAST_KEY = "vs:play:last";
const COUNT_KEY = "vs:play:count";

/** Record a play: set last-played to now and increment the count. Returns the new count. */
export async function logPlay(id: string): Promise<number> {
  const now = Date.now();
  await redis().zadd(LAST_KEY, { score: now, member: id });
  const count = await redis().zincrby(COUNT_KEY, 1, id);
  return typeof count === "number" ? count : Number(count) || 0;
}

/** Parse an @upstash/redis `withScores` result ([member, score, ...]) into pairs. */
function toPairs(raw: unknown): Array<{ id: string; score: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; score: number }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const id = String(raw[i]);
    const score = Number(raw[i + 1]);
    if (id && Number.isFinite(score)) out.push({ id, score });
  }
  return out;
}

/** id → play count for every played record. Empty when Redis is unconfigured. */
export async function playCounts(): Promise<Map<string, number>> {
  if (!isRedisConfigured()) return new Map();
  const raw = await redis().zrange(COUNT_KEY, 0, -1, { withScores: true });
  return new Map(toPairs(raw).map(({ id, score }) => [id, score]));
}

/** id → last-played epoch ms. Never-played ids are absent. Empty when unconfigured. */
export async function lastPlayedTimes(): Promise<Map<string, number>> {
  if (!isRedisConfigured()) return new Map();
  const raw = await redis().zrange(LAST_KEY, 0, -1, { withScores: true });
  return new Map(toPairs(raw).map(({ id, score }) => [id, score]));
}

/** Most-played ids first, with counts. Empty when Redis is unconfigured. */
export async function mostPlayedIds(limit: number): Promise<Array<{ id: string; count: number }>> {
  if (!isRedisConfigured()) return [];
  const raw = await redis().zrange(COUNT_KEY, 0, Math.max(0, limit - 1), {
    rev: true,
    withScores: true,
  });
  return toPairs(raw).map(({ id, score }) => ({ id, count: score }));
}
