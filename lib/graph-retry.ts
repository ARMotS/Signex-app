/**
 * Throttle handling for Microsoft Graph.
 *
 * Graph answers a burst with 429 and a Retry-After header rather than serving
 * it slowly. Treating that as a hard error — which every call in
 * lib/microsoft-graph.ts used to — surfaces to an admin as "close-out failed"
 * for a request Graph never even processed, and to a driver as a signature that
 * would not save.
 *
 * It bites precisely where the app now runs in parallel: batch close-out moves
 * one source file per trip sheet, four at a time.
 *
 * Kept in its own module so the retry rules can be tested directly, rather than
 * only through a live Graph call.
 */

/** Statuses worth retrying. 429 is throttling; 503/504 are transient. */
const RETRYABLE_STATUSES = new Set([429, 503, 504]);

export const MAX_ATTEMPTS = 4;

/**
 * Ceiling on total time spent waiting, well inside the 60s route budget so a
 * retry storm cannot itself cause the timeout it is meant to prevent.
 */
export const MAX_TOTAL_BACKOFF_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before retrying.
 *
 * Graph's Retry-After is authoritative and is honoured whenever present —
 * guessing shorter is what turns a brief throttle into a longer block. It may
 * be either a number of seconds or an HTTP date. Failing that, exponential
 * backoff with jitter, so several instances throttled at the same moment do
 * not all return in lockstep and re-trigger it.
 */
export function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("Retry-After");

  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }

  const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * fetch() for Graph, with throttle handling.
 *
 * Retrying is safe for every method used by this application, including the
 * writes: a 429 or 503 means Graph did not process the request. Request bodies
 * are Buffers rather than streams, so they can be replayed.
 *
 * Returns the final Response — including a still-throttled one once the budget
 * is spent — so `res.ok` handling at each call site is unchanged.
 */
export async function graphFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let spent = 0;

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);

    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= MAX_ATTEMPTS) {
      return res;
    }

    const delay = retryDelayMs(res, attempt);
    if (spent + delay > MAX_TOTAL_BACKOFF_MS) return res;

    // Drain the body so the connection can be reused for the retry.
    await res.arrayBuffer().catch(() => {});

    await sleep(delay);
    spent += delay;
  }
}
