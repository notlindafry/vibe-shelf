"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addWishlist,
  fetchWishlist,
  removeWishlist,
  setWishlistStatus,
  spotifySearch,
} from "@/lib/api";
import type { SpotifyAlbum, WishlistEntry, WishlistStatus } from "@/lib/types";
import WishlistCard from "@/app/components/WishlistCard";

type Filter = "all" | "vetted" | "unvetted";

/**
 * The maybe-vibes tab: a Spotify-search add flow (two one-tap Vetted/Unvetted
 * buttons per result, no default status; dedupes against the list) and the shared
 * list itself (default All, instant client-side status filter, per-card status
 * toggle and remove). Owner-only mutations are also enforced server-side; guests
 * get a read-only view with no add section or per-card controls.
 */
export default function WishlistPanel({
  canWrite,
  configured,
}: {
  canWrite: boolean;
  configured: boolean;
}) {
  const [entries, setEntries] = useState<WishlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all"); // viewing default is All

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SpotifyAlbum[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      setEntries(await fetchWishlist());
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Could not load the wishlist.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!configured) {
      setLoading(false);
      return;
    }
    void loadList();
  }, [configured, loadList]);

  const byId = useMemo(() => {
    const m = new Map<string, WishlistEntry>();
    for (const e of entries) m.set(e.id, e);
    return m;
  }, [entries]);

  const counts = useMemo(
    () => ({
      all: entries.length,
      vetted: entries.filter((e) => e.status === "vetted").length,
      unvetted: entries.filter((e) => e.status === "unvetted").length,
    }),
    [entries],
  );

  const filtered = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.status === filter)),
    [entries, filter],
  );

  function scrollToEntry(id: string) {
    document.getElementById(`wishlist-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    setNotice(null);
    try {
      setResults(await spotifySearch(q));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Could not search Spotify.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function onAdd(album: SpotifyAlbum, status: WishlistStatus) {
    // Optimistic insert; reconcile with the server entry (or roll back on failure).
    const optimistic: WishlistEntry = { ...album, status, addedAt: Date.now() };
    setEntries((prev) => (prev.some((e) => e.id === album.id) ? prev : [optimistic, ...prev]));
    setNotice(`Added “${album.name}” as ${status}.`);
    setSearchError(null);
    try {
      const { duplicate, entry } = await addWishlist(album, status);
      setEntries((prev) =>
        [entry, ...prev.filter((e) => e.id !== entry.id)].sort((a, b) => b.addedAt - a.addedAt),
      );
      if (duplicate) setNotice(`“${entry.name}” is already on your list.`);
    } catch (err) {
      setNotice(null);
      setSearchError(err instanceof Error ? err.message : "Could not add to the wishlist.");
      await loadList(); // reconcile with server truth
    }
  }

  async function onToggle(entry: WishlistEntry) {
    const next: WishlistStatus = entry.status === "vetted" ? "unvetted" : "vetted";
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: next } : e)));
    try {
      await setWishlistStatus(entry.id, next);
    } catch {
      await loadList(); // reconcile with server truth on failure
    }
  }

  async function onRemove(entry: WishlistEntry) {
    setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    try {
      await removeWishlist(entry.id);
    } catch {
      await loadList(); // reconcile with server truth on failure
    }
  }

  if (!configured) {
    return (
      <div className="empty">
        maybe-vibes storage isn&rsquo;t configured, so the wishlist is unavailable right now.
      </div>
    );
  }

  return (
    <section className="wishlist" aria-label="maybe-vibes wishlist">
      {canWrite && (
        <form className="wishlist-search" onSubmit={onSearch}>
          <input
            className="searchpanel-input"
            type="text"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Spotify for an album to shortlist…"
            aria-label="Search Spotify albums"
          />
          <button type="submit" className="btn btn-primary" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </button>
        </form>
      )}

      {notice && <p className="wishlist-notice">{notice}</p>}
      {searchError && <p className="error">{searchError}</p>}

      {canWrite && results !== null && (
        <div className="wishlist-results">
          {results.length === 0 && !searching && !searchError && (
            <div className="empty">No albums found on Spotify for that search.</div>
          )}
          {results.length > 0 && (
            <div className="grid">
              {results.map((album) => {
                const existing = byId.get(album.id);
                return (
                  <article className="card" key={`result:${album.id}`}>
                    <div className={`cover${album.coverImage ? " has-art" : ""}`} aria-hidden>
                      {album.coverImage && (
                        <img src={album.coverImage} alt="" loading="lazy" width={58} height={58} />
                      )}
                    </div>
                    <div className="card-body">
                      <div className="card-artist">{album.name}</div>
                      {album.artist && <div className="card-title">{album.artist}</div>}
                      {album.year != null && <div className="card-meta">{album.year}</div>}

                      {existing ? (
                        <div className="card-actions">
                          <span className="on-list">
                            On your list · {existing.status === "vetted" ? "Vetted" : "Unvetted"}
                          </span>
                          <button
                            type="button"
                            className="linkish"
                            onClick={() => scrollToEntry(album.id)}
                          >
                            Jump to it
                          </button>
                        </div>
                      ) : (
                        <div className="card-actions add-actions">
                          <button
                            type="button"
                            className="btn add-vetted"
                            onClick={() => onAdd(album, "vetted")}
                          >
                            Vetted
                          </button>
                          <button
                            type="button"
                            className="btn add-unvetted"
                            onClick={() => onAdd(album, "unvetted")}
                          >
                            Unvetted
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="wishlist-filter" role="group" aria-label="Filter by status">
        {(["all", "vetted", "unvetted"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`filter-chip${filter === f ? " active" : ""}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "vetted" ? "Vetted" : "Unvetted"} ({counts[f]})
          </button>
        ))}
      </div>

      {loading && <div className="empty">Loading the wishlist…</div>}
      {!loading && listError && <div className="error">{listError}</div>}
      {!loading && !listError && entries.length === 0 && (
        <div className="empty">
          Nothing on maybe-vibes yet.{canWrite ? " Search Spotify above to shortlist an album." : ""}
        </div>
      )}
      {!loading && !listError && entries.length > 0 && filtered.length === 0 && (
        <div className="empty">No {filter} entries.</div>
      )}
      {!loading && !listError && filtered.length > 0 && (
        <div className="grid">
          {filtered.map((entry) => (
            <WishlistCard
              key={`wishlist:${entry.id}`}
              entry={entry}
              canWrite={canWrite}
              onToggleStatus={onToggle}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </section>
  );
}
