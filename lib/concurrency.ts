/**
 * Bounded parallelism.
 *
 * Batch operations here are not CPU work — they are database round trips and
 * OneDrive file moves, so running them one at a time leaves the request idle
 * for almost its entire duration. Closing out a day's twenty trip sheets that
 * way can outlast the serverless function's time limit.
 *
 * Unbounded `Promise.all` is the wrong correction. Two ceilings make it
 * counterproductive:
 *   - the pg pool is deliberately small (see lib/db.ts), so surplus queries
 *     queue on connections rather than progressing;
 *   - Microsoft Graph throttles a burst of writes with 429s, which turns
 *     "faster" into "retried".
 *
 * A small fixed width keeps the pipe full without tripping either.
 */

/** Matches the default pg pool size, so callers cannot starve their own queries. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most `limit` in flight at once.
 *
 * Results are returned in INPUT order regardless of completion order, so a
 * caller can pair them back up with what it passed in. A rejection propagates;
 * callers that want partial success should resolve to a result object instead
 * of throwing (see completeTripSheets in lib/trip-data.ts).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_CONCURRENCY
): Promise<R[]> {
  if (items.length === 0) return [];

  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);

  // Shared cursor — each worker claims the next index rather than taking a
  // fixed slice, so one slow item cannot leave other workers idle.
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, worker));

  return results;
}
