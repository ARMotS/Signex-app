"use client";

/**
 * The one numbered pager for the office's lists (Invoices, Collections,
 * Credits, Courier): "Showing a–b of N", « ‹ 1 … 4 5 6 … 20 › », and an
 * optional rows-per-page choice. On a phone the numbered buttons do not fit
 * beside the count, so a compact Prev · n / N · Next takes their place.
 */

export const PAGE_SIZES = [25, 50, 100] as const;

interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /** Offer a choice of rows per page. */
  onPageSize?: (size: number) => void;
  /** The choices, smallest first. Default 25 / 50 / 100. */
  sizes?: readonly number[];
  disabled?: boolean;
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

export default function Pager({ page, pageSize, total, onPage, onPageSize, sizes = PAGE_SIZES, disabled }: PagerProps) {
  const pages = pageCountOf(total, pageSize);
  // One page and nothing to choose: no bar. (With a size choice the bar stays
  // while a smaller size would still page — so 100 can be switched back.)
  if (total === 0 || (pages <= 1 && (!onPageSize || total <= sizes[0]))) return null;
  const current = Math.min(Math.max(1, page), pages);
  const first = (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);
  const go = (p: number) => {
    if (!disabled && p !== current && p >= 1 && p <= pages) onPage(p);
  };
  const quiet =
    "px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 sm:px-5 py-3 border-t border-ink-border bg-ink-surface/50">
      <div className="flex items-center gap-3">
        <p className="text-xs font-mono text-ink-muted">
          Showing {first}–{last} of {total}
        </p>
        {onPageSize && (
          <label className="flex items-center gap-1.5 text-xs font-mono text-ink-muted">
            <span className="sr-only sm:not-sr-only">Rows</span>
            <select
              value={pageSize}
              disabled={disabled}
              onChange={(e) => onPageSize(Number(e.target.value))}
              aria-label="Rows per page"
              className="h-6 px-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black"
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {pages > 1 && (
        <>
          <div className="flex sm:hidden items-center justify-between gap-2">
            <button type="button" onClick={() => go(current - 1)} disabled={disabled || current === 1} className="act flex-1 justify-center !h-9">
              ‹ Prev
            </button>
            <span className="text-xs font-mono text-ink-muted px-2 whitespace-nowrap">
              {current} / {pages}
            </span>
            <button type="button" onClick={() => go(current + 1)} disabled={disabled || current === pages} className="act flex-1 justify-center !h-9">
              Next ›
            </button>
          </div>
          <nav className="hidden sm:flex items-center gap-1" aria-label="Pages">
            <button type="button" onClick={() => go(1)} disabled={disabled || current === 1} className={quiet} aria-label="First page">
              «
            </button>
            <button type="button" onClick={() => go(current - 1)} disabled={disabled || current === 1} className={quiet}>
              ‹ Prev
            </button>
            {Array.from({ length: pages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === pages || Math.abs(p - current) <= 2)
              .map((p, idx, arr) => (
                <span key={p} className="flex items-center">
                  {idx > 0 && arr[idx - 1] !== p - 1 && <span className="px-1 text-xs text-ink-muted-light">…</span>}
                  <button
                    type="button"
                    onClick={() => go(p)}
                    disabled={disabled}
                    aria-current={p === current ? "page" : undefined}
                    className={`w-7 h-7 text-xs font-mono rounded transition-colors ${
                      p === current ? "bg-ink-black text-white" : "text-ink-muted hover:text-ink-black hover:bg-ink-surface"
                    }`}
                  >
                    {p}
                  </button>
                </span>
              ))}
            <button type="button" onClick={() => go(current + 1)} disabled={disabled || current === pages} className={quiet}>
              Next ›
            </button>
            <button type="button" onClick={() => go(pages)} disabled={disabled || current === pages} className={quiet} aria-label="Last page">
              »
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
