"use client";

import { useState } from "react";
import type { WishlistEntry } from "@/lib/types";

/**
 * One maybe-vibes entry, styled to match RecordCard: cover, album title, artist,
 * year, a status pill, and — for owners — an Open-in-Spotify link, a status toggle,
 * and a Remove action with a single inline confirmation. Guests see the entry and
 * the Spotify link but no mutation controls (writes are owner-only server-side too).
 *
 * The article carries id="wishlist-{id}" so the add flow can scroll to an existing
 * entry instead of creating a duplicate.
 */
export default function WishlistCard({
  entry,
  canWrite,
  onToggleStatus,
  onRemove,
}: {
  entry: WishlistEntry;
  canWrite: boolean;
  onToggleStatus: (entry: WishlistEntry) => void;
  onRemove: (entry: WishlistEntry) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const vetted = entry.status === "vetted";

  return (
    <article className="card" id={`wishlist-${entry.id}`}>
      <div className={`cover${entry.coverImage ? " has-art" : ""}`} aria-hidden>
        {entry.coverImage && (
          <img src={entry.coverImage} alt="" loading="lazy" width={58} height={58} />
        )}
      </div>
      <div className="card-body">
        <div className="card-artist">{entry.name}</div>
        {entry.artist && <div className="card-title">{entry.artist}</div>}
        {entry.year != null && <div className="card-meta">{entry.year}</div>}

        <div className="tags">
          <span className={`status-pill${vetted ? " vetted" : ""}`}>
            {vetted ? "Vetted" : "Unvetted"}
          </span>
        </div>

        <div className="card-actions">
          {entry.spotifyUrl && (
            <a href={entry.spotifyUrl} target="_blank" rel="noopener noreferrer">
              Open in Spotify ↗
            </a>
          )}
          {canWrite && !confirming && (
            <>
              <button type="button" className="linkish" onClick={() => onToggleStatus(entry)}>
                {vetted ? "Mark unvetted" : "Mark vetted"}
              </button>
              <button type="button" className="linkish danger" onClick={() => setConfirming(true)}>
                Remove
              </button>
            </>
          )}
          {canWrite && confirming && (
            <span className="confirm">
              Remove from maybe-vibes?{" "}
              <button
                type="button"
                className="linkish danger"
                onClick={() => {
                  setConfirming(false);
                  onRemove(entry);
                }}
              >
                Yes, remove
              </button>
              <button type="button" className="linkish" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
