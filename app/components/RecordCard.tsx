"use client";

import type { Record as ShelfRecord } from "@/lib/types";

interface RecordCardProps {
  record: ShelfRecord;
  reason?: string;
  onSimilar?: (record: ShelfRecord) => void;
  isBookmarked?: boolean;
  onToggleBookmark?: (record: ShelfRecord) => void;
}

/**
 * A single record: artist, title, format/year/label, style + genre tags, an
 * owner tag, and an optional one-line reason. Cover art is not fetched from
 * Discogs in this build (see README) — a styled vinyl placeholder stands in.
 */
export default function RecordCard({
  record,
  reason,
  onSimilar,
  isBookmarked,
  onToggleBookmark,
}: RecordCardProps) {
  const metaParts = [record.format, record.year ? String(record.year) : "", record.label]
    .map((p) => p.trim())
    .filter(Boolean);

  const styles = record.styles.slice(0, 4);
  // Show genres only when they aren't already covered by the style tags.
  const styleLower = new Set(record.styles.map((s) => s.toLowerCase()));
  const genres = record.genres.filter((g) => !styleLower.has(g.toLowerCase())).slice(0, 2);

  return (
    <article className="card">
      <div className="cover" aria-hidden />
      <div className="card-body">
        <div className="card-artist">{record.artist}</div>
        <div className="card-title">{record.title}</div>
        {metaParts.length > 0 && <div className="card-meta">{metaParts.join(" · ")}</div>}

        <div className="tags">
          <span className="tag owner">{record.owner}</span>
          {styles.map((s) => (
            <span className="tag style" key={`s-${s}`}>
              {s}
            </span>
          ))}
          {genres.map((g) => (
            <span className="tag" key={`g-${g}`}>
              {g}
            </span>
          ))}
        </div>

        {reason && <div className="reason">{reason}</div>}

        <div className="card-actions">
          {record.discogsUrl && (
            <a href={record.discogsUrl} target="_blank" rel="noopener noreferrer">
              Discogs ↗
            </a>
          )}
          {onSimilar && (
            <button type="button" className="linkish" onClick={() => onSimilar(record)}>
              More like this
            </button>
          )}
          {onToggleBookmark && (
            <button
              type="button"
              className="linkish"
              aria-pressed={isBookmarked}
              aria-label={isBookmarked ? "Remove from saved" : "Save record"}
              onClick={() => onToggleBookmark(record)}
            >
              {isBookmarked ? "★ Saved" : "☆ Save"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
