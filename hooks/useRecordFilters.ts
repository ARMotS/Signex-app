"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_FILTER, PAGE_SIZE, filterToParams, filterToRequestParams, parseFilterState, type FilterState } from "@/lib/record-filter";

/** Query keys the filter owns; anything else in the URL (e.g. ?note=) is left alone. */
const OWN_KEYS = ["q", "from", "to", "preset", "tripFrom", "tripTo", "status", "type", "customer", "driver", "trip", "flag", "tab", "sort"];

/**
 * A tab's filter state, kept in the URL (so a filtered view survives refresh,
 * the back button and a shared link) and remembered per tab in localStorage
 * for the next visit. The URL wins over what was remembered.
 *
 * Starts EMPTY on the server and the first client render, then reads the URL
 * after mount — so server and client markup agree. `loaded` turns true once
 * that read is done; hand it to usePagedRecords as `ready`.
 */
export function useRecordFilters(tabKey: string): [FilterState, (next: FilterState) => void, boolean] {
  const [state, setState] = useState<FilterState>(EMPTY_FILTER);
  const [loaded, setLoaded] = useState(false);
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
    const restored = initial;
    const t = setTimeout(() => {
      if (restored) setState(restored);
      setLoaded(true);
    }, 0);
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

  return [state, update, loaded];
}

export interface PagedResult<T, Extra> {
  items: T[];
  total: number | null;
  /** 1-based page shown, and rows per page. */
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  /** Everything else the route returned (counts, folder, facets, capped). */
  extra: Extra | null;
  loading: boolean;
  error: string | null;
  /** Re-reads the page shown (after an action changed a row). */
  reload: () => void;
  /** The CSV of every filtered row. */
  csvHref: string;
}

const PAGE_SIZES = [25, 50, 100];

/** `page` / `size` from the URL: what a refresh or a shared link reopens. */
function readPageFromUrl(): { page: number; size: number } {
  const params = new URLSearchParams(window.location.search);
  const page = Number.parseInt(params.get("page") ?? "", 10);
  const size = Number.parseInt(params.get("size") ?? "", 10);
  return { page: page > 0 ? page : 1, size: PAGE_SIZES.includes(size) ? size : PAGE_SIZE };
}

function writePageToUrl(page: number, size: number) {
  const url = new URL(window.location.href);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  if (size !== PAGE_SIZE) url.searchParams.set("size", String(size));
  else url.searchParams.delete("size");
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * One filtered list from a `?view=page` route, one numbered page at a time.
 * A filter change goes back to page 1; the page and its size live in the URL
 * (`page`, `size`), so a refresh or a shared link reopens the same page. A
 * response that arrives after a newer request is dropped, so fast typing
 * never shows an older search's rows.
 *
 * Pass `ready` = the filter hook's `loaded`: until the filters are read back
 * from the URL, a fetch would be for the wrong list (and would throw away the
 * page the URL asked for).
 */
export function usePagedRecords<T, Extra>(
  endpoint: string,
  listKey: string,
  state: FilterState,
  ready = true
): PagedResult<T, Extra> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [extra, setExtra] = useState<Extra | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // The page belongs to one filter: `forBase` null = not yet tied to one (the
  // URL's page, waiting for the filters to be read back).
  const [paging, setPaging] = useState<{ forBase: string | null; page: number; size: number }>({
    forBase: null,
    page: 1,
    size: PAGE_SIZE,
  });
  const seq = useRef(0);

  const query = filterToRequestParams(state);
  query.set("view", "page");
  const base = `${endpoint}?${query.toString()}`;

  // A different filter is a different list: back to its first page.
  const page = ready && paging.forBase !== null && paging.forBase !== base ? 1 : paging.page;
  const pageSize = paging.size;

  // Tie the page to the filter in force. The first time, that is the page the
  // URL asked for (read here, not at mount: the server render has no URL, and
  // the filters must be read back first); after that, a new filter is page 1.
  useEffect(() => {
    if (!ready || paging.forBase === base) return;
    const t = setTimeout(
      () =>
        setPaging((p) =>
          p.forBase === base ? p : p.forBase === null ? { forBase: base, ...readPageFromUrl() } : { forBase: base, page: 1, size: p.size }
        ),
      0
    );
    return () => clearTimeout(t);
  }, [ready, base, paging.forBase]);

  useEffect(() => {
    if (!ready || paging.forBase !== base) return;
    writePageToUrl(paging.page, paging.size);
    const id = ++seq.current;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const after = (paging.page - 1) * paging.size;
        const res = await fetch(`${base}&size=${paging.size}${after > 0 ? `&after=${after}` : ""}`);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error((data.error as string) || "Failed to load");
        if (cancelled || id !== seq.current) return;
        const { [listKey]: rows, total: t, next: _next, ...rest } = data;
        void _next;
        const list = (rows as T[]) ?? [];
        const count = typeof t === "number" ? t : null;
        // A page past the end (rows deleted since, or an old link): go to the last one.
        if (list.length === 0 && count && paging.page > 1) {
          const last = Math.max(1, Math.ceil(count / paging.size));
          if (last !== paging.page) {
            setPaging({ forBase: base, page: last, size: paging.size });
            return;
          }
        }
        setItems(list);
        setTotal(count);
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
  }, [base, listKey, ready, paging, generation]);

  const setPage = useCallback(
    (p: number) => setPaging((cur) => ({ forBase: base, page: Math.max(1, p), size: cur.size })),
    [base]
  );
  const setPageSize = useCallback(
    (size: number) =>
      setPaging((cur) => {
        // Keep the first row in view: row (page-1)*old+1 lands on its new page.
        const firstRow = (cur.page - 1) * cur.size;
        return { forBase: base, page: Math.floor(firstRow / size) + 1, size };
      }),
    [base]
  );
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  return { items, total, page, pageSize, setPage, setPageSize, extra, loading, error, reload, csvHref: `${base}&format=csv` };
}
