/**
 * The invoice picker's list: the invoice folder's PDFs, each with what the
 * registry knows of it (date, customer) and where it is allocated
 * (lib/invoice-allocation.ts). Read by `GET /api/invoices/picker` for
 * `components/admin/InvoicePicker.tsx` — the manual trip builder and a manual
 * courier dispatch choose invoices from it.
 *
 *   • The files are the invoice folder's originals — the same folder an Excel
 *     trip sheet's INVOICENO is matched against, read the same way as the
 *     Invoices tab (lib/invoice-folder-listing.ts: the index, else the folder).
 *   • Only an AVAILABLE invoice can be picked. Anything else is listed (when
 *     asked for) greyed, naming what holds it: the run and its driver, the
 *     courier sheet, or the signature.
 *   • A file whose name holds no invoice number cannot be picked: nothing
 *     could match it to a delivery, and it has no registry row.
 *
 * Offering is all this does. The deploy guards (ALREADY_ON_RUN, the
 * already-signed skip, the courier blocks) re-check whatever is picked.
 */

import { applyFilter, type FilterAccessors, type FilterState } from "./record-filter";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import {
  ALLOCATION_LABEL,
  readInvoiceAllocations,
  type AllocationState,
  type InvoiceAllocation,
} from "./invoice-allocation";
import type { InvoiceRecordRow } from "./invoice-folder-listing";

export type PickerState = AllocationState | "NO_NUMBER";

export const PICKER_STATE_LABEL: Record<PickerState, string> = {
  ...ALLOCATION_LABEL,
  NO_NUMBER: "No invoice number",
};

/** One file in the invoice folder, as the picker shows it. */
export interface PickerInvoice {
  /** The normalized invoice number — what a pick is keyed by. "" when the filename holds none. */
  key: string;
  /** As the file names it (the stem), for display. */
  invoiceNo: string;
  filename: string;
  recordId: string | null;
  /** The invoice's own date, from the PDF (YYYY-MM-DD). */
  invoiceDate: string | null;
  /** When the file last changed (ISO) — the date shown while the header is unread. */
  fileDate: string;
  customerName: string | null;
  state: PickerState;
  /** The state in words — sent, so the browser need not import this module (it reads the database). */
  stateLabel: string;
  selectable: boolean;
  /** What holds it, when something does. */
  run: { tripSheetId: string; tripName: string; driverName: string | null } | null;
  courierSheet: { id: string; courierSheetNo: string; completed: boolean } | null;
  /** Another file in the folder has the same invoice number. */
  duplicate: boolean;
}

/** The minimum of a folder file the picker needs (lib/invoices.ts's InvoiceFile). */
export interface PickerFile {
  name: string;
  filename: string;
  lastModified: string;
  isSigned: boolean;
}

/**
 * Folder files + registry rows + allocations → picker rows, in folder order.
 * Pure: the route reads, this decides.
 */
export function buildPickerRows(
  files: PickerFile[],
  records: ReadonlyMap<string, Pick<InvoiceRecordRow, "id" | "invoiceDate" | "customerName" | "deliverToName" | "billToName">>,
  allocations: ReadonlyMap<string, InvoiceAllocation>,
  pattern: InvoiceNoPattern
): PickerInvoice[] {
  const keyOf = files.map((f) => normalizeInvoiceNo(f.name, pattern));
  const seen = new Map<string, number>();
  for (const k of keyOf) if (k) seen.set(k, (seen.get(k) ?? 0) + 1);

  return files.map((f, i) => {
    const key = keyOf[i];
    const r = key ? records.get(key) : undefined;
    const a = key ? allocations.get(key) : undefined;
    const state: PickerState = !key ? "NO_NUMBER" : a?.state ?? "AVAILABLE";
    return {
      key,
      invoiceNo: f.name,
      filename: f.filename,
      recordId: r?.id ?? null,
      invoiceDate: r?.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : null,
      fileDate: f.lastModified,
      // The trip sheet's name wins; until a sheet names it, the PDF's.
      customerName: r?.customerName ?? r?.deliverToName ?? r?.billToName ?? null,
      state,
      stateLabel: PICKER_STATE_LABEL[state],
      selectable: state === "AVAILABLE",
      run: a?.run ? { tripSheetId: a.run.tripSheetId, tripName: a.run.tripName, driverName: a.run.driverName } : null,
      courierSheet: a?.courierSheet ?? null,
      duplicate: !!key && (seen.get(key) ?? 0) > 1,
    };
  });
}

/** DD/MM/YYYY, as the trip sheets write it — searchable as typed off paper. */
function slashDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** The record-filter rulebook's view of a picker row (search, date, sort). */
export const PICKER_FILTER: FilterAccessors<PickerInvoice> = {
  search: (r) => [r.invoiceNo, r.filename, r.key, r.customerName, slashDate(r.invoiceDate)],
  // The invoice's date once its header is read; the file's until then, so a
  // date range never hides an invoice only because its PDF is not read yet.
  date: (r) => r.invoiceDate ?? r.fileDate,
  status: (r) => r.state,
  customer: (r) => r.customerName,
  number: (r) => r.invoiceNo,
};

export interface PickerQuery {
  filter: FilterState;
  /** Allocated and unnumbered invoices too (greyed), not only what can be picked. */
  showAll: boolean;
  tzOffset: number;
  /** Filenames to answer for whatever the filter says (a fresh upload, a reopened pick). */
  names: string[];
}

export interface PickerPage {
  items: PickerInvoice[];
  /** Rows the filter (and show) let through. */
  total: number;
  page: number;
  size: number;
  /** For the search + dates in force: how many could be picked, and how many in all. */
  counts: { available: number; all: number };
  /** The `names` asked for, found in the folder. */
  named: PickerInvoice[];
}

/** Filter, count and page the rows. Pure. */
export function pickerPageOf(rows: PickerInvoice[], q: PickerQuery, page: number, size: number, now = new Date()): PickerPage {
  const filtered = applyFilter(rows, q.filter, PICKER_FILTER, now, q.tzOffset);
  const shown = q.showAll ? filtered : filtered.filter((r) => r.selectable);
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const wanted = new Set(q.names.map((n) => n.toLowerCase()));
  return {
    items: shown.slice((current - 1) * size, current * size),
    total: shown.length,
    page: current,
    size,
    counts: { available: filtered.filter((r) => r.selectable).length, all: filtered.length },
    named: wanted.size ? rows.filter((r) => wanted.has(r.filename.toLowerCase())) : [],
  };
}

/**
 * The picker's rows for one scope: allocations read for every numbered file
 * in two queries. `files` and `records` come from lib/invoice-folder-listing.ts.
 */
export async function readPickerRows(
  tenantId: string,
  files: PickerFile[],
  records: ReadonlyMap<string, InvoiceRecordRow>,
  pattern: InvoiceNoPattern
): Promise<PickerInvoice[]> {
  const keys: string[] = [];
  const signedKeys = new Set<string>();
  for (const f of files) {
    const key = normalizeInvoiceNo(f.name, pattern);
    if (!key) continue;
    keys.push(key);
    if (f.isSigned) signedKeys.add(key);
  }
  const allocations = await readInvoiceAllocations(tenantId, keys, { signedKeys });
  return buildPickerRows(files, records, allocations, pattern);
}
