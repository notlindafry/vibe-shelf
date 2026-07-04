/**
 * Record vocabulary: the facets present in the merged collection and the
 * vibe-to-style ("mood") map.
 *
 * Discogs styles are dynamic, so genres/styles/owners are computed from the
 * data (not hard-coded) — that keeps facets and the model's vocabulary aligned
 * with real tags. "Mood" is a subjective heuristic layer defined once here and
 * edited by the owner: feeling words map to sets of Discogs styles. It is a
 * starting point, not ground truth — broad tags like plain "Rock" span gentle
 * to brutal.
 */

import type { Record as ShelfRecord } from "@/lib/types";

/**
 * Feeling words -> Discogs styles. Style names are matched case-insensitively
 * against the styles present in the collection, so only moods that actually
 * resolve to present styles are surfaced as facets.
 */
export const VIBE_TO_STYLE: Readonly<Record<string, string[]>> = {
  angry: ["Industrial", "Heavy Metal", "Death Metal", "Thrash", "Hardcore", "Punk", "Black Metal", "Noise", "Grindcore", "Metalcore"],
  aggressive: ["Thrash", "Hardcore", "Death Metal", "Grindcore", "Punk", "Industrial", "Metalcore", "Powerviolence", "Speed Metal"],
  chill: ["Ambient", "Downtempo", "Trip Hop", "Deep House", "Lounge", "New Age", "Balearic", "Chillwave"],
  mellow: ["Folk", "Soft Rock", "Bossa Nova", "Downtempo", "Lo-Fi", "Jazz", "Ambient", "Acoustic"],
  happy: ["Disco", "Funk", "Soul", "Pop Rock", "Synth-pop", "House", "Boogie", "Afrobeat", "Highlife", "Ska"],
  upbeat: ["Disco", "Funk", "House", "Synth-pop", "Boogie", "Nu-Disco", "Ska", "Pop Rock"],
  sad: ["Slowcore", "Sadcore", "Folk", "Singer/Songwriter", "Dream Pop", "Shoegaze", "Doom Metal", "Ambient", "Modern Classical"],
  melancholic: ["Slowcore", "Dream Pop", "Shoegaze", "Folk", "Modern Classical", "Post-Rock", "Ambient", "Ethereal"],
  energetic: ["Techno", "Drum n Bass", "Jungle", "Hardcore", "Breakbeat", "Big Beat", "Punk", "Electro", "Happy Hardcore"],
  dreamy: ["Dream Pop", "Shoegaze", "Ambient", "Slowcore", "Psychedelic Rock", "Space Rock", "Ethereal", "Neo-Psychedelia"],
  dark: ["Darkwave", "Post-Punk", "Industrial", "Gothic Rock", "Doom Metal", "Black Metal", "Cold Wave", "EBM", "Death Rock"],
  moody: ["Post-Punk", "Darkwave", "Trip Hop", "Downtempo", "Gothic Rock", "Doom Metal", "Cold Wave", "Ambient"],
  romantic: ["Soul", "Rhythm & Blues", "Bossa Nova", "Ballad", "Smooth Jazz", "Quiet Storm", "Doo Wop"],
  focus: ["Ambient", "Modern Classical", "Minimal", "Drone", "Downtempo", "IDM", "New Age"],
  party: ["House", "Disco", "Techno", "Funk", "Boogie", "Garage House", "Electro", "Nu-Disco", "Dancehall"],
  dance: ["House", "Disco", "Techno", "Deep House", "Garage House", "Electro", "Nu-Disco", "UK Garage", "Tech House"],
  groovy: ["Funk", "Soul", "Disco", "Jazz-Funk", "Boogie", "Acid Jazz", "Afrobeat", "Rare Groove"],
  funky: ["Funk", "Jazz-Funk", "Boogie", "Disco", "Acid Jazz", "P.Funk", "Rare Groove"],
  nostalgic: ["Synth-pop", "New Wave", "Classic Rock", "Motown", "Doo Wop", "City Pop", "Yé-Yé"],
  psychedelic: ["Psychedelic Rock", "Krautrock", "Acid House", "Space Rock", "Neo-Psychedelia", "Dub", "Acid Rock"],
  trippy: ["Psychedelic Rock", "Dub", "Space Rock", "Acid House", "IDM", "Krautrock", "Ambient"],
  epic: ["Modern Classical", "Post-Rock", "Soundtrack", "Symphonic Rock", "Ambient", "Score", "Prog Rock"],
  cinematic: ["Soundtrack", "Modern Classical", "Post-Rock", "Ambient", "Score", "Library Music", "Symphonic"],
  relaxed: ["Ambient", "Downtempo", "Bossa Nova", "Soft Rock", "Lounge", "Jazz", "Folk", "New Age"],
};

export const MOODS: string[] = Object.keys(VIBE_TO_STYLE);

function norm(value: string): string {
  return value.toLowerCase().trim();
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/** Genres present in the collection, unique and sorted. */
export function presentGenres(records: ShelfRecord[]): string[] {
  return sortedUnique(records.flatMap((r) => r.genres));
}

/** Styles present in the collection, unique and sorted. */
export function presentStyles(records: ShelfRecord[]): string[] {
  return sortedUnique(records.flatMap((r) => r.styles));
}

/** Owner labels present in the collection, unique and sorted. */
export function presentOwners(records: ShelfRecord[]): string[] {
  return sortedUnique(records.map((r) => r.owner));
}

/**
 * Expand mood words to the set of styles they map to, restricted to styles that
 * actually appear in the collection (case-insensitive). Returns canonical
 * present-style names so downstream matching is exact.
 */
export function expandMoodsToStyles(moods: string[], records: ShelfRecord[]): string[] {
  const presentByLower = new Map<string, string>();
  for (const style of presentStyles(records)) presentByLower.set(norm(style), style);

  const out = new Set<string>();
  for (const mood of moods) {
    const styles = VIBE_TO_STYLE[norm(mood)];
    if (!styles) continue;
    for (const style of styles) {
      const canonical = presentByLower.get(norm(style));
      if (canonical) out.add(canonical);
    }
  }
  return Array.from(out);
}

/** Moods that resolve to at least one style present in the collection. */
export function availableMoods(records: ShelfRecord[]): string[] {
  return MOODS.filter((mood) => expandMoodsToStyles([mood], records).length > 0);
}
