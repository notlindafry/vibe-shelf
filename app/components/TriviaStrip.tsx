"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchInsights } from "@/lib/api";
import type { Insight, InsightAction } from "@/lib/types";

const AUTO_ADVANCE_MS = 20000;
const SWIPE_THRESHOLD_PX = 40;
const ACTION_TYPES = new Set<InsightAction["type"]>(["genre", "style", "owner", "search"]);

/**
 * The home-view trivia strip (feature 6, rebalanced layout). A full-width
 * horizontal strip — leading disc icon, a text block (tag / title / body), and
 * the rotation controls grouped on the right — that rotates through the cached
 * insights batch entirely client-side (never calls Claude). The first card is the
 * overview; the rest are trivia. All text renders as escaped React text; a
 * tap-to-search action is re-validated here before dispatch. Hides itself while
 * loading or when there is nothing usable.
 */
export default function TriviaStrip({
  onAction,
}: {
  onAction?: (action: InsightAction) => void;
}) {
  const [insights, setInsights] = useState<Insight[] | null>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInsights()
      .then((res) => {
        if (!cancelled) setInsights(Array.isArray(res.insights) ? res.insights : []);
      })
      .catch(() => {
        if (!cancelled) setInsights([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const count = insights?.length ?? 0;

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  // Auto-advance, paused on hover/focus/touch and disabled for reduced-motion.
  // `index` in the deps resets the countdown after a manual move.
  useEffect(() => {
    if (paused || count <= 1) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % count), AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, count, index]);

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    go(index + (dx < 0 ? 1 : -1));
  }

  if (insights === null || count === 0) return null;

  const current = insights[Math.min(index, count - 1)];
  const action = validAction(current.action);

  return (
    <section
      className="trivia"
      aria-label="Collection insights"
      aria-roledescription="carousel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="trivia-icon" aria-hidden />

      <div className="trivia-text">
        {current.kind && <span className="trivia-tag">{current.kind}</span>}
        <div className="trivia-title">{current.title}</div>
        <p className="trivia-body">{current.body}</p>
        {action && onAction && (
          <button
            type="button"
            className="trivia-action linkish"
            onClick={() => onAction(action)}
          >
            {actionLabel(action)}
          </button>
        )}
      </div>

      {count > 1 && (
        <div className="trivia-controls">
          <div className="trivia-dots">
            {insights.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`trivia-dot${i === index ? " active" : ""}`}
                aria-label={`Go to insight ${i + 1}`}
                aria-current={i === index}
                onClick={() => go(i)}
              />
            ))}
          </div>
          <span className="trivia-counter" aria-hidden>
            {index + 1} / {count}
          </span>
          <div className="trivia-arrows">
            <button
              type="button"
              className="trivia-arrow"
              aria-label="Previous insight"
              onClick={() => go(index - 1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="trivia-arrow"
              aria-label="Next insight"
              onClick={() => go(index + 1)}
            >
              ›
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Re-validate an action before dispatch: known type, non-empty value. */
function validAction(action: InsightAction | null): InsightAction | null {
  if (!action) return null;
  if (!ACTION_TYPES.has(action.type)) return null;
  if (typeof action.value !== "string" || action.value.trim().length === 0) return null;
  return action;
}

function actionLabel(action: InsightAction): string {
  switch (action.type) {
    case "genre":
    case "style":
      return `Browse ${action.value} →`;
    case "owner":
      return `See ${action.value}’s shelf →`;
    case "search":
      return `Search “${action.value}” →`;
  }
}
