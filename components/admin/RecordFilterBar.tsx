"use client";

import { useEffect, useRef, useState } from "react";
import {
  EMPTY_FILTER,
  activeFilterCount,
  type DatePreset,
  type FilterState,
  type SortKey,
} from "@/lib/record-filter";

/**
 * The one filter bar the Invoices, Collections and Credits tabs share: a quick
 * search (debounced), filters (inline on a desktop, a collapsible panel on a
 * phone), the active filters as removable chips with "Clear all", the result
 * count, sort and CSV export. Filtering itself happens on the server
 * (lib/record-filter.ts); this only edits the state.
 */

export interface FilterBarConfig {
  searchPlaceholder: string;
  /** "invoice" → "24 invoices". */
  noun: string;
  dateLabel: string;
  statusOptions: { value: string; label: string }[];
  /** A kind dropdown, where the tab has more than one kind of record. */
  typeOptions?: { value: string; label: string }[];
  sortOptions: { value: SortKey; label: string }[];
  /** Offer a trip-date range (Collections). */
  tripDate?: boolean;
  customers?: string[];
  drivers?: { id: string; name: string }[];
  trips?: { id: string; name: string }[];
  /** The tab's yes/no filter, e.g. "Has a collection". */
  flagLabel?: string;
}

const PRESETS: { value: DatePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
  { value: "30d", label: "Last 30 days" },
];

const inputClass =
  "h-8 px-2 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green";
const label = "text-[10px] font-mono text-ink-muted uppercase tracking-wide";

