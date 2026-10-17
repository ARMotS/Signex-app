/**
 * The durable invoice registry — one `Invoice` row per invoice number.
 *
 * Invoices are PDFs in a folder and the stop that delivered one is deleted when
 * its trip completes, so neither can anchor the invoice → collection → credit
 * note chain. This table can. It is filled from three places, all idempotent:
 *
 *   • the Invoices page listing the folder   (every file seen gets a row)
 *   • a trip sheet deploy                     (delivery invoices, plus a STUB for
 *                                              a collection whose invoice PDF is
 *                                              not on file)
 *   • an invoice upload                       (the new file)
 *
 * Its header — the invoice's own date and customer — is read off the PDF once,
 * in the background (fillInvoiceHeaders), and never again.
 */

import { after } from "next/server";
import { scopedPrisma } from "./db-scoped";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import { readInvoiceFile } from "./invoices";
import { readInvoiceHeader } from "./invoice-header";
import { mapWithConcurrency } from "./concurrency";

export interface InvoiceRef {
  /** As written on the sheet, or the file stem. */
  invoiceNo: string;
  /** The PDF this reference is known to have, if any. */
  pdfFilename?: string | null;
  /** The trip sheet's CUSTOMER — it wins over anything read off the PDF. */
  customerName?: string | null;
  /** Create the row as a stub if it does not exist and no PDF is known. */
  stubIfNew?: boolean;
}

/**
 * Make sure a row exists for every referenced invoice and return
 * normalized number → invoice id.
 *
 * @param fileAuthority "set" — the caller knows which file this invoice is
 *   (a deploy matched it, an upload just wrote it), so it replaces whatever is
 *   recorded. "fill" — a folder listing, which only fills a missing filename:
 *   a folder holding IV-365-4 and IV-365-5 must not flip one invoice's file
 *   back and forth on every page load.
 */
export async function ensureInvoices(
  tenantId: string,
  refs: InvoiceRef[],
  pattern: InvoiceNoPattern,
  { fileAuthority = "set" }: { fileAuthority?: "set" | "fill" } = {}
): Promise<Map<string, string>> {
  const db = scopedPrisma(tenantId);

  // One entry per normalized number. Several sheet rows (or duplicate files)
  // can name the same invoice.
  const wanted = new Map<string, Required<InvoiceRef>>();
  for (const ref of refs) {
    const key = normalizeInvoiceNo(ref.invoiceNo, pattern);
    if (!key) continue;
    const prev = wanted.get(key);
    wanted.set(key, {
      invoiceNo: prev?.invoiceNo ?? ref.invoiceNo.trim(),
      pdfFilename: prev?.pdfFilename || ref.pdfFilename || null,
      // First wins: callers list deliveries before collections, and the
      // delivery row is the one that names the invoice's customer.
      customerName: prev?.customerName || ref.customerName?.trim() || null,
      stubIfNew: (prev?.stubIfNew ?? true) && !!ref.stubIfNew,
    } as Required<InvoiceRef>);
  }
  if (wanted.size === 0) return new Map();

  const keys = [...wanted.keys()];
  const existing = await db.invoice.findMany({
    where: { invoiceNoNormalized: { in: keys } },
    select: { id: true, invoiceNoNormalized: true, pdfFilename: true, customerName: true, isStub: true },
  });
  const byKey = new Map(existing.map((e) => [e.invoiceNoNormalized, e]));

  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    // skipDuplicates: two deploys naming the same new invoice can race; the
    // unique [tenantId, invoiceNoNormalized] settles it.
    await db.invoice.createMany({
      data: missing.map((key) => {
        const ref = wanted.get(key)!;
        return {
          invoiceNo: ref.invoiceNo,
          invoiceNoNormalized: key,
          pdfFilename: ref.pdfFilename,
          customerName: ref.customerName,
          isStub: !ref.pdfFilename && ref.stubIfNew,
        };
      }),
      skipDuplicates: true,
    });
  }

  // Updates only where something actually changed — the folder listing calls
  // this on every page load.
  await mapWithConcurrency(
    existing,
    async (row) => {
      const ref = wanted.get(row.invoiceNoNormalized)!;
      const file =
        ref.pdfFilename &&
        ref.pdfFilename !== row.pdfFilename &&
        (fileAuthority === "set" || !row.pdfFilename)
          ? ref.pdfFilename
          : null;
      const customer = ref.customerName && ref.customerName !== row.customerName ? ref.customerName : null;
      if (!file && !customer) return;
      await db.invoice.update({
        where: { id: row.id },
        data: {
          ...(file && { pdfFilename: file, isStub: false }),
          ...(customer && { customerName: customer }),
        },
      });
    },
    4
  );

  const all = missing.length
    ? await db.invoice.findMany({
        where: { invoiceNoNormalized: { in: keys } },
        select: { id: true, invoiceNoNormalized: true },
      })
    : existing;
  return new Map(all.map((r) => [r.invoiceNoNormalized, r.id]));
}

