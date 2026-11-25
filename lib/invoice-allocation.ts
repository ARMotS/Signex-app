/**
 * Where an invoice is allocated: free to put on a trip, or already held by a
 * delivery run, a courier sheet, or a signature.
 *
 * Derived on read, never stored (decision 2026-11-24). A stored status would
 * need a sync call in every path that moves an invoice (deploy, sign, remove,
 * reallocate, complete, courier import, collect, delete) and would drift. The
 * facts are already there:
 *
 *   Stop  PENDING / IN_PROGRESS          → ON_RUN            (live trip; completion deletes the stop)
 *   CourierTripSheet NEEDS_ATTENTION /
 *                    AWAITING_COLLECTION → ON_COURIER_SHEET
 *   CourierTripSheet COLLECTED /
 *                    DELIVERED           → WITH_COURIER      (shown "Completed" on the Courier page)
 *   Stop  SIGNED, or a signed copy filed → SIGNED            (the copy outlives the stop)
 *   none of these                        → AVAILABLE
 *
 * A removed stop (RemovedStop: refused at the door, or its PDF deleted) is a
 * deleted row, so its invoice reads AVAILABLE again — today's rule; nothing
 * stops it being deployed again. A draft (session 7, TripDraft) will add an
 * ON_DRAFT state here.
 *
 * Only AVAILABLE is selectable. This is for the screens that offer invoices to
 * choose from (the invoice picker, a manual courier dispatch) and for
 * warnings; the deploy guards keep their own checks — ALREADY_ON_RUN, the
 * already-signed skip, the courier sheet's blocks — and are not replaced by it.
 *
 * Keyed by the normalized invoice number (`normalizeInvoiceNo`), the key the
 * Invoice registry, Stop and CourierTripSheetInvoice all store.
 */

import { scopedPrisma } from "./db-scoped";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import { isCourierCompleted } from "./courier-sheet";
import { WIDE_IN_LIST } from "./invoice-chain";

export type AllocationState = "AVAILABLE" | "ON_RUN" | "ON_COURIER_SHEET" | "WITH_COURIER" | "SIGNED";

export const ALLOCATION_LABEL: Record<AllocationState, string> = {
  AVAILABLE: "Available",
  ON_RUN: "On a run",
  ON_COURIER_SHEET: "On a courier sheet",
  WITH_COURIER: "Sent by courier",
  SIGNED: "Signed",
};

export interface AllocationFacts {
  /** Every stop in the scope naming this invoice. All stops are on live trips. */
  stops: { status: string; tripSheetId: string; tripName: string; driverName: string | null }[];
  /** Every courier sheet line naming it, with its sheet's status. */
  courier: { courierSheetId: string; courierSheetNo: string; status: string }[];
  /** A signed copy is filed (the signed/ folder). */
  signedCopy: boolean;
}

export interface InvoiceAllocation {
  state: AllocationState;
  selectable: boolean;
  /** The live run holding it unsigned — what the screen names. */
  run: { tripSheetId: string; tripName: string; driverName: string | null; stopStatus: string } | null;
  /** The courier sheet holding it — an open one first. */
  courierSheet: { id: string; courierSheetNo: string; completed: boolean } | null;
  /** Signed for, by a driver or (once filed) a courier. */
  signed: boolean;
}

/**
 * The state, in order of what the office can still act on: a run, then an
 * open courier sheet, then a completed one, then a signature.
 */
export function allocationOf(f: AllocationFacts): InvoiceAllocation {
  const live = f.stops.find((s) => s.status !== "SIGNED");
  const openSheet = f.courier.find((c) => !isCourierCompleted(c.status));
  const doneSheet = f.courier.find((c) => isCourierCompleted(c.status));
  const sheet = openSheet ?? doneSheet;
  const signed = f.signedCopy || f.stops.some((s) => s.status === "SIGNED");

  const state: AllocationState = live
    ? "ON_RUN"
    : openSheet
      ? "ON_COURIER_SHEET"
      : doneSheet
        ? "WITH_COURIER"
        : signed
          ? "SIGNED"
          : "AVAILABLE";

  return {
    state,
    selectable: state === "AVAILABLE",
    run: live
      ? { tripSheetId: live.tripSheetId, tripName: live.tripName, driverName: live.driverName, stopStatus: live.status }
      : null,
    courierSheet: sheet
      ? { id: sheet.courierSheetId, courierSheetNo: sheet.courierSheetNo, completed: isCourierCompleted(sheet.status) }
      : null,
    signed,
  };
}