export default function RecordFilterBar({
  state,
  onChange,
  config,
  total,
  loading,
  exportHref,
  onExport,
}: {
  state: FilterState;
  onChange: (next: FilterState) => void;
  config: FilterBarConfig;
  total: number | null;
  loading?: boolean;
  /** The CSV of the current filtered results (ADMIN). */
  exportHref?: string;
  /** Or, for a list filtered in the browser, build the CSV there. */
  onExport?: () => void;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [custom, setCustom] = useState(!!(state.from || state.to));
  const [text, setText] = useState(state.q);
  const lastSent = useRef(state.q);
  const set = (patch: Partial<FilterState>) => onChange({ ...state, ...patch });

  // The box follows the state when it changes elsewhere (Clear all, a URL
  // restored after mount), but not while someone is typing into it.
  useEffect(() => {
    if (state.q !== lastSent.current) {
      lastSent.current = state.q;
      const t = setTimeout(() => setText(state.q), 0);
      return () => clearTimeout(t);
    }
  }, [state.q]);

  // Debounced: ~300 ms after the last keystroke.
  useEffect(() => {
    if (text === state.q) return;
    const t = setTimeout(() => {
      lastSent.current = text;
      onChange({ ...state, q: text });
    }, 300);
    return () => clearTimeout(t);
  }, [text, state, onChange]);

  const activeCount = activeFilterCount(state);
  const chips: { key: string; text: string; clear: Partial<FilterState> }[] = [];
  if (state.preset) chips.push({ key: "preset", text: `${config.dateLabel}: ${PRESETS.find((p) => p.value === state.preset)?.label}`, clear: { preset: "" } });
  else if (state.from || state.to)
    chips.push({ key: "range", text: `${config.dateLabel}: ${state.from || "…"} – ${state.to || "…"}`, clear: { from: "", to: "" } });
  if (state.tripFrom || state.tripTo)
    chips.push({ key: "trip-range", text: `Trip date: ${state.tripFrom || "…"} – ${state.tripTo || "…"}`, clear: { tripFrom: "", tripTo: "" } });
  // A tab whose status lives in its own tabs (Credits) has no status chips.
  for (const s of config.statusOptions.length ? state.status : []) {
    chips.push({
      key: `status-${s}`,
      text: config.statusOptions.find((o) => o.value === s)?.label ?? s,
      clear: { status: state.status.filter((x) => x !== s) },
    });
  }
  if (state.type)
    chips.push({ key: "type", text: config.typeOptions?.find((o) => o.value === state.type)?.label ?? state.type, clear: { type: "" } });
  if (state.customer) chips.push({ key: "customer", text: `Customer: ${state.customer}`, clear: { customer: "" } });
  if (state.driver)
    chips.push({ key: "driver", text: `Driver: ${config.drivers?.find((d) => d.id === state.driver)?.name ?? state.driver}`, clear: { driver: "" } });
  if (state.trip) chips.push({ key: "trip", text: `Trip: ${config.trips?.find((t) => t.id === state.trip)?.name ?? state.trip}`, clear: { trip: "" } });
  if (state.flag && config.flagLabel) chips.push({ key: "flag", text: config.flagLabel, clear: { flag: false } });

  const plural = (n: number) => `${n} ${config.noun}${n === 1 ? "" : "s"}`;

  return (
    <div className="bg-ink-card border border-ink-border rounded mb-4">
      {/* Search, filters, sort, export */}
      <div className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative flex-1 basis-full sm:basis-auto min-w-0 sm:min-w-[16rem]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={config.searchPlaceholder}
            aria-label="Search"
            className="w-full h-9 pl-8 pr-3 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
        </div>
        <button
          type="button"
          onClick={() => setPanelOpen((o) => !o)}
          aria-expanded={panelOpen}
          className={`act sm:hidden ${activeCount ? "act-green" : ""}`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" />
          </svg>
          Filters{activeCount ? ` · ${activeCount}` : ""}
        </button>
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Sort by</span>
          <select value={state.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} className={inputClass} aria-label="Sort by">
            {config.sortOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {exportHref && (
          <a href={exportHref} className="act" title="The current filtered results as CSV">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            CSV
          </a>
        )}
        {!exportHref && onExport && (
          <button type="button" onClick={onExport} disabled={total === 0} className="act" title="The current filtered results as CSV">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            CSV
          </button>
        )}
      </div>

      {/* Filters — always shown from tablet width up, a panel on a phone. */}
      <div className={`${panelOpen ? "grid" : "hidden"} sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 px-3 pb-3`}>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className={label}>{config.dateLabel}</span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => { setCustom(false); set({ preset: state.preset === p.value ? "" : p.value, from: "", to: "" }); }}
                className={`act ${state.preset === p.value ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { setCustom((c) => !c); set({ preset: "" }); }}
              className={`act ${custom && !state.preset ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
            >
              Custom
            </button>
          </div>
          {custom && !state.preset && (
            <div className="flex items-center gap-2 mt-1">
              <input type="date" value={state.from} max={state.to || undefined} onChange={(e) => set({ from: e.target.value })} className={inputClass} aria-label={`${config.dateLabel} from`} />
              <span className="text-xs text-ink-muted">to</span>
              <input type="date" value={state.to} min={state.from || undefined} onChange={(e) => set({ to: e.target.value })} className={inputClass} aria-label={`${config.dateLabel} to`} />
            </div>
          )}
        </div>

        {config.tripDate && (
          <div className="flex flex-col gap-1">
            <span className={label}>Trip date</span>
            <div className="flex items-center gap-2">
              <input type="date" value={state.tripFrom} onChange={(e) => set({ tripFrom: e.target.value })} className={`${inputClass} min-w-0 flex-1`} aria-label="Trip date from" />
              <input type="date" value={state.tripTo} onChange={(e) => set({ tripTo: e.target.value })} className={`${inputClass} min-w-0 flex-1`} aria-label="Trip date to" />
            </div>
          </div>
        )}

        {config.typeOptions && (
          <label className="flex flex-col gap-1">
            <span className={label}>Type</span>
            <select value={state.type} onChange={(e) => set({ type: e.target.value })} className={inputClass}>
              <option value="">Any type</option>
              {config.typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}

        {config.customers && (
          <label className="flex flex-col gap-1">
            <span className={label}>Customer</span>
            <input
              list={`customers-${config.noun}`}
              value={state.customer}
              onChange={(e) => set({ customer: e.target.value })}
              placeholder="Any customer"
              className={inputClass}
            />
            <datalist id={`customers-${config.noun}`}>
              {config.customers.map((c) => <option key={c} value={c} />)}
            </datalist>
          </label>
        )}

        {config.drivers && config.drivers.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className={label}>Driver</span>
            <select value={state.driver} onChange={(e) => set({ driver: e.target.value })} className={inputClass}>
              <option value="">Any driver</option>
              {config.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}

        {config.trips && config.trips.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className={label}>Trip sheet</span>
            <select value={state.trip} onChange={(e) => set({ trip: e.target.value })} className={inputClass}>
              <option value="">Any trip sheet</option>
              {config.trips.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}

        {config.statusOptions.length > 0 && (
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className={label}>Status</span>
          <div className="flex flex-wrap gap-1.5">
            {config.statusOptions.map((o) => {
              const on = state.status.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ status: on ? state.status.filter((s) => s !== o.value) : [...state.status, o.value] })}
                  className={`act ${on ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
        )}

        {config.flagLabel && (
          <label className="flex items-center gap-2 text-xs font-mono text-ink-black cursor-pointer self-end h-8">
            <input type="checkbox" checked={state.flag} onChange={(e) => set({ flag: e.target.checked })}
              className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F]" />
            {config.flagLabel}
          </label>
        )}
      </div>

      {/* What is in force, and how many it let through */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-t border-ink-border bg-ink-surface/40">
        <span className="text-xs font-mono text-ink-muted mr-1">
          {loading && total === null ? "Loading…" : total !== null ? plural(total) : ""}
        </span>
        {chips.map((c) => (
          <button key={c.key} type="button" onClick={() => set(c.clear)} className="act" aria-label={`Remove filter ${c.text}`}>
            {c.text}
            <span aria-hidden="true" className="text-ink-muted">×</span>
          </button>
        ))}
        {(chips.length > 0 || state.q) && (
          <button type="button" onClick={() => { setText(""); setCustom(false); onChange({ ...EMPTY_FILTER, sort: state.sort }); }} className="act act-danger">
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

/** The matched parts of a text marked, for search results. */
export function Highlight({ text, query }: { text: string | null | undefined; query: string }) {
  const value = text ?? "";
  const words = query.trim().split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!value || words.length === 0) return <>{value}</>;
  const parts = value.split(new RegExp(`(${words.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-[#FDF1DC] text-inherit rounded-sm px-0.5">{p}</mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}
