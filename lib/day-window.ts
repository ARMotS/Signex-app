/**
 * "Today", from the point of view of the person looking at the screen.
 *
 * Timestamps are stored in UTC and there is no per-tenant timezone setting, so
 * a server-side midnight would cut the day in the wrong place for everyone who
 * is not on UTC — a depot in Johannesburg would see the first two hours of its
 * morning filed under yesterday.
 *
 * The client therefore sends its own offset (`new Date().getTimezoneOffset()`,
 * which is minutes to ADD to local time to get UTC, so UTC+2 sends -120). This
 * is a reporting window inside the caller's own scope, not an authorisation
 * input — the worst a bogus value can do is show that caller the wrong slice of
 * their own data, which is why it is merely clamped rather than distrusted.
 */

/** Real-world offsets top out at ±14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

export interface DayWindow {
  /** Inclusive start of the local day, as an absolute instant. */
  start: Date;
  /** Exclusive end — the start of the next local day. */
  end: Date;
  /** The clamped offset actually used, in minutes. */
  offsetMinutes: number;
}

/**
 * Parse a `tzOffset` query parameter into a usable offset.
 * Anything missing, non-numeric or out of range falls back to UTC.
 */
export function parseTzOffset(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_OFFSET_MINUTES, Math.min(MAX_OFFSET_MINUTES, Math.trunc(n)));
}

/**
 * The local day containing `now`, expressed as an absolute UTC interval.
 *
 * @param offsetMinutes As returned by `Date.prototype.getTimezoneOffset()` on
 *   the client: minutes to add to local time to reach UTC.
 */
export function dayWindow(now: Date = new Date(), offsetMinutes = 0): DayWindow {
  const offset = Math.max(
    -MAX_OFFSET_MINUTES,
    Math.min(MAX_OFFSET_MINUTES, Math.trunc(offsetMinutes) || 0)
  );
  const offsetMs = offset * 60_000;

  // Shift into local time, truncate to the day there, shift back.
  const local = new Date(now.getTime() - offsetMs);
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  );

  const start = new Date(localMidnight + offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end, offsetMinutes: offset };
}

// ─── Reporting ranges ─────────────────────────────────────────────────────

export type ReportRange = "day" | "week" | "month";

export function parseReportRange(raw: string | null | undefined): ReportRange {
  return raw === "week" || raw === "month" ? raw : "day";
}

export interface ReportWindow extends DayWindow {
  range: ReportRange;
  /** Every local day in the window, in order, as `YYYY-MM-DD` keys. */
  dayKeys: string[];
}

/**
 * The local day, calendar week or calendar month containing `now`.
 *
 * Calendar-based rather than rolling: a dispatcher comparing this week to last
 * week means Monday-to-Sunday, and a rolling seven days would silently shift
 * the comparison every time they looked. The week starts on Monday.
 */
export function reportWindow(
  now: Date = new Date(),
  offsetMinutes = 0,
  range: ReportRange = "day"
): ReportWindow {
  const today = dayWindow(now, offsetMinutes);
  const offsetMs = today.offsetMinutes * 60_000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  let start = today.start;
  let end = today.end;

  if (range === "week") {
    // getUTCDay on the shifted instant is the LOCAL weekday. Sunday is 0, and
    // a Monday-based week wants it treated as day 7.
    const localToday = new Date(today.start.getTime() - offsetMs);
    const weekday = localToday.getUTCDay() || 7;
    start = new Date(today.start.getTime() - (weekday - 1) * DAY_MS);
    end = new Date(start.getTime() + 7 * DAY_MS);
  } else if (range === "month") {
    const localToday = new Date(today.start.getTime() - offsetMs);
    const firstOfMonth = Date.UTC(
      localToday.getUTCFullYear(),
      localToday.getUTCMonth(),
      1
    );
    const firstOfNext = Date.UTC(
      localToday.getUTCFullYear(),
      localToday.getUTCMonth() + 1,
      1
    );
    start = new Date(firstOfMonth + offsetMs);
    end = new Date(firstOfNext + offsetMs);
  }

  const dayKeys: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    dayKeys.push(localDateKey(new Date(t), today.offsetMinutes));
  }

  return { start, end, offsetMinutes: today.offsetMinutes, range, dayKeys };
}

/**
 * Which local day a timestamp falls on, as `YYYY-MM-DD`.
 *
 * Used to bucket rows into days in application code, because the database
 * stores UTC and cannot know the viewer's offset.
 */
export function localDateKey(date: Date, offsetMinutes = 0): string {
  const local = new Date(date.getTime() - offsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
