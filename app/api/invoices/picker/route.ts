import { NextRequest, NextResponse } from "next/server";
import { InvoiceFolderUnreadable } from "@/lib/invoices";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { readInvoiceFolderListing, registerListedInvoices } from "@/lib/invoice-folder-listing";
import { pickerPageOf, readPickerRows } from "@/lib/invoice-picker";
import { parseFilterState, parsePageSize } from "@/lib/record-filter";
import { parseTzOffset } from "@/lib/day-window";

/**
 * The invoice picker's list (lib/invoice-picker.ts): one page of the invoice
 * folder's PDFs with their date, customer and where each is allocated.
 *
 *   ?q, from, to (YYYY-MM-DD), preset, sort — the record-filter rulebook
 *   ?show=all     allocated and unnumbered invoices too (greyed); default: only what can be picked
 *   ?page, size   1-based page, ≤ 200 rows
 *   ?name=…       (repeatable) filenames to answer for regardless of the
 *                 filter — what was just uploaded, or picked earlier
 *   ?tzOffset     the viewer's clock, for dates read off a file's timestamp
 *
 * Office only. Everything is read in the caller's scope, from the session.
 */
// Until the folder index has its first pass the folder is listed over Graph,
// as the Invoices tab does.
export const maxDuration = 60;

const MAX_NAMES = 50;

export const GET = withAuth(async (request: NextRequest) => {
  const startedAt = Date.now();
  const ctx = await getScope();
  requireOffice(ctx);

  const params = request.nextUrl.searchParams;
  let listing: Awaited<ReturnType<typeof readInvoiceFolderListing>>;
  try {
    listing = await readInvoiceFolderListing(ctx.tenantId, startedAt);
  } catch (err) {
    if (err instanceof InvoiceFolderUnreadable) {
      return NextResponse.json({ error: err.message, code: "FOLDER_UNREADABLE" }, { status: 502 });
    }
    throw err;
  }
  const { files, index, folderLabel, pattern, isOneDrive } = listing;
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const filter = parseFilterState(params);
  // Headers are read once the picker opens (no search, first page), not on
  // every search: a failed read spends one of an invoice's attempts.
  const opening = !filter.q && !filter.from && !filter.to && !(page > 1);
  const records = await registerListedInvoices(ctx.tenantId, files, pattern, { readHeaders: opening });
  const rows = await readPickerRows(ctx.tenantId, files, records, pattern);

  const result = pickerPageOf(
    rows,
    {
      filter,
      showAll: params.get("show") === "all",
      tzOffset: parseTzOffset(params.get("tzOffset")),
      names: params.getAll("name").slice(0, MAX_NAMES),
    },
    Number.isFinite(page) ? page : 1,
    parsePageSize(params.get("size"))
  );

  return NextResponse.json({
    ...result,
    folder: folderLabel,
    source: isOneDrive ? "onedrive" : "local",
    index,
  });
});
