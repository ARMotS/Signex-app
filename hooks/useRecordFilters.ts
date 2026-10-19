"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_FILTER, filterToParams, filterToRequestParams, parseFilterState, type FilterState } from "@/lib/record-filter";

/** Query keys the filter owns; anything else in the URL (e.g. ?note=) is left alone. */
const OWN_KEYS = ["q", "from", "to", "preset", "tripFrom", "tripTo", "status", "type", "customer", "driver", "trip", "flag", "sort"];

/**
 * A tab's filter state, kept in the URL (so a filtered view survives refresh,
 * the back button and a shared link) and remembered per tab in localStorage
 * for the next visit. The URL wins over what was remembered.
 *
 * Starts EMPTY on the server and the first client render, then reads the URL
 * after mount — so server and client markup agree.
 */
export function useRecordFilters(tabKey: string): [FilterState, (next: FilterState) => void] {
  const [state, setState] = useState<FilterState>(EMPTY_FILTER);
  const storageKey = `signex-filters:${tabKey}`;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let initial: FilterState | null = null;
    if (OWN_KEYS.some((k) => params.has(k))) {
      initial = parseFilterState(params);
    } else {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) initial = parseFilterState(new URLSearchParams(saved));
      } catch {
        // Storage blocked (private window) — start empty.
      }
    }
    if (!initial) return;
    const restored = initial;
    const t = setTimeout(() => setState(restored), 0);
    return () => clearTimeout(t);
  }, [storageKey]);

  const update = useCallback(
    (next: FilterState) => {
      setState(next);
      const own = filterToParams(next);
      const url = new URL(window.location.href);
      for (const k of OWN_KEYS) url.searchParams.delete(k);
      own.forEach((v, k) => url.searchParams.set(k, v));
      window.history.replaceState(window.history.state, "", url.toString());
      try {
        window.localStorage.setItem(storageKey, own.toString());
      } catch {
        // Storage blocked — the URL still carries it.
      }
    },
    [storageKey]
  );

  return [state, update];
}

export interface PagedResult<T, Extra> {
  items: T[];
  total: number | null;
  next: string | null;
  /** Everything else the route returned with the first page (counts, folder, facets). */
  extra: Extra | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  /** Re-reads the pages already shown (after an action changed a row). */
  reload: () => void;
  /** The CSV of every filtered row. */
  csvHref: string;
}

/**
 * One filtered, paged list from a `?view=page` route. A filter change starts
 * again from the first page; "Load more" appends the next. A response that
 * arrives after a newer request is dropped, so fast typing never shows an
 * older search's rows.
 */
export function usePagedRecords<T, Extra>(
  endpoint: string,
  listKey: string,
  state: FilterState,
  ready = true
): PagedResult<T, Extra> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [extra, setExtra] = useState<Extra | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const seq = useRef(0);
  const shown = useRef(0);

  const query = filterToRequestParams(state);
  query.set("view", "page");
  const base = `${endpoint}?${query.toString()}`;

  const fetchPage = useCallback(
    async (after: string | null, size?: number) => {
      const url = `${base}${after ? `&after=${encodeURIComponent(after)}` : ""}${size ? `&size=${size}` : ""}`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load");
      return data as Record<string, unknown>;
    },
    [base]
  );

  // A new filter is a new list — forget how far down the last one was
  // scrolled. Declared before the fetch so it runs first.
  useEffect(() => {
    shown.current = 0;
  }, [base]);

  useEffect(() => {
    if (!ready) return;
    const id = ++seq.current;
    const keep = shown.current;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        // A reload keeps as many rows as were showing; a new filter starts at one page.
        const data = await fetchPage(null, keep > 0 ? keep : undefined);
        if (cancelled || id !== seq.current) return;
        const { [listKey]: rows, total: t, next: n, ...rest } = data;
        setItems((rows as T[]) ?? []);
        shown.current = ((rows as T[]) ?? []).length;
        setTotal(typeof t === "number" ? t : null);
        setNext(typeof n === "string" ? n : null);
        setExtra(rest as Extra);
      } catch (e) {
        if (!cancelled && id === seq.current) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled && id === seq.current) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [fetchPage, listKey, ready, generation]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore) return;
    const id = seq.current;
    setLoadingMore(true);
    fetchPage(next)
      .then((data) => {
        if (id !== seq.current) return;
        const rows = (data[listKey] as T[]) ?? [];
        setItems((prev) => {
          shown.current = prev.length + rows.length;
          return [...prev, ...rows];
        });
        setNext(typeof data.next === "string" ? data.next : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => setLoadingMore(false));
  }, [next, loadingMore, fetchPage, listKey]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { items, total, next, extra, loading, loadingMore, error, loadMore, reload, csvHref: `${base}&format=csv` };
}
