/**
 * courier-sheet.ts
 * The rules of a courier trip sheet, with nothing to do with storage: reading
 * one out of mapped rows, the name its original is kept under, and what stands
 * between it and the courier driver signing for it.
 *
 * Kept free of the database and OneDrive (lib/courier-import.ts does that) so
 * every rule is tested on its own.
 */

import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import type { MappedSheet } from "./sheet-mapping";

// ─── Customers ────────────────────────────────────────────────────────────

/**
 * A company name reduced to what identifies it: case, punctuation and
 * "&"/"and" do not count. "Kilo Hardware & Wholesaler" and "kilo hardware and
 * wholesaler." are one customer. Exact on what is left — never fuzzy, because
 * the contact this finds is who the delivery email goes to.
 */
export function companyKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// ─── Reading a sheet ──────────────────────────────────────────────────────

export interface CourierLine {
  lineNo: number;
  /** The sheet row it came from. */
  rowNumber: number;
  invoiceNo: string;
  invoiceNoNormalized: string | null;
  waybillNo: string;
  /** YYYY-MM-DD, or null. */
  invoiceDate: string | null;
  /** As the row wrote it; null where the cell was blank. */
  parcels: number | null;
}

export interface CourierIssue {
  code:
    | "INVOICE_NOT_FOUND"
    | "ALREADY_SIGNED"
    | "ON_LIVE_RUN"
    | "ON_OTHER_COURIER_SHEET"
    | "NO_CONTACT"
    | "NO_EMAIL"
    /** No longer raised (parcels are summed per row); kept so stored issues still type-check. */
    | "PARCELS_CONFLICT"
    | "DUPLICATE_INVOICE";
  /** "block" holds the sheet in NEEDS_ATTENTION; "warning" is shown only. */
  level: "block" | "warning";
  invoiceNo?: string;
  message: string;
}

export interface CourierSheetRead {
  courierSheetNo: string;
  /** YYYY-MM-DD. */
  sheetDate: string;
  courierCompany: string | null;
  courierService: string | null;
  courierContact: string | null;
  customerName: string;
  lines: CourierLine[];
  waybills: string[];
  parcels: number | null;
  /** Found while reading (duplicate rows). */
  warnings: CourierIssue[];
}

