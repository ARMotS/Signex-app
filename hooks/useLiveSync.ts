"use client";

/**
 * Live updates by polling the change feed — ONE loop per tab.
 *
 * `LiveSyncProvider` sits in the admin and driver layouts and is the only
 * thing that polls /api/sync. Pages subscribe with `useLiveSync(onChange)` and
 * are called whenever the cursor moves, so a page refetches only when there is
 * something to refetch.
 *
 * The same response carries everything else a tab used to poll for on its own
 * timer, because each poll is a function invocation billed on its own:
 *
 *   - the SESSION check: a revoked or evicted session answers 401 here (every
 *     API call validates it), and only then does the layout ask
 *     /api/auth/session why — which clears the cookie and says "signed out
 *     elsewhere";
 *   - the office's COURIER badge (`attention`).
 *
 * Every guard below exists because the alternative costs somebody something
 * real:
 *
 *   - A HIDDEN tab does not poll. A driver's phone spends most of the shift in
 *     a pocket with the screen off; polling there burns battery and mobile data
 *     to learn nothing.
 *   - An OFFLINE device does not poll, and resumes the moment it reconnects.
 *   - Requests never STACK. A slow response on a bad connection must not queue
 *     a second request behind it — that is how a struggling phone turns into a
 *     stampede.
 *   - Errors BACK OFF exponentially, so an outage does not become a retry storm
 *     from a hundred devices at once.
 *
 * Waking on focus/visibility matters more than the interval: the common case
 * is a driver pulling the phone out at a stop, and that should feel instant
 * rather than "up to thirty seconds stale".
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * 30s while a page is following live data, not the 12s it was. Every open tab
 * polls all day (the dashboard is a wallboard), and the wake-on-focus above is
 * what makes a newly deployed trip sheet reach a driver quickly — not the
 * interval.
 */
const LIVE_INTERVAL_MS = 30_000;

/**
 * A page with nothing subscribed (Contacts, Settings, the sign screen) only
 * needs the session check and the badge, which ran once a minute before.
 */
const IDLE_INTERVAL_MS = 60_000;

/** Ceiling for error backoff — an outage settles to one attempt a minute. */
const MAX_BACKOFF_MS = 60_000;

type Listener = () => void;

interface LiveSync {
  subscribe(listener: Listener): () => void;
}

const LiveSyncContext = createContext<LiveSync | null>(null);

export interface LiveSyncProviderProps {
  children: ReactNode;
  /**
   * /api/sync answered 401/403. The layout re-checks the session, which
   * redirects to sign-in if it is gone. Polling carries on at the backoff
   * ceiling in case it was not (a company admin with no branch chosen).
   */
  onAuthProblem: () => void;
  /** The office's courier badge. Never called for a driver. */
  onAttention?: (count: number) => void;
}

export function LiveSyncProvider({ children, onAuthProblem, onAttention }: LiveSyncProviderProps) {
  const [{ listeners, value }] = useState(() => {
    const listeners = new Set<Listener>();
    const value: LiveSync = {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    return { listeners, value };
  });

  // Held in a ref so a layout passing inline arrows does not tear down and
  // rebuild the polling loop on every render.
  const callbacks = useRef({ onAuthProblem, onAttention });
  useEffect(() => {
    callbacks.current = { onAuthProblem, onAttention };
  });

  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor: string | null = null;
    let backoff = LIVE_INTERVAL_MS;

    const interval = () => (listeners.size > 0 ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS);

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delay: number) => {
      clear();
      if (stopped) return;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (stopped || inFlight) return;

      // Deliberately do NOT reschedule while hidden or offline — the listeners
      // below restart the loop on the event that makes polling useful again.
      if (document.hidden) return;
      if (!navigator.onLine) return;

      inFlight = true;
      try {
        const res = await fetch("/api/sync", { cache: "no-store" });

        // Respect the limiter rather than fighting it.
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After"));
          backoff = Math.min(
            MAX_BACKOFF_MS,
            retryAfter > 0 ? retryAfter * 1000 : backoff * 2
          );
          schedule(backoff);
          return;
        }

        if (res.status === 401 || res.status === 403) {
          callbacks.current.onAuthProblem();
          schedule(MAX_BACKOFF_MS);
          return;
        }

        if (!res.ok) throw new Error(`sync ${res.status}`);

        const data: { cursor?: string; attention?: number } = await res.json();
        backoff = LIVE_INTERVAL_MS;

        if (typeof data.attention === "number") callbacks.current.onAttention?.(data.attention);

        if (typeof data.cursor === "string") {
          if (cursor === null) {
            // First observation. The page loaded its own data moments ago, so
            // adopt the cursor rather than firing a redundant refetch.
            cursor = data.cursor;
          } else if (data.cursor !== cursor) {
            cursor = data.cursor;
            for (const listener of [...listeners]) listener();
          }
        }

        schedule(interval());
      } catch {
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        schedule(backoff);
      } finally {
        inFlight = false;
      }
    };

    /** Something happened that makes a check worthwhile right now. */
    const wake = () => {
      if (stopped || document.hidden || !navigator.onLine) return;
      backoff = LIVE_INTERVAL_MS;
      schedule(0);
    };

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    // The offline queue just drained, so the server holds writes this tab has
    // not seen yet. Dispatched by lib/offline-sync.ts.
    window.addEventListener("signex:sync-complete", wake as EventListener);

    // At once: this first answer is the session check on load, the badge, and
    // the cursor baseline the pages' own first fetch is compared against.
    schedule(0);

    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("signex:sync-complete", wake as EventListener);
    };
  }, [listeners]);

  return createElement(LiveSyncContext.Provider, { value }, children);
}

export interface UseLiveSyncOptions {
  /** Set false to suspend entirely (e.g. before a driver has signed in). */
  enabled?: boolean;
}

/** Call `onChange` whenever the caller's data moves. Needs a `LiveSyncProvider` above it. */
export function useLiveSync(
  onChange: () => void,
  { enabled = true }: UseLiveSyncOptions = {}
): void {
  const liveSync = useContext(LiveSyncContext);

  // Held in a ref so a caller passing an inline arrow does not resubscribe on
  // every render. Assigned in an effect rather than during render, which would
  // be a side effect in the render phase.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;
    if (!liveSync) {
      // A page outside the admin/driver layouts would silently never update.
      if (process.env.NODE_ENV !== "production") {
        console.error("useLiveSync needs a LiveSyncProvider above it");
      }
      return;
    }
    return liveSync.subscribe(() => onChangeRef.current());
  }, [liveSync, enabled]);
}
