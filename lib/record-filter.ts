/**
 * One filter rulebook for the Invoices, Collections and Credits tabs: quick
 * search, date range with presets, statuses, customer / driver / trip sheet,
 * one yes/no flag per tab, sort, and 25-row pages.
 *
 * It runs on the SERVER (each tab's list route filters, sorts and pages before
 * anything is sent), and its state round-trips through the URL query string so
 * a filtered view survives a refresh, the back button and a shared link
 * (components/admin/RecordFilterBar.tsx, hooks/useRecordFilters.ts).
 *
 * No imports beyond the shared text matcher, so the browser and the server run
 * the same code.
 */

import { matchesTokens, tokenizeQuery, type SearchField } from "./search-match";

export type DatePreset = "today" | "week" | "month" | "30d";
export type SortKey = "date_desc" | "date_asc" | "customer" | "number" | "status";

export interface FilterState {
  q: string;
  /** YYYY-MM-DD, inclusive. A preset, when set, wins over from/to. */
  from: string;
  to: string;
  preset: DatePreset | "";
  /** The trip's date (Collections). */
  tripFrom: string;
  tripTo: string;
  status: string[];
  /** The tab's kind, where it has more than one (Collections: credit return / uplift). */
  type: string;
  customer: string;
  driver: string;
  trip: string;
  /** The tab's one yes/no filter: has a collection / has variance or warnings. */
  flag: boolean;
  sort: SortKey;
}

export const EMPTY_FILTER: FilterState = {
  q: "",
  from: "",
  to: "",
  preset: "",
  tripFrom: "",
  tripTo: "",
  status: [],
  type: "",
  customer: "",
  driver: "",
  trip: "",
  flag: false,
  sort: "date_desc",
};

export const PAGE_SIZE = 25;

const PRESETS: DatePreset[] = ["today", "week", "month", "30d"];
const SORTS: SortKey[] = ["date_desc", "date_asc", "customer", "number", "status"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The state from a URL query string; anything malformed is left at its default. */
export function parseFilterState(params: URLSearchParams): FilterState {
  const day = (k: string) => {
    const v = params.get(k) ?? "";
    return DAY.test(v) ? v : "";
  };
  const text = (k: string, max = 100) => (params.get(k) ?? "").slice(0, max);
  const preset = params.get("preset") as DatePreset;
  const sort = params.get("sort") as SortKey;
  return {
    q: text("q"),
    from: day("from"),
    to: day("to"),
    preset: PRESETS.includes(preset) ? preset : "",
    tripFrom: day("tripFrom"),
    tripTo: day("tripTo"),
    status: (params.get("status") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10),
    type: text("type", 40),
    customer: text("customer"),
    driver: text("driver"),
    trip: text("trip", 200),
    flag: params.get("flag") === "1",
    sort: SORTS.includes(sort) ? sort : "date_desc",
  };
}

/** The query string for a state — only what differs from the defaults. */
export function filterToParams(state: FilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.preset) p.set("preset", state.preset);
  else {
    if (state.from) p.set("from", state.from);
    if (state.to) p.set("to", state.to);
  }
  if (state.tripFrom) p.set("tripFrom", state.tripFrom);
  if (state.tripTo) p.set("tripTo", state.tripTo);
  if (state.status.length) p.set("status", state.status.join(","));
  if (state.type) p.set("type", state.type);
  if (state.customer) p.set("customer", state.customer);
  if (state.driver) p.set("driver", state.driver);
  if (state.trip) p.set("trip", state.trip);
  if (state.flag) p.set("flag", "1");
  if (state.sort !== "date_desc") p.set("sort", state.sort);
  return p;
}

/** How many filters (beyond search and sort) are in force — for the "Filters · n" button. */
export function activeFilterCount(state: FilterState): number {
  return (
    (state.preset || state.from || state.to ? 1 : 0) +
    (state.tripFrom || state.tripTo ? 1 : 0) +
    (state.status.length ? 1 : 0) +
    (state.type ? 1 : 0) +
    (state.customer ? 1 : 0) +
    (state.driver ? 1 : 0) +
    (state.trip ? 1 : 0) +
    (state.flag ? 1 : 0)
  );
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A preset as a from/to pair, in the local calendar of `now`. Weeks start on Monday. */
export function resolvePreset(preset: DatePreset, now = new Date()): { from: string; to: string } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case "today":
      return { from: ymd(today), to: ymd(today) };
    case "week": {
      const monday = new Date(today);
      monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      return { from: ymd(monday), to: ymd(today) };
    }
    case "month":
      return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
    case "30d": {
      const start = new Date(today);
      start.setDate(today.getDate() - 29);
      return { from: ymd(start), to: ymd(today) };
    }
  }
}

/**
 * The query string a page sends to its list route. A preset is resolved here,
 * in the browser, so "today" is the viewer's today and not the server's; the
 * URL bar keeps the preset itself (filterToParams) so a bookmark stays current.
 */
export function filterToRequestParams(state: FilterState, now = new Date()): URLSearchParams {
  const p = filterToParams({ ...state, preset: "", ...(state.preset ? resolvePreset(state.preset, now) : {}) });
  p.set("tzOffset", String(now.getTimezoneOffset()));
  return p;
}