export type CourierReadResult =
  | { ok: true; sheet: CourierSheetRead }
  | {
      ok: false;
      code: "NEEDS_TEMPLATE" | "NEEDS_SHEET_NUMBER" | "MULTIPLE_CUSTOMERS" | "NO_INVOICES";
      error: string;
      customers?: string[];
    };

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * A courier trip sheet out of a mapped sheet (lib/sheet-mapping.ts).
 *
 * Rows with no invoice number are passed over — a footer ("Received in good
 * order and checked") must not become an invoice. A blank waybill or customer
 * cell carries the one above: exports merge them down a consignment.
 */
export function readCourierSheet(
  mapped: MappedSheet,
  opts: { pattern: InvoiceNoPattern; today: string; typedSheetNo?: string }
): CourierReadResult {
  const missing = ["invoiceNumber", "waybillNo", "customerName"].filter(
    (key) => !(key in mapped.columns) && mapped.rows.every((r) => !text(r.values[key]))
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: "NEEDS_TEMPLATE",
      error: `Could not find the ${missing
        .map((k) => ({ invoiceNumber: "invoice number", waybillNo: "waybill", customerName: "customer" })[k])
        .join(", ")} column. Headers found: ${mapped.headers.filter(Boolean).join(", ")}`,
    };
  }

  const courierSheetNo = text(mapped.header.courierSheetNo) || text(opts.typedSheetNo);
  if (!courierSheetNo) {
    return {
      ok: false,
      code: "NEEDS_SHEET_NUMBER",
      error: "No courier sheet number in the file name. Type it in to import the sheet.",
    };
  }

  const warnings: CourierIssue[] = [];
  const lines: CourierLine[] = [];
  const seen = new Map<string, string>();
  const customers = new Map<string, string>();
  let waybill = "";
  let customer = "";

  for (const row of mapped.rows) {
    const invoiceNo = text(row.values.invoiceNumber);
    waybill = text(row.values.waybillNo) || waybill;
    customer = text(row.values.customerName) || customer;
    if (!invoiceNo) continue;

    const normalized = normalizeInvoiceNo(invoiceNo, opts.pattern) || null;
    const key = normalized ?? invoiceNo.toUpperCase();
    if (seen.has(key)) {
      warnings.push({
        code: "DUPLICATE_INVOICE",
        level: "warning",
        invoiceNo,
        message: `Invoice ${invoiceNo} is listed twice (rows ${seen.get(key)} and ${row.rowNumber}) — it is on the sheet once.`,
      });
      continue;
    }
    seen.set(key, String(row.rowNumber));
    if (customer) customers.set(companyKey(customer), customers.get(companyKey(customer)) ?? customer);

    const parcels = typeof row.values.parcels === "number" && row.values.parcels > 0 ? row.values.parcels : null;
    lines.push({
      lineNo: lines.length + 1,
      rowNumber: row.rowNumber,
      invoiceNo,
      invoiceNoNormalized: normalized,
      waybillNo: waybill,
      invoiceDate: text(row.values.invoiceDate) || null,
      parcels,
    });
  }

  if (lines.length === 0) {
    return { ok: false, code: "NO_INVOICES", error: "The sheet lists no invoice numbers." };
  }
  if (customers.size !== 1) {
    const names = [...customers.values()];
    return {
      ok: false,
      code: "MULTIPLE_CUSTOMERS",
      error: names.length
        ? `A courier trip sheet is for one customer; this one names ${names.length}: ${names.join(", ")}.`
        : "The sheet names no customer.",
      customers: names,
    };
  }

  // Parcels are per invoice row: every filled-in NOP counts, down the whole
  // sheet. A blank row's goods are packed in with a row that has a count — when
  // there are only one or two parcels for several invoices, the export writes
  // the total on one row and leaves the rest empty (client).
  const waybills = [...new Set(lines.map((l) => l.waybillNo))];
  const counted = lines.filter((l) => l.parcels !== null);
  const parcels = counted.length ? counted.reduce((sum, l) => sum + l.parcels!, 0) : null;

  return {
    ok: true,
    sheet: {
      courierSheetNo,
      sheetDate: text(mapped.header.sheetDate) || opts.today,
      courierCompany: text(mapped.header.courierCompany) || null,
      courierService: text(mapped.header.courierService) || null,
      courierContact: text(mapped.header.courierContact) || null,
      customerName: [...customers.values()][0],
      lines,
      waybills,
      parcels,
      warnings,
    },
  };
}

// ─── The kept original ────────────────────────────────────────────────────

/** "Kilo Hardware & Wholesaler (Pty) Ltd" → "KILO-HARDWARE-WHOLESALER-PTY-LTD", at most 40. */
export function customerSlug(name: string): string {
  const slug = String(name ?? "")
    .toUpperCase()
    .replace(/&/g, " ")
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "CUSTOMER";
}

/**
 * The name an original is kept under in Courier Trip Sheets/{YYYY}/{MM}/:
 * CTS200189_KILO-HARDWARE.xlsx, then _2, _3 on a clash (never overwritten).
 */
export function originalFileName(sheetNo: string, customerName: string, sourceName: string, attempt = 1): string {
  const ext = /\.xls$/i.test(sourceName) ? ".xls" : ".xlsx";
  const no = String(sheetNo).replace(/[^A-Za-z0-9-]+/g, "") || "SHEET";
  return `CTS${no}_${customerSlug(customerName)}${attempt > 1 ? `_${attempt}` : ""}${ext}`;
}

/** Courier Trip Sheets/{YYYY}/{MM} for a sheet dated YYYY-MM-DD. */
export function originalFolder(sheetDate: string): [string, string, string] {
  const [y, m] = sheetDate.split("-");
  return ["Courier Trip Sheets", y, m];
}

// ─── What stands in the way ───────────────────────────────────────────────

export interface LineFacts {
  invoiceNo: string;
  /** The PDF in the invoice folder, or null. */
  invoiceFile: string | null;
  /** Signed by one of our own drivers already (signed copy, or a signed stop). */
  signedInHouse: boolean;
  /** On a delivery run that has not been signed yet. */
  liveRun: { driverName: string } | null;
  /** On another courier trip sheet of this scope. */
  otherCourierSheet: { courierSheetNo: string } | null;
}

