/**
 * sa-time.ts
 * Times printed on documents and in emails, in South African time.
 *
 * The server's clock is UTC (Vercel), so a bare toLocaleString() or date-fns
 * format() on the server prints a 09:35 signature as 07:35 — on the signed
 * invoice, in the customer's email, everywhere the paper is the record.
 * Every server-side time a person reads goes through here instead.
 * tests/sa-time.test.ts fails if a bare one comes back.
 *
 * No imports: safe for browser bundles too.
 */

/** Every depot is in South Africa (UTC+2, no daylight saving). */
export const SA_TIME_ZONE = "Africa/Johannesburg";

// Fixed names, not Intl's: ICU versions disagree ("Sep" vs "Sept"), and a
// signed document should not change wording with a runtime upgrade.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function saParts(at: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: SA_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value])
  );
}

/** "19 Nov 2026, 09:35" in Johannesburg time, whatever the server's clock says. */
export function formatSaDateTime(at: Date): string {
  const p = saParts(at);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "261119": the South African calendar day of a moment, as YYMMDD. */
export function saDayKey(at: Date): string {
  const p = saParts(at);
  return `${p.year.slice(-2)}${p.month}${p.day}`;
}

/** "19 Nov 2026": the South African calendar day of a moment. */
export function formatSaDate(at: Date): string {
  const p = saParts(at);
  return `${p.day} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}
