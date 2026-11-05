"use client";

import type { ReactNode } from "react";

export interface StatusTab<Id extends string> {
  id: Id;
  /** On a tablet and up. */
  label: string;
  /** On a phone. */
  short: string;
  count: number;
}

/**
 * The Active / Completed bar at the top of a list card: Trip Sheets, Courier
 * and Collections. Sits inside the card, flush with its top edge; `trailing`
 * goes at the far end of the bar (Trip Sheets' collapse button).
 */
export default function StatusTabs<Id extends string>({
  tabs,
  active,
  onChange,
  trailing,
}: {
  tabs: StatusTab<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-ink-border">
      {/* Scrollbar hidden: the tabs' -mb-px overlap counts as overflow, and showed one. */}
      <div role="tablist" className="flex items-center overflow-x-auto [scrollbar-width:none]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-2 px-3 sm:px-5 py-3 sm:py-4 font-mono text-[13px] sm:text-sm font-medium uppercase tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors ${
              active === t.id
                ? "border-ink-green text-ink-black"
                : "border-transparent text-ink-muted hover:text-ink-black"
            }`}
          >
            <span className="sm:hidden">{t.short}</span>
            <span className="hidden sm:inline">{t.label}</span>
            <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono font-medium rounded-full bg-ink-surface text-ink-muted">
              {t.count}
            </span>
          </button>
        ))}
      </div>
      {trailing}
    </div>
  );
}
