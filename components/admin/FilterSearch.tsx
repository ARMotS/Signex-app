"use client";

/**
 * The search box that sits above a long file list.
 *
 * Filtering is client-side (see lib/search-match.ts) — the caller owns the
 * query and does the narrowing, so this component is only the field, its clear
 * affordance and the "n of m" readout that tells a dispatcher whether the row
 * they were looking for is simply not there.
 */

import { useEffect, useRef } from "react";

interface FilterSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** Rows the query left visible, and how many there were before it. */
  matchCount?: number;
  totalCount?: number;
  /** Singular noun for the readout — "invoice", "file", "sheet". */
  noun?: string;
  /**
   * Bind "/" to focus this field. At most one per page: with two, the key has
   * no single answer.
   */
  shortcut?: boolean;
  className?: string;
}

export function FilterSearch({
  value,
  onChange,
  placeholder,
  matchCount,
  totalCount,
  noun = "result",
  shortcut = false,
  className = "",
}: FilterSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shortcut) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      // Never take the key off someone who is typing — "/" is a legitimate
      // character in a folder path or a customer name.
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcut]);

  const searching = value.trim().length > 0;
  const showCount = searching && matchCount !== undefined && totalCount !== undefined;

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div className="relative w-full max-w-xs">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted-light pointer-events-none"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Escape empties the box, and empties the page of the filter with
            // it; a second Escape gives the keyboard back.
            if (searching) onChange("");
            else inputRef.current?.blur();
          }}
          aria-label={placeholder}
          className="w-full pl-8 pr-8 py-1.5 text-xs font-mono text-ink-black bg-ink-card border border-ink-border rounded placeholder:text-ink-muted-light focus:outline-none focus:border-ink-black/30 transition-colors [&::-webkit-search-cancel-button]:appearance-none"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-ink-muted hover:text-ink-black hover:bg-ink-surface transition-colors"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        ) : (
          shortcut && (
            <kbd className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[9px] font-mono text-ink-muted-light border border-ink-border rounded pointer-events-none">
              /
            </kbd>
          )
        )}
      </div>
      {showCount && (
        <p
          className={`text-[11px] font-mono whitespace-nowrap ${
            matchCount === 0 ? "text-ink-amber" : "text-ink-muted"
          }`}
        >
          {matchCount} of {totalCount} {noun}
          {totalCount === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