/** How a tab tells the rulebook where each field is on its rows. */
export interface FilterAccessors<T> {
  /** Everything the quick search should find (numbers raw AND normalized). */
  search: (row: T) => SearchField[];
  /** The tab's main date, YYYY-MM-DD or ISO; null when unknown. */
  date: (row: T) => string | null;
  tripDate?: (row: T) => string | null;
  status: (row: T) => string;
  type?: (row: T) => string;
  customer: (row: T) => string | null;
  driver?: (row: T) => string | null;
  trip?: (row: T) => string | null;
  flag?: (row: T) => boolean;
  /** The document number, for sorting. */
  number: (row: T) => string;
}

/**
 * The calendar day of a value: a bare YYYY-MM-DD is already one; a timestamp
 * is read on the viewer's clock (`tzOffset` as Date#getTimezoneOffset gives
 * it), so a collection at 01:00 in Johannesburg is not "yesterday".
 */
const dayOf = (v: string | null, tzOffset: number) => {
  if (!v) return null;
  if (v.length <= 10) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v.slice(0, 10) : new Date(t - tzOffset * 60_000).toISOString().slice(0, 10);
};
const inDayRange = (v: string | null, from: string, to: string, tzOffset: number) => {
  if (!from && !to) return true;
  const d = dayOf(v, tzOffset);
  if (!d) return false;
  return (!from || d >= from) && (!to || d <= to);
};

/** The rows this state lets through, in its sort order. */
export function applyFilter<T>(rows: T[], state: FilterState, acc: FilterAccessors<T>, now = new Date(), tzOffset = 0): T[] {
  const tokens = tokenizeQuery(state.q);
  const range = state.preset ? resolvePreset(state.preset, now) : { from: state.from, to: state.to };
  const statuses = new Set(state.status);
  const customer = state.customer.trim().toLowerCase();

  const out = rows.filter((r) => {
    if (!inDayRange(acc.date(r), range.from, range.to, tzOffset)) return false;
    if (acc.tripDate && !inDayRange(acc.tripDate(r), state.tripFrom, state.tripTo, tzOffset)) return false;
    if (statuses.size && !statuses.has(acc.status(r))) return false;
    if (state.type && acc.type && acc.type(r) !== state.type) return false;
    if (customer && (acc.customer(r) ?? "").trim().toLowerCase() !== customer) return false;
    if (state.driver && acc.driver && acc.driver(r) !== state.driver) return false;
    if (state.trip && acc.trip && acc.trip(r) !== state.trip) return false;
    if (state.flag && acc.flag && !acc.flag(r)) return false;
    return matchesTokens(tokens, acc.search(r));
  });

  const byDate = (a: T, b: T) => (acc.date(a) ?? "").localeCompare(acc.date(b) ?? "");
  const text = (v: string | null) => (v ?? "").toLowerCase();
  switch (state.sort) {
    case "date_desc":
      // Undated rows sort last either way.
      return out.sort((a, b) => (!acc.date(a) ? 1 : !acc.date(b) ? -1 : byDate(b, a)));
    case "date_asc":
      return out.sort((a, b) => (!acc.date(a) ? 1 : !acc.date(b) ? -1 : byDate(a, b)));
    case "customer":
      return out.sort((a, b) => text(acc.customer(a)).localeCompare(text(acc.customer(b))) || byDate(b, a));
    case "number":
      return out.sort((a, b) => acc.number(a).localeCompare(acc.number(b), undefined, { numeric: true }));
    case "status":
      return out.sort((a, b) => acc.status(a).localeCompare(acc.status(b)) || byDate(b, a));
  }
}

/**
 * One page of an already-filtered list. The cursor is the offset of the next
 * page, opaque to the browser: it passes `next` back as `after`.
 */
export function pageOf<T>(rows: T[], after: string | null, size = PAGE_SIZE): { items: T[]; total: number; next: string | null } {
  const start = Math.max(0, Number.parseInt(after ?? "0", 10) || 0);
  const items = rows.slice(start, start + size);
  const end = start + items.length;
  return { items, total: rows.length, next: end < rows.length ? String(end) : null };
}

/** A requested page size (a reload keeps the rows already shown), 1..200. */
export function parsePageSize(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : PAGE_SIZE;
}

/** The choices the dropdowns offer: the customers, drivers and trips in the rows. */
export function facetsOf<T>(rows: T[], acc: FilterAccessors<T>, driverName?: (row: T) => string | null, tripName?: (row: T) => string | null) {
  const customers = [...new Set(rows.map(acc.customer).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
  const drivers = new Map<string, string>();
  const trips = new Map<string, string>();
  for (const r of rows) {
    const d = acc.driver?.(r);
    if (d) drivers.set(d, driverName?.(r) ?? d);
    const t = acc.trip?.(r);
    if (t) trips.set(t, tripName?.(r) ?? t);
  }
  return {
    customers: customers.slice(0, 500),
    drivers: [...drivers].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    // Newest first when the names lead with a date.
    trips: [...trips].map(([id, name]) => ({ id, name })).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 200),
  };
}

/** CSV with a header row; formula-guarded so a spreadsheet never runs a cell. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}
