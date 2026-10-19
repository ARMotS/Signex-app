/**
 * The Exceptions screen: everything in the invoice → collection → credit note
 * chain that someone in the office has to act on, in one place, with counts.
 *
 * Each list reads this scope only (the scoped client). A SUPER_ADMIN sees one
 * branch at a time through the scope switcher, as everywhere else — never two
 * scopes mixed in one list.
 *
 * Collections outlive their trips (detached at completion), so every list
 * below covers live AND closed-out collections without reading the archive.
 */

import { scopedPrisma } from "./db-scoped";
import { readUncreditedAlertDays } from "./config";

export type ExceptionKey =
  | "uncredited"
  | "awaiting_approval"
  | "note_no_collection"
  | "note_unmatched_or_manual"
  | "stub_invoice"
  | "credit_variance"
  | "not_as_listed"
  | "sheet_problem"
  | "failed_collection"
  | "notes_to_sign";

export interface ExceptionRow {
  /** A stable key for the row. */
  id: string;
  kind: "collection" | "credit_note";
  /** The record's own number: a collection no or a credit note no. */
  number: string | null;
  collectionType?: string;
  originalInvoiceNo?: string | null;
  invoiceNo?: string | null;
  customer: string | null;
  /** The date the row is about (collected, received…), ISO. */
  date: string | null;
  detail: string;
  /** Where the office acts on it. */
  href: string;
  /** For tinting: the record's own status. */
  status: string;
}

export interface ExceptionList {
  key: ExceptionKey;
  title: string;
  description: string;
  count: number;
  rows: ExceptionRow[];
}

