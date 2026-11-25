/**
 * trip-number-format.ts
 * The number a manual trip is named by: SX-{CODE}-{YYMMDD}-{NN}.
 *
 * A sheet from the Trip program is named by its file (ts-102371-p5.xls) and
 * keeps that name; only a trip built in Signex is issued one of these. The SX
 * prefix and the dashes make the two impossible to confuse: the Trip program
 * names files ts-/cts- and every one of them has an extension.
 *
 *   SX-P5-261125-01   branch code P5, 25 Nov 2026, the first that day
 *   SX-261125-01      the same, before a branch code is set in Settings
 *
 * The date is the Johannesburg day the number was issued; the sequence comes
 * from TripNumberCounter (lib/trip-number.ts) and is kept per scope per day,
 * independent of the code, so changing the code never repeats a number.
 *
 * Imports only lib/sa-time.ts (which has none), so Settings previews the same
 * format in the browser.
 */
import { saDayKey } from "./sa-time";

export const MANUAL_TRIP_PREFIX = "SX";
export const BRANCH_CODE_MAX = 6;

const BRANCH_CODE = /^[A-Z0-9]+$/;
const MANUAL_TRIP_NUMBER = /^SX-(?:([A-Z0-9]{1,6})-)?(\d{6})-(\d{2,})$/;

/**
 * Validate the Settings field. Letters and digits only, up to six, stored
 * uppercase; spaces and dashes typed around it ("p 5", "P-5") are dropped.
 * Blank is a valid answer: no code.
 */
export function readBranchCode(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").replace(/[\s-]+/g, "").toUpperCase();
  if (!value) return { ok: true, value: "" };
  if (!BRANCH_CODE.test(value)) {
    return { ok: false, error: "A branch code is letters and digits only (for example P5)." };
  }
  if (value.length > BRANCH_CODE_MAX) {
    return { ok: false, error: `A branch code is at most ${BRANCH_CODE_MAX} characters.` };
  }
  return { ok: true, value };
}

/** "SX-P5-261125-01". `seq` is 1-based; past 99 it simply grows (…-100). */
export function formatManualTripNumber(code: string | null | undefined, day: string, seq: number): string {
  const parts = [MANUAL_TRIP_PREFIX];
  if (code) parts.push(code);
  parts.push(day, String(seq).padStart(2, "0"));
  return parts.join("-");
}

/** The first number a day would get, for the Settings preview. */
export function exampleManualTripNumber(code: string | null | undefined, at: Date = new Date()): string {
  return formatManualTripNumber(code, saDayKey(at), 1);
}

/** Whether a trip name is an issued manual trip number. */
export function isManualTripNumber(name: string | null | undefined): boolean {
  return MANUAL_TRIP_NUMBER.test(String(name ?? ""));
}