/**
 * Forget a deleted file. The invoice row stays — it is the anchor of whatever
 * was delivered and collected against it — but no longer points at a PDF.
 */
export async function detachInvoiceFiles(tenantId: string, filenames: string[]): Promise<void> {
  if (filenames.length === 0) return;
  await scopedPrisma(tenantId).invoice.updateMany({
    where: { pdfFilename: { in: filenames } },
    data: { pdfFilename: null },
  });
}

// ─── Headers ──────────────────────────────────────────────────────────────

/** Attempts before an unreadable PDF is left for a person to fill in. */
const MAX_HEADER_ATTEMPTS = 3;

/**
 * Read the header of invoices that do not have one yet: download the PDF, read
 * its text layer (or, for a scan, ask Claude), store the date and customer.
 *
 * Safe to run concurrently with itself. Each invoice is claimed by bumping
 * `headerAttempts` conditionally, and the result is written only while the
 * header is still unread — so a date typed in by hand (MANUAL) is never
 * overwritten by a read that finished afterwards.
 */
export async function fillInvoiceHeaders(
  tenantId: string,
  { ids, limit = 20 }: { ids?: string[]; limit?: number } = {}
): Promise<{ read: number; failed: number }> {
  const db = scopedPrisma(tenantId);
  const candidates = await db.invoice.findMany({
    where: {
      headerSource: null,
      pdfFilename: { not: null },
      headerAttempts: { lt: MAX_HEADER_ATTEMPTS },
      ...(ids && { id: { in: ids } }),
    },
    select: { id: true, pdfFilename: true, headerAttempts: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  let read = 0;
  let failed = 0;
  await mapWithConcurrency(
    candidates,
    async (inv) => {
      const claim = await db.invoice.updateMany({
        where: { id: inv.id, headerSource: null, headerAttempts: inv.headerAttempts },
        data: { headerAttempts: { increment: 1 } },
      });
      if (claim.count === 0) return; // another run has it

      try {
        const pdf = await readInvoiceFile(tenantId, inv.pdfFilename!);
        if (!pdf) throw new Error(`${inv.pdfFilename} is not in the invoice folder`);
        const { header, source } = await readInvoiceHeader(pdf);
        await db.invoice.updateMany({
          where: { id: inv.id, headerSource: null },
          data: {
            invoiceDate: header.invoiceDate,
            deliverToName: header.deliverToName,
            billToName: header.billToName,
            headerSource: source,
            headerError: null,
          },
        });
        read++;
      } catch (err) {
        failed++;
        await db.invoice.updateMany({
          where: { id: inv.id, headerSource: null },
          data: { headerError: err instanceof Error ? err.message : String(err) },
        });
      }
    },
    3
  );

  return { read, failed };
}

/**
 * Read headers after the response has gone. Never inline: this downloads PDFs,
 * and the page or deploy that triggered it must not wait on that. Without a
 * request scope (scripts, tests) it does nothing — the backfill script calls
 * fillInvoiceHeaders directly.
 */
export function scheduleInvoiceHeaders(
  tenantId: string,
  opts: { ids?: string[]; limit?: number } = {}
): void {
  try {
    after(() =>
      fillInvoiceHeaders(tenantId, opts).catch((err) =>
        console.error(`Invoice header read failed for scope ${tenantId}:`, err)
      )
    );
  } catch {
    // No request scope.
  }
}

// ─── Customer cross-check ─────────────────────────────────────────────────

/** Uppercase letters and digits, minus company-form words that sheets drop. */
function nameKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/\b(?:PTY|LTD|LIMITED|CC|INC|THE)\b/g, " ")
    .replace(/[^A-Z0-9]/g, "");
}

function sameCustomer(a: string, b: string): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (ka.length < 4 || kb.length < 4) return ka === kb;
  // "ATLANTIC AUTO SPARES" on the sheet is "ATLANTIC AUTO SPARES(LANGLAAG)"
  // on the PDF: a branch suffix, not a different customer.
  return ka.includes(kb) || kb.includes(ka);
}

/**
 * True when the trip sheet's customer matches neither name on the PDF. The
 * sheet value is still the one shown — this only raises a flag. Either PDF
 * name counts: on a cash sale "Invoice to" is the cash account.
 */
export function customerMismatch(
  customerName: string | null,
  deliverToName: string | null,
  billToName: string | null
): boolean {
  if (!customerName || (!deliverToName && !billToName)) return false;
  return ![deliverToName, billToName].some((pdfName) => pdfName && sameCustomer(customerName, pdfName));
}