/** Rows shown per list. The count is always the full count. */
const ROWS_PER_LIST = 100;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function loadExceptions(
  tenantId: string,
  { from, to, rowsPerList = ROWS_PER_LIST }: { from?: Date; to?: Date; rowsPerList?: number } = {}
): Promise<{ lists: ExceptionList[]; uncreditedDays: number }> {
  const db = scopedPrisma(tenantId);
  const uncreditedDays = await readUncreditedAlertDays(tenantId);
  const cutoff = new Date(Date.now() - uncreditedDays * 86_400_000);
  const inRange = (d: Date | null) => (!from || (d && d >= from)) && (!to || (d && d <= to));

  const collectionSelect = {
    id: true,
    collectionNo: true,
    type: true,
    status: true,
    originalInvoiceNo: true,
    invoiceId: true,
    customerName: true,
    collectedAt: true,
    createdAt: true,
    hasVariance: true,
    exceptionReason: true,
    failReason: true,
    sheetStatus: true,
    tripSheetId: true,
    creditReview: true,
    stop: { select: { customerName: true } },
  } as const;

  const [collections, notes, stubInvoices] = await Promise.all([
    db.collection.findMany({
      where: {
        OR: [
          { status: { in: ["COLLECTED", "PARTIAL", "NOT_AVAILABLE"] } },
          { hasVariance: true },
          { status: "PENDING", tripSheetId: { not: null }, sheetStatus: { in: ["MISSING", "NEEDS_REVIEW"] } },
        ],
      },
      select: {
        ...collectionSelect,
        lines: { select: { id: true, qtyCollected: true, type: true } },
        creditNoteLinks: {
          where: { source: { in: ["AUTO", "MANUAL"] } },
          select: { creditNote: { select: { status: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
    db.creditNote.findMany({
      where: { status: { not: "REJECTED" } },
      select: {
        id: true,
        creditNo: true,
        invoiceNo: true,
        invoiceId: true,
        status: true,
        deliverToName: true,
        billToName: true,
        creditDate: true,
        createdAt: true,
        issues: true,
        collections: { select: { source: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 2000,
    }),
    db.invoice.findMany({ where: { isStub: true }, select: { id: true } }),
  ]);

  // What signed credit notes paid for, per collection line — one query.
  const lineIds = collections.flatMap((c) => c.lines.map((l) => l.id));
  const allocations = lineIds.length
    ? await db.creditNoteAllocation.findMany({
        where: { collectionLineId: { in: lineIds }, creditNote: { status: "SIGNED" } },
        select: { collectionLineId: true, qty: true },
      })
    : [];
  const creditedByLine = new Map<string, number>();
  for (const a of allocations) {
    creditedByLine.set(a.collectionLineId, (creditedByLine.get(a.collectionLineId) ?? 0) + Number(a.qty));
  }
  const stubIds = new Set(stubInvoices.map((i) => i.id));

  type C = (typeof collections)[number];
  const customerOf = (c: C) => c.stop?.customerName ?? c.customerName ?? null;
  const collectionHref = (c: C) =>
    c.invoiceId ? `/invoices/${c.invoiceId}` : c.tripSheetId ? "/trip-sheet" : "/collections";
  const collectionRow = (c: C, detail: string, href?: string): ExceptionRow => ({
    id: `c-${c.id}`,
    kind: "collection",
    number: c.collectionNo,
    collectionType: c.type,
    originalInvoiceNo: c.originalInvoiceNo,
    customer: customerOf(c),
    date: iso(c.collectedAt ?? c.createdAt),
    detail,
    href: href ?? collectionHref(c),
    status: c.status,
  });
  const isCR = (c: C) => c.type === "CREDIT_RETURN" && !!c.originalInvoiceNo;
  const came = (c: C) => c.status === "COLLECTED" || c.status === "PARTIAL";
  const signedNote = (c: C) => c.creditNoteLinks.some((l) => l.creditNote.status === "SIGNED");
  const collectedItems = (c: C) =>
    c.lines.filter((l) => l.type === "CREDIT_RETURN").reduce((n, l) => n + (l.qtyCollected ?? 0), 0);
  const creditedItems = (c: C) =>
    c.lines.filter((l) => l.type === "CREDIT_RETURN").reduce((n, l) => n + (creditedByLine.get(l.id) ?? 0), 0);
  const scoped = collections.filter((c) => inRange(c.collectedAt ?? c.createdAt));

  type N = (typeof notes)[number];
  const noteRow = (n: N, detail: string): ExceptionRow => ({
    id: `n-${n.id}`,
    kind: "credit_note",
    number: n.creditNo,
    invoiceNo: n.invoiceNo,
    customer: n.deliverToName ?? n.billToName ?? null,
    date: iso(n.creditDate ?? n.createdAt),
    detail,
    href: `/credits?note=${n.id}`,
    status: n.status,
  });
  const scopedNotes = notes.filter((n) => inRange(n.creditDate ?? n.createdAt));
  const linked = (n: N) => n.collections.some((l) => l.source === "AUTO" || l.source === "MANUAL");

  const list = (key: ExceptionKey, title: string, description: string, rows: ExceptionRow[]): ExceptionList => ({
    key,
    title,
    description,
    count: rows.length,
    rows: rows.slice(0, rowsPerList),
  });

  const days = (d: Date | null) => (d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : 0);

  const lists: ExceptionList[] = [
    list(
      "uncredited",
      `Collected, not credited after ${uncreditedDays} days`,
      "Credit returns that came back and were approved (or not yet decided), with no signed credit note.",
      scoped
        .filter((c) => isCR(c) && came(c) && c.creditReview !== "REJECTED" && !signedNote(c) && c.collectedAt && c.collectedAt < cutoff)
        .map((c) => collectionRow(c, `${days(c.collectedAt)} days since collection`))
    ),
    list(
      "awaiting_approval",
      "Credit returns awaiting approval",
      "Came back; accounts makes the credit note only once each is approved.",
      scoped
        .filter((c) => isCR(c) && came(c) && !c.creditReview)
        .map((c) =>
          collectionRow(
            c,
            "Approve or reject it on the Collections tab",
            `/collections?status=AWAITING_APPROVAL&q=${encodeURIComponent(c.collectionNo)}`
          )
        )
    ),
    list(
      "note_no_collection",
      "Credit notes with no collection",
      "Nothing that came back is linked to these credit notes.",
      scopedNotes.filter((n) => !linked(n)).map((n) => noteRow(n, n.status === "SIGNED" ? "Signed with no collection" : "No collection linked"))
    ),
    list(
      "note_unmatched_or_manual",
      "Credit notes: invoice not found, or collection linked by hand",
      "For audit — the automatic match did not decide these.",
      scopedNotes
        .filter((n) => !n.invoiceId || n.collections.some((l) => l.source === "MANUAL"))
        .map((n) => noteRow(n, !n.invoiceId ? "Invoice not on record" : "Collection linked by hand"))
    ),
    list(
      "stub_invoice",
      "Collections against invoices with no PDF",
      "The invoice PDF was never received; Signex holds the number only.",
      scoped.filter((c) => c.invoiceId && stubIds.has(c.invoiceId)).map((c) => collectionRow(c, "Invoice PDF never received"))
    ),
    list(
      "credit_variance",
      "Credited ≠ collected",
      "Signed credit notes paid for a different quantity than came back.",
      scoped
        .filter((c) => isCR(c) && came(c) && c.lines.length > 0 && signedNote(c) && creditedItems(c) !== collectedItems(c))
        .map((c) => collectionRow(c, `Collected ${collectedItems(c)} · credited ${creditedItems(c)}`))
    ),
    list(
      "not_as_listed",
      "Collections not as listed",
      "The driver recorded something different from the office's sheet.",
      scoped.filter((c) => c.hasVariance).map((c) => collectionRow(c, c.exceptionReason ?? "Not as listed"))
    ),
    list(
      "sheet_problem",
      "Collection sheets missing or needing review",
      "On runs still out; the driver collects against what the sheet says.",
      scoped
        .filter((c) => c.status === "PENDING" && !!c.tripSheetId && (c.sheetStatus === "MISSING" || c.sheetStatus === "NEEDS_REVIEW"))
        .map((c) => collectionRow(c, c.sheetStatus === "MISSING" ? "No sheet found" : "Sheet needs review"))
    ),
    list(
      "failed_collection",
      "Failed collections needing rebooking",
      "The goods were not available at the door.",
      scoped.filter((c) => c.status === "NOT_AVAILABLE").map((c) => collectionRow(c, c.exceptionReason ?? c.failReason ?? "Not available"))
    ),
    list(
      "notes_to_sign",
      "Credit notes waiting for signature",
      "Read and checked; waiting for the dispatcher's sign-off.",
      scopedNotes
        .filter((n) => n.status === "RECEIVED" || n.status === "NEEDS_REVIEW")
        .map((n) => {
          // Not ready to sign until the collection it pays for is approved.
          const codes = new Set(((n.issues as unknown as { code: string }[] | null) ?? []).map((i) => i.code));
          const detail = codes.has("COLLECTION_REJECTED")
            ? "Collection rejected for credit — reject the note"
            : codes.has("COLLECTION_NOT_APPROVED")
            ? "Waiting for the collection to be approved"
            : n.status === "NEEDS_REVIEW"
            ? "Needs review before signing"
            : "Ready to sign";
          return noteRow(n, detail);
        })
    ),
  ];

  return { lists, uncreditedDays };
}

/** The lists as one CSV for download (header, then a row per exception). */
export function exceptionsCsv(lists: ExceptionList[]): string {
  const cell = (v: string | null | undefined) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [["List", "Kind", "Number", "Invoice", "Customer", "Date", "Detail", "Status"].join(",")];
  for (const l of lists) {
    for (const r of l.rows) {
      lines.push(
        [l.title, r.kind === "collection" ? "Collection" : "Credit note", r.number, r.originalInvoiceNo ?? r.invoiceNo, r.customer, r.date?.slice(0, 10), r.detail, r.status]
          .map(cell)
          .join(",")
      );
    }
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
