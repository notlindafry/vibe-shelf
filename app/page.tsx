"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MultiSelect from "@/app/components/MultiSelect";
import RecordCard from "@/app/components/RecordCard";
import {
  addBookmark,
  fetchBookmarks,
  fetchForgotten,
  fetchMeta,
  fetchPlays,
  logout,
  logPlay,
  moreLikeThis,
  removeBookmark,
  search,
  surpriseMe,
} from "@/lib/api";
import type {
  Bookmark,
  ForgottenPick,
  MetaResponse,
  PlayedRecord,
  Record as ShelfRecord,
  SearchResult,
} from "@/lib/types";

type View =
  | { kind: "idle" }
  | { kind: "search" }
  | { kind: "surprise" }
  | { kind: "similar"; seed: ShelfRecord }
  | { kind: "saved" }
  | { kind: "forgotten" };

/**
 * A restorable snapshot of a results view. We push one before navigating into
 * "more like this" so "Back" returns to exactly what was on screen — including
 * chained similar views — instead of dumping you on the blank search page.
 */
type ResultsSnapshot = {
  results: SearchResult[];
  reranked: boolean;
  songMatch: boolean;
  partial: boolean;
  view: View;
};

export default function CataloguePage() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [styles, setStyles] = useState<string[]>([]);
  const [moods, setMoods] = useState<string[]>([]);

  const [results, setResults] = useState<SearchResult[]>([]);
  const [reranked, setReranked] = useState(false);
  const [songMatch, setSongMatch] = useState(false);
  const [partial, setPartial] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "idle" });

  // Snapshots of prior results views, so "Back" out of a "more like this" view
  // restores what you were looking at rather than resetting to the search page.
  const [history, setHistory] = useState<ResultsSnapshot[]>([]);

  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [savedList, setSavedList] = useState<Bookmark[]>([]);

  const [playCounts, setPlayCounts] = useState<Record<string, number>>({});
  const [mostPlayed, setMostPlayed] = useState<PlayedRecord[]>([]);
  const [forgotten, setForgotten] = useState<ForgottenPick | null>(null);
  const [forgottenLoading, setForgottenLoading] = useState(false);

  // Bump this to force a search (e.g. on Enter / Search click) without needing a
  // dependency on the query string itself.
  const [runToken, setRunToken] = useState(0);
  const firstRun = useRef(true);

  useEffect(() => {
    fetchMeta()
      .then(setMeta)
      .catch((err) => setMetaError(err instanceof Error ? err.message : "Failed to load catalogue"));
  }, []);

  // Load the shared list on mount. Owner-gated server-side; ignore 403/503 quietly.
  const loadBookmarks = useCallback(async () => {
    try {
      const list = await fetchBookmarks();
      setSavedList(list);
      setBookmarkedIds(new Set(list.map((b) => b.id)));
    } catch {
      // Feature off or not permitted; leave state empty.
    }
  }, []);
  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  // Load play counts on mount so cards can show them. Ignore errors quietly
  // (feature off / not permitted).
  const loadPlays = useCallback(async () => {
    try {
      const { counts, mostPlayed: top } = await fetchPlays();
      setPlayCounts(counts);
      setMostPlayed(top);
    } catch {
      // leave state empty
    }
  }, []);
  useEffect(() => {
    void loadPlays();
  }, [loadPlays]);

  const hasFacets = owners.length + genres.length + styles.length + moods.length > 0;
  const trimmedQuery = query.trim();

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await search({ query: trimmedQuery, owners, genres, styles, moods });
      setResults(res.results);
      setReranked(res.reranked);
      setSongMatch(res.songMatch ?? false);
      setPartial(res.partial);
      setView({ kind: "search" });
      setHistory([]); // fresh search: nothing to go "Back" to
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [trimmedQuery, owners, genres, styles, moods]);

  // Re-run when facets change or a run is explicitly requested. Skip the initial
  // mount and any state where there's nothing to search.
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (!trimmedQuery && !hasFacets) {
      setResults([]);
      setView({ kind: "idle" });
      setHistory([]);
      return;
    }
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owners, genres, styles, moods, runToken]);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setRunToken((t) => t + 1);
  }

  async function onSurprise() {
    setLoading(true);
    setError(null);
    try {
      const { result } = await surpriseMe({ owners, genres, styles, moods });
      setResults(result ? [result] : []);
      setReranked(false);
      setSongMatch(false);
      setView({ kind: "surprise" });
      setHistory([]); // a new pick is its own root
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not pick a record");
    } finally {
      setLoading(false);
    }
  }

  async function onSimilar(record: ShelfRecord) {
    // Remember what's on screen now so "Back" can restore it. Captured before
    // the await so it reflects the view we're leaving, not the one we land on.
    const from: ResultsSnapshot = { results, reranked, songMatch, partial, view };
    setLoading(true);
    setError(null);
    try {
      const { results: similar } = await moreLikeThis(record.id, record.owner);
      setHistory((h) => [...h, from]);
      setResults(similar);
      setReranked(false);
      setSongMatch(false);
      setView({ kind: "similar", seed: record });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not find similar records");
    } finally {
      setLoading(false);
    }
  }

  // Restore the previous results view (one step up the "more like this" chain).
  function goBack() {
    const prev = history[history.length - 1];
    if (!prev) {
      clearAll();
      return;
    }
    setResults(prev.results);
    setReranked(prev.reranked);
    setSongMatch(prev.songMatch);
    setPartial(prev.partial);
    setView(prev.view);
    setError(null);
    setHistory((h) => h.slice(0, -1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function onToggleBookmark(record: ShelfRecord) {
    const has = bookmarkedIds.has(record.id);
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (has) next.delete(record.id);
      else next.add(record.id);
      return next;
    });
    setSavedList((prev) =>
      has
        ? prev.filter((b) => b.id !== record.id)
        : [{ ...record, addedAt: Date.now() }, ...prev],
    );
    try {
      if (has) await removeBookmark(record.id);
      else await addBookmark(record);
    } catch {
      await loadBookmarks(); // reconcile with server truth on failure
    }
  }

  async function onLogPlay(record: ShelfRecord) {
    // Optimistic: bump the local count, then reconcile with the server's count.
    setPlayCounts((prev) => ({ ...prev, [record.id]: (prev[record.id] ?? 0) + 1 }));
    try {
      const count = await logPlay(record.id);
      setPlayCounts((prev) => ({ ...prev, [record.id]: count }));
    } catch {
      await loadPlays(); // reconcile with server truth on failure
    }
  }

  async function openForgotten(force = false) {
    setView({ kind: "forgotten" });
    setHistory([]);
    setForgottenLoading(true);
    void loadPlays();
    try {
      setForgotten(await fetchForgotten(force));
    } catch {
      setForgotten(null);
    } finally {
      setForgottenLoading(false);
    }
  }

  async function onLogout() {
    await logout();
    window.location.assign("/login");
  }

  function clearAll() {
    setOwners([]);
    setGenres([]);
    setStyles([]);
    setMoods([]);
    setQuery("");
    setResults([]);
    setView({ kind: "idle" });
    setHistory([]);
  }

  const aiEnabled = meta?.features.aiSearch ?? false;
  // Only owners may log plays (writes are owner-gated server-side); guests read only.
  const canWrite = Boolean(meta) && !meta?.features.guest;
  const logPlayHandler = canWrite ? onLogPlay : undefined;

  return (
    <main className="page">
      <div className="topbar">
        <div>
          <div className="wordmark">
            vibe<span className="dash">-</span>shelf
          </div>
        </div>
        <div className="topbar-right">
          {meta && (
            <span className="count">
              {meta.total} records
              {meta.owners.length > 0 && ` · ${meta.owners.length} shelves`}
            </span>
          )}
          {meta?.features.guest && <span className="badge">guest</span>}
          <button type="button" className="btn-ghost" onClick={() => openForgotten()}>
            Forgotten
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={async () => {
              await loadBookmarks();
              setView({ kind: "saved" });
              setHistory([]);
            }}
          >
            Saved{bookmarkedIds.size ? ` (${bookmarkedIds.size})` : ""}
          </button>
          <button type="button" className="btn-ghost" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>
      <p className="tagline">
        Search a shared vinyl shelf by vibe, genre, style, or owner.
      </p>

      <form className="searchbar" onSubmit={onSubmit}>
        <input
          type="text"
          value={query}
          maxLength={300}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            aiEnabled
              ? "e.g. angry music for a workout, or chill sunday jazz"
              : "e.g. techno, or a label / artist name"
          }
          aria-label="Search records"
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>
          Search
        </button>
        {meta?.features.random && (
          <button type="button" className="btn" onClick={onSurprise} disabled={loading}>
            Surprise me
          </button>
        )}
      </form>

      <div className="facets">
        <MultiSelect label="Owner" options={meta?.owners ?? []} selected={owners} onChange={setOwners} />
        <MultiSelect label="Genre" options={meta?.genres ?? []} selected={genres} onChange={setGenres} />
        <MultiSelect label="Style" options={meta?.styles ?? []} selected={styles} onChange={setStyles} />
        <MultiSelect label="Mood" options={meta?.moods ?? []} selected={moods} onChange={setMoods} />
        {(hasFacets || trimmedQuery) && (
          <button type="button" className="btn-ghost" onClick={clearAll}>
            Clear all
          </button>
        )}
      </div>

      <SelectedChips
        owners={owners}
        genres={genres}
        styles={styles}
        moods={moods}
        onRemove={(kind, value) => {
          if (kind === "owner") setOwners((s) => s.filter((v) => v !== value));
          if (kind === "genre") setGenres((s) => s.filter((v) => v !== value));
          if (kind === "style") setStyles((s) => s.filter((v) => v !== value));
          if (kind === "mood") setMoods((s) => s.filter((v) => v !== value));
        }}
      />

      <div className="statusline">
        {loading && (
          <>
            <span className="spin" aria-hidden /> Searching…
          </>
        )}
        {!loading && error && <span className="error">{error}</span>}
        {!loading && metaError && <span className="error">{metaError}</span>}
        {!loading && !error && partial && (
          <span className="notice">Some records could not be loaded.</span>
        )}
        {!loading && !error && view.kind === "search" && (
          <>
            <span>
              {results.length} record{results.length === 1 ? "" : "s"}
            </span>
            {reranked && <span className="badge ai">AI-ranked</span>}
            {songMatch && <span className="badge">song match</span>}
          </>
        )}
        {!loading && !error && view.kind === "surprise" && <span>Your pick</span>}
        {!loading && !error && view.kind === "similar" && (
          <span>
            Similar to <strong>{view.seed.artist}</strong> — {view.seed.title}
          </span>
        )}
        {!loading && view.kind === "similar" && (
          <button type="button" className="linkish" onClick={goBack}>
            Back
          </button>
        )}
        {!loading && !error && view.kind === "saved" && (
          <>
            <span>
              {savedList.length} saved record{savedList.length === 1 ? "" : "s"}
            </span>
            <button type="button" className="linkish" onClick={() => void loadBookmarks()}>
              Refresh
            </button>
          </>
        )}
        {view.kind === "forgotten" && (
          <>
            <span>Forgotten shelf — today&rsquo;s pick</span>
            {!forgottenLoading && (
              <button type="button" className="linkish" onClick={() => void openForgotten(true)}>
                Another
              </button>
            )}
          </>
        )}
      </div>

      {!loading && view.kind === "idle" && !error && (
        <div className="empty">
          {aiEnabled ? (
            <p className="hint">
              Try a vibe — <code>angry music</code>, <code>rainy day jazz</code>,{" "}
              <code>something to dance to</code> — or pick a genre, style, mood, or owner above.
            </p>
          ) : (
            <p className="hint">
              Search by genre, style, artist, or label — or pick a facet above.
            </p>
          )}
          <p className="hint">
            Looking for a song? Ask <code>which record is “Africa” on?</code> or{" "}
            <code>song: blue in green</code>.
          </p>
        </div>
      )}

      {!loading &&
        view.kind !== "idle" &&
        view.kind !== "saved" &&
        view.kind !== "forgotten" &&
        results.length === 0 &&
        !error && (
          <div className="empty">No records matched. Try loosening your filters.</div>
        )}

      {view.kind === "saved" && (
        <div className="grid">
          {savedList.length === 0 && <div className="empty">No saved records yet.</div>}
          {savedList.map((b) => (
            <RecordCard
              key={`saved:${b.id}`}
              record={b}
              isBookmarked={bookmarkedIds.has(b.id)}
              onToggleBookmark={onToggleBookmark}
              playCount={playCounts[b.id]}
              onLogPlay={logPlayHandler}
            />
          ))}
        </div>
      )}

      {view.kind === "forgotten" && (
        <div>
          {forgottenLoading && (
            <div className="empty">Finding a record you&rsquo;ve overlooked…</div>
          )}
          {!forgottenLoading && forgotten && (
            <>
              <p className="hint">
                {forgotten.blurb ||
                  "You haven't logged a play for this one — maybe it's time to spin it."}
              </p>
              <div className="grid">
                <RecordCard
                  record={forgotten.record}
                  isBookmarked={bookmarkedIds.has(forgotten.record.id)}
                  onToggleBookmark={onToggleBookmark}
                  playCount={playCounts[forgotten.record.id]}
                  onLogPlay={logPlayHandler}
                />
              </div>
            </>
          )}
          {!forgottenLoading && !forgotten && (
            <div className="empty">No records to surface yet.</div>
          )}
          {mostPlayed.length > 0 && (
            <>
              <div className="section-title">Most played</div>
              <div className="grid">
                {mostPlayed.map((p) => (
                  <RecordCard
                    key={`played:${p.record.id}`}
                    record={p.record}
                    isBookmarked={bookmarkedIds.has(p.record.id)}
                    onToggleBookmark={onToggleBookmark}
                    playCount={p.count}
                    onLogPlay={logPlayHandler}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {view.kind !== "saved" && view.kind !== "forgotten" && results.length > 0 && (
        <div className="grid">
          {results.map((r, i) => (
            <RecordCard
              key={`${r.record.owner}:${r.record.id}:${i}`}
              record={r.record}
              reason={r.reason}
              onSimilar={meta?.features.similar ? onSimilar : undefined}
              isBookmarked={bookmarkedIds.has(r.record.id)}
              onToggleBookmark={onToggleBookmark}
              playCount={playCounts[r.record.id]}
              onLogPlay={logPlayHandler}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function SelectedChips({
  owners,
  genres,
  styles,
  moods,
  onRemove,
}: {
  owners: string[];
  genres: string[];
  styles: string[];
  moods: string[];
  onRemove: (kind: "owner" | "genre" | "style" | "mood", value: string) => void;
}) {
  const total = owners.length + genres.length + styles.length + moods.length;
  if (total === 0) return null;
  return (
    <div className="chips">
      {owners.map((v) => (
        <Chip key={`o-${v}`} className="owner" value={v} onRemove={() => onRemove("owner", v)} />
      ))}
      {moods.map((v) => (
        <Chip key={`m-${v}`} className="mood" value={v} onRemove={() => onRemove("mood", v)} />
      ))}
      {genres.map((v) => (
        <Chip key={`g-${v}`} value={v} onRemove={() => onRemove("genre", v)} />
      ))}
      {styles.map((v) => (
        <Chip key={`s-${v}`} value={v} onRemove={() => onRemove("style", v)} />
      ))}
    </div>
  );
}

function Chip({
  value,
  className,
  onRemove,
}: {
  value: string;
  className?: string;
  onRemove: () => void;
}) {
  return (
    <span className={`chip${className ? ` ${className}` : ""}`}>
      {value}
      <button type="button" aria-label={`Remove ${value}`} onClick={onRemove}>
        ×
      </button>
    </span>
  );
}