// ─── Reading the facts ────────────────────────────────────────────────────

function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys.filter(Boolean))];
}

/** An IN list, or — for a whole folder of ids — every row that has a key. */
function keyFilter(keys: string[]) {
  return keys.length > WIDE_IN_LIST ? { not: null } : { in: keys };
}

async function readCourierLines(tenantId: string, keys: string[]) {
  const wanted = new Set(keys);
  const rows = await scopedPrisma(tenantId).courierTripSheetInvoice.findMany({
    where: { invoiceNoNormalized: keyFilter(keys) },
    select: {
      invoiceNoNormalized: true,
      courierSheet: { select: { id: true, courierSheetNo: true, status: true } },
    },
  });
  const by = new Map<string, AllocationFacts["courier"]>();
  for (const r of rows) {
    const key = r.invoiceNoNormalized;
    if (!key || !wanted.has(key)) continue;
    const list = by.get(key) ?? [];
    list.push({ courierSheetId: r.courierSheet.id, courierSheetNo: r.courierSheet.courierSheetNo, status: r.courierSheet.status });
    by.set(key, list);
  }
  return by;
}

async function readStops(tenantId: string, keys: string[]) {
  const wanted = new Set(keys);
  const rows = await scopedPrisma(tenantId).stop.findMany({
    where: { invoiceNoNormalized: keyFilter(keys) },
    select: {
      invoiceNoNormalized: true,
      status: true,
      tripSheet: { select: { id: true, sourceFilename: true, driver: { select: { name: true } } } },
    },
  });
  const by = new Map<string, AllocationFacts["stops"]>();
  for (const r of rows) {
    const key = r.invoiceNoNormalized;
    if (!key || !wanted.has(key)) continue;
    const list = by.get(key) ?? [];
    list.push({
      status: r.status,
      tripSheetId: r.tripSheet.id,
      tripName: r.tripSheet.sourceFilename,
      driverName: r.tripSheet.driver?.name ?? null,
    });
    by.set(key, list);
  }
  return by;
}

/**
 * The allocation of each invoice, by normalized number, in two queries.
 * `signedKeys` are the numbers with a signed copy filed — the caller has the
 * folder (or its index), as `chainStatuses` is handed `delivered`.
 */
export async function readInvoiceAllocations(
  tenantId: string,
  keys: string[],
  opts: { signedKeys?: ReadonlySet<string> } = {}
): Promise<Map<string, InvoiceAllocation>> {
  const wanted = uniqueKeys(keys);
  const result = new Map<string, InvoiceAllocation>();
  if (wanted.length === 0) return result;

  const [stops, courier] = await Promise.all([readStops(tenantId, wanted), readCourierLines(tenantId, wanted)]);
  for (const key of wanted) {
    result.set(
      key,
      allocationOf({
        stops: stops.get(key) ?? [],
        courier: courier.get(key) ?? [],
        signedCopy: opts.signedKeys?.has(key) ?? false,
      })
    );
  }
  return result;
}

// ─── The Excel preview's courier warning ─────────────────────────────────

/**
 * An invoice on the trip sheet that a courier sheet in this scope already
 * holds. A warning on the preview, not a block (user decision, 2026-11-25):
 * an open courier sheet blocks itself at signing (ON_LIVE_RUN) once the
 * delivery is out, and a completed one has usually filed a signed copy, which
 * the already-signed check skips.
 */
export interface OnCourierSheetInvoice {
  invoiceNumber: string;
  courierSheetNo: string;
  /** The courier driver has signed for it (the Courier page's Completed). */
  completed: boolean;
}

export async function findOnCourierSheet(
  tenantId: string,
  invoiceNumbers: string[],
  pattern: InvoiceNoPattern
): Promise<OnCourierSheetInvoice[]> {
  const byKey = new Map<string, string>();
  for (const n of invoiceNumbers) {
    const key = normalizeInvoiceNo(n, pattern);
    if (key && !byKey.has(key)) byKey.set(key, n);
  }
  if (byKey.size === 0) return [];

  const lines = await readCourierLines(tenantId, [...byKey.keys()]);
  const found: OnCourierSheetInvoice[] = [];
  for (const [key, invoiceNumber] of byKey) {
    const sheets = lines.get(key);
    if (!sheets?.length) continue;
    const sheet = sheets.find((s) => !isCourierCompleted(s.status)) ?? sheets[0];
    found.push({ invoiceNumber, courierSheetNo: sheet.courierSheetNo, completed: isCourierCompleted(sheet.status) });
  }
  return found;
}
