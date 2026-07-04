"use client";

import { useEffect, useRef, useState } from "react";

interface MultiSelectProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Show a filter box when there are more than this many options. */
  searchThreshold?: number;
}

/**
 * Generic multi-select filter control: a pill button that opens a searchable
 * checkbox panel. Used for the owner, genre, style, and mood facets.
 */
export default function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchThreshold = 8,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectedSet = new Set(selected);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? options.filter((o) => o.toLowerCase().includes(needle))
    : options;

  function toggle(option: string) {
    if (selectedSet.has(option)) {
      onChange(selected.filter((o) => o !== option));
    } else {
      onChange([...selected, option]);
    }
  }

  const disabled = options.length === 0;

  return (
    <div className="facet" ref={rootRef}>
      <button
        type="button"
        className="facet-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        {selected.length > 0 && <span className="count">{selected.length}</span>}
        <span className="chev" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="facet-panel" role="listbox" aria-label={label}>
          {options.length > searchThreshold && (
            <input
              type="text"
              placeholder={`Filter ${label.toLowerCase()}…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              autoFocus
            />
          )}
          <div className="facet-options">
            {visible.length === 0 ? (
              <div className="facet-empty">No matches</div>
            ) : (
              visible.map((option) => {
                const isSelected = selectedSet.has(option);
                return (
                  <label
                    key={option}
                    className={`facet-option${isSelected ? " selected" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggle(option)}
                    />
                    <span>{option}</span>
                  </label>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <div className="facet-clear">
              <button type="button" className="linkish" onClick={() => onChange([])}>
                Clear {label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