/**
 * Everything to tell the office about a sheet. Blocks are about the goods and
 * the paperwork and stop the courier signing; contact problems only hold back
 * the confirmation email (client decision: the handover goes ahead).
 */
export function assessCourierSheet(input: {
  lines: LineFacts[];
  contact: { found: boolean; email: string | null };
  /** Kept from import — duplicate rows, parcel counts that disagree. */
  readWarnings?: CourierIssue[];
}): CourierIssue[] {
  const issues: CourierIssue[] = [];
  for (const line of input.lines) {
    const inv = line.invoiceNo;
    if (!line.invoiceFile) {
      issues.push({
        code: "INVOICE_NOT_FOUND",
        level: "block",
        invoiceNo: inv,
        message: `Invoice ${inv} has no PDF in the invoice folder. Upload it — the courier signs on the invoice itself.`,
      });
    }
    if (line.signedInHouse) {
      issues.push({
        code: "ALREADY_SIGNED",
        level: "block",
        invoiceNo: inv,
        message: `Invoice ${inv} was already signed for by one of our drivers. Remove it from this sheet if it was delivered.`,
      });
    }
    if (line.liveRun) {
      issues.push({
        code: "ON_LIVE_RUN",
        level: "block",
        invoiceNo: inv,
        message: `Invoice ${inv} is on ${line.liveRun.driverName}'s delivery run. Take it off one or the other, so it is not sent twice.`,
      });
    }
    if (line.otherCourierSheet) {
      issues.push({
        code: "ON_OTHER_COURIER_SHEET",
        level: "block",
        invoiceNo: inv,
        message: `Invoice ${inv} is also on courier trip sheet ${line.otherCourierSheet.courierSheetNo}. Remove it from one of them.`,
      });
    }
  }

  if (!input.contact.found) {
    issues.push({
      code: "NO_CONTACT",
      level: "warning",
      message:
        "No contact for this customer. Add or link one so the delivery confirmation email can be sent — the courier can still sign.",
    });
  } else if (!input.contact.email) {
    issues.push({
      code: "NO_EMAIL",
      level: "warning",
      message:
        "The customer's contact has no email. Add one so the delivery confirmation email can be sent — the courier can still sign.",
    });
  }

  return [...issues, ...(input.readWarnings ?? [])];
}

export function blocksHandover(issues: CourierIssue[]): boolean {
  return issues.some((i) => i.level === "block");
}

/** Today in South Africa, as YYYY-MM-DD. */
export function todayInJohannesburg(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now);
}

// ─── After the handover ───────────────────────────────────────────────────

/**
 * Where a collected sheet stands with its customer, for the list, the
 * dashboard and the nav badge (null while the sheet is still open):
 * - filing: signed copies not all filed yet — the email waits for them
 * - email_problem: no address on file, or the email failed
 * - sending: the email is due or going out now
 * - awaiting: sent, not confirmed yet
 * - reminded: the one reminder went, not confirmed yet
 * - no_answer: two days after the reminder and still nothing — phone them
 * - confirmed: the customer confirmed the parcels arrived
 */
export type ConfirmationState = "filing" | "email_problem" | "sending" | "awaiting" | "reminded" | "no_answer" | "confirmed";

/** How long after the reminder the office is asked to follow up by phone. */
export const NO_ANSWER_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

export function confirmationState(
  r: {
    status: string;
    filingCompletedAt: Date | string | null;
    emailStatus: string;
    reminderSentAt: Date | string | null;
    confirmedAt: Date | string | null;
  },
  now = new Date()
): ConfirmationState | null {
  if (r.status === "DELIVERED" || r.confirmedAt) return "confirmed";
  if (r.status !== "COLLECTED") return null;
  if (!r.filingCompletedAt) return "filing";
  if (r.emailStatus === "FAILED" || r.emailStatus === "NO_EMAIL") return "email_problem";
  if (r.emailStatus !== "SENT") return "sending";
  if (!r.reminderSentAt) return "awaiting";
  return now.getTime() - new Date(r.reminderSentAt).getTime() >= NO_ANSWER_AFTER_MS ? "no_answer" : "reminded";
}

/** The states the office has to act on — what the nav badge counts. */
export const NEEDS_OFFICE: ConfirmationState[] = ["filing", "email_problem", "no_answer"];
