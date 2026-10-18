/**
 * The credit register: one row per signed credit note, tracing it back
 * through what it paid for to the collection and the invoice — the
 * invoice → collection → credit note chain, as a spreadsheet accounts can
 * reconcile from. Written into a backup beside the signed credit notes.
 *
 * Built from the database (scoped), never from the PDFs: the sign-off froze
 * what each note paid for (CreditNoteAllocation), and that is the record.
 */

import { scopedPrisma } from "./db-scoped";
import type { CreditIssue } from "./credit-note";

export interface CreditRegisterRow {
  creditNo: string;
  creditDate: string;
  invoiceNo: string;
  invoiceDate: string;
  customer: string;
  accountNo: string;
  collections: string;
  collectedOn: string;
  itemsCredited: string;
  subtotal: string;
  vat: string;
  total: string;
  signedBy: string;
  signedByLogin: string;
  signedAt: string;
  acceptedIssues: string;
  reason: string;
  signedFile: string;
}

const COLUMNS: [keyof CreditRegisterRow, string][] = [
  ["creditNo", "Credit note"],
  ["creditDate", "Credit date"],
  ["invoiceNo", "Invoice"],
  ["invoiceDate", "Invoice date"],
  ["customer", "Customer"],
  ["accountNo", "Account"],
  ["collections", "Collections"],
  ["collectedOn", "Collected on"],
  ["itemsCredited", "Items credited"],
  ["subtotal", "Sub total"],
  ["vat", "VAT"],
  ["total", "Total"],
  ["signedBy", "Signed by"],
  ["signedByLogin", "Office login"],
  ["signedAt", "Signed at"],
  ["acceptedIssues", "Accepted despite"],
  ["reason", "Reason"],
  ["signedFile", "Signed file"],
];

/**
 * CSV with a header row. Every cell is quoted when it holds a comma, quote or
 * line break, and a cell starting with = + - @ is prefixed with ' so a
 * spreadsheet never runs it as a formula (a customer name is free text).
 */
export function creditRegisterCsv(rows: CreditRegisterRow[]): string {
  const cell = (v: string) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(([, h]) => cell(h)).join(",")];
  for (const row of rows) lines.push(COLUMNS.map(([k]) => cell(row[k])).join(","));
  // BOM so Excel opens it as UTF-8 (customer names carry accents).
  return `﻿${lines.join("\r\n")}\r\n`;
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const money = (d: unknown) => (d === null || d === undefined ? "" : Number(d).toFixed(2));

/** Register rows for the signed credit notes filed under these names, in this scope only. */
export async function creditRegisterRows(tenantId: string, signedFilenames: string[]): Promise<CreditRegisterRow[]> {
  if (signedFilenames.length === 0) return [];
  const notes = await scopedPrisma(tenantId).creditNote.findMany({
    where: { status: "SIGNED", signedFilename: { in: signedFilenames } },
    include: {
      invoice: { select: { invoiceDate: true } },
      allocations: { orderBy: { lineNo: "asc" } },
      lines: { orderBy: { lineNo: "asc" } },
      collections: {
        where: { source: { in: ["AUTO", "MANUAL"] } },
        include: { collection: { select: { collectionNo: true, collectedAt: true } } },
      },
    },
    orderBy: [{ creditDate: "asc" }, { creditNo: "asc" }],
  });

  return notes.map((n) => ({
    creditNo: n.creditNo ?? "",
    creditDate: day(n.creditDate),
    invoiceNo: n.invoiceNo ?? "",
    invoiceDate: day(n.invoice?.invoiceDate),
    customer: n.deliverToName ?? n.billToName ?? "",
    accountNo: n.accountNo ?? "",
    collections: n.collections.map((l) => l.collection.collectionNo).join("; "),
    collectedOn: n.collections.map((l) => day(l.collection.collectedAt)).filter(Boolean).join("; "),
    itemsCredited: n.allocations
      .map((a) => {
        const line = n.lines.find((l) => l.lineNo === a.lineNo);
        return `${Number(a.qty)} x ${a.itemCode ?? line?.productCode ?? line?.description ?? "item"} (collection ${a.collectionNo})`;
      })
      .join("; "),
    subtotal: money(n.subtotal),
    vat: money(n.vatAmount),
    total: money(n.total),
    signedBy: n.signedByName ?? "",
    signedByLogin: n.signedByLogin ?? "",
    signedAt: n.signedAt?.toISOString() ?? "",
    acceptedIssues: ((n.acknowledgedIssues as unknown as CreditIssue[] | null) ?? []).map((i) => i.message).join(" | "),
    reason: n.acknowledgement ?? "",
    signedFile: n.signedFilename ?? "",
  }));
}
