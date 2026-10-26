import { NextRequest, NextResponse } from "next/server";
import type { CollectionStatus, CollectionType } from "@prisma/client";
import { listCollections, type CollectionRecord } from "@/lib/trip-data";
import { dayWindow, parseTzOffset } from "@/lib/day-window";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { readInvoiceNoPattern } from "@/lib/config";
import { awaitingCreditReview } from "@/lib/collection-confirm";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "@/lib/invoice-number";
import { applyFilter, facetsOf, pageOf, parseFilterState, parsePageSize, toCsv, type FilterAccessors } from "@/lib/record-filter";

/**
 * The dispatcher's collections view and the credit-return report accounts
 * reconciles from.
 *
 * Reads live collections AND the frozen entries in completed trips' archives —
 * see listCollections. A report that only saw live rows would go empty at the
 * end of every day, exactly when someone wants to reconcile it.
 *
 * Filters:
 *   ?type=CREDIT_RETURN|NON_CREDIT_UPLIFT
 *   ?status=PENDING|COLLECTED|PARTIAL|NOT_AVAILABLE|REFUSED
 *   ?exceptions=true            only PARTIAL / NOT_AVAILABLE / REFUSED
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   on collectedAt, the moment it was closed
 *   ?range=today&tzOffset=      the caller's own day, not the server's
 *   ?driverId= / ?tripSheetId=
 *   ?includeArchived=false      outstanding work only
 *
 * ?view=page is the filter bar's shape instead (lib/record-filter.ts): the
 * bar's filters, sort, one 25-row page (`after` = the previous `next`), the
 * facets for its dropdowns, and `format=csv` for every filtered row.
 */

const VALID_TYPES: CollectionType[] = ["CREDIT_RETURN", "NON_CREDIT_UPLIFT"];
const VALID_STATUSES: CollectionStatus[] = [
  "PENDING",
  "COLLECTED",
  "PARTIAL",
  "NOT_AVAILABLE",
  "REFUSED",
];

const EXCEPTION_STATUSES = new Set<string>(["PARTIAL", "NOT_AVAILABLE", "REFUSED"]);

const accessors = (pattern: InvoiceNoPattern): FilterAccessors<CollectionRecord> => ({
  search: (r) => [
    r.collectionNo,
    r.customerName,
    r.originalInvoiceNo,
    r.originalInvoiceNo ? normalizeInvoiceNo(r.originalInvoiceNo, pattern) : null,
    r.driverName,
    r.exceptionReason,
    r.signedByName,
  ],
  date: (r) => r.collectedAt?.toISOString() ?? null,
  tripDate: (r) => r.tripDate,
  status: (r) => r.status,
  // The office's decision, made on this tab before or after the trip closes.
  tags: (r) => (awaitingCreditReview(r) ? ["AWAITING_APPROVAL"] : []),
  type: (r) => r.type,
  customer: (r) => r.customerName,
  driver: (r) => r.driverId,
  trip: (r) => r.tripSheetId,
  flag: (r) => r.hasVariance,
  number: (r) => r.collectionNo,
});

const CSV_HEADERS = [
  "Collection No", "Type", "Subtype", "Original Invoice", "Customer", "Status", "Expected", "Collected",
  "Not as listed", "Reason", "Approval", "Driver", "Trip date", "Trip sheet", "Signed By", "Collected At",
  "Signed Document", "Receipt Email",
];

function csvRow(r: CollectionRecord) {
  return [
    r.collectionNo,
    r.type === "CREDIT_RETURN" ? "Credit Return" : "Uplift",
    r.upliftSubtype ?? "",
    r.originalInvoiceNo ?? "",
    r.customerName,
    r.status,
    r.itemsListed ?? r.expectedQty ?? "",
    r.itemsCollected ?? r.collectedQty ?? "",
    r.hasVariance ? "Yes" : "",
    r.exceptionReason ?? "",
    r.creditReview ?? "",
    r.driverName ?? "",
    r.tripDate ?? "",
    r.tripName ?? "",
    r.signedByName ?? "",
    r.collectedAt?.toISOString() ?? "",
    r.signedFilePath ?? "",
    r.emailStatus ?? "",
  ];
}

/** A date-only query param, read as the start of that UTC day. */
function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const { searchParams } = new URL(request.url);

  if (searchParams.get("view") === "page") {
    const state = parseFilterState(searchParams);
    const [all, pattern] = await Promise.all([
      listCollections(ctx.tenantId, { limit: 2000 }),
      readInvoiceNoPattern(ctx.tenantId),
    ]);
    const acc = accessors(pattern);
    const rows = applyFilter(all, state, acc, new Date(), parseTzOffset(searchParams.get("tzOffset")));

    if (searchParams.get("format") === "csv") {
      await logAudit({
        action: "EXPORT",
        entity: "collections",
        details: `Collections CSV exported (${rows.length} rows)`,
        metadata: { format: "csv", rows: rows.length },
        tenantId: ctx.tenantId,
      });
      return new NextResponse(toCsv(CSV_HEADERS, rows.map(csvRow)), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="signex-collections-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    const page = pageOf(rows, searchParams.get("after"), parsePageSize(searchParams.get("size")));
    const count = (pred: (r: CollectionRecord) => boolean) => rows.filter(pred).length;
    return NextResponse.json({
      collections: page.items,
      total: page.total,
      next: page.next,
      // The dropdowns offer what exists in the whole scope, not just this page.
      facets: facetsOf(all, acc, (r) => r.driverName, (r) => `${r.tripDate ?? ""} · ${r.driverName ?? ""} · ${r.tripName ?? ""}`),
      counts: {
        total: rows.length,
        pending: count((r) => r.status === "PENDING"),
        creditReturns: count((r) => r.type === "CREDIT_RETURN"),
        uplifts: count((r) => r.type === "NON_CREDIT_UPLIFT"),
        exceptions: count((r) => EXCEPTION_STATUSES.has(r.status)),
        // Across the whole scope, not the filtered view: it is a to-do count.
        awaitingApproval: all.filter((r) => awaitingCreditReview(r)).length,
      },
    });
  }

  const typeParam = searchParams.get("type");
  const statusParam = searchParams.get("status");

  if (typeParam && !VALID_TYPES.includes(typeParam as CollectionType)) {
    return NextResponse.json(
      { error: `Invalid type. Use: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (statusParam && !VALID_STATUSES.includes(statusParam as CollectionStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  let since = parseDate(searchParams.get("from"));
  let until = parseDate(searchParams.get("to"));

  // "Today" belongs to whoever is looking at the screen. Same reporting window
  // as every other date-bounded view — see lib/day-window.ts.
  if (searchParams.get("range") === "today") {
    const day = dayWindow(new Date(), parseTzOffset(searchParams.get("tzOffset")));
    since = day.start;
    until = day.end;
  }

  // A `to` date is a day the user means to include, so the exclusive upper
  // bound is the following midnight rather than that day's 00:00.
  if (until && !searchParams.get("range")) {
    until = new Date(until.getTime() + 24 * 60 * 60 * 1000);
  }

  // A driverId from a query string is client-supplied: narrowed to this scope
  // before it is used, so a driver in another ADMIN's scope is simply not found.
  const driverIdParam = searchParams.get("driverId");
  let driverId: string | undefined;
  if (driverIdParam) {
    const driver = await ctx.db.driver.findFirst({
      where: { id: driverIdParam },
      select: { id: true },
    });
    if (!driver) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }
    driverId = driver.id;
  }

  const records = await listCollections(ctx.tenantId, {
    type: (typeParam as CollectionType) ?? undefined,
    status: (statusParam as CollectionStatus) ?? undefined,
    since,
    until,
    driverId,
    tripSheetId: searchParams.get("tripSheetId") ?? undefined,
    includeArchived: searchParams.get("includeArchived") !== "false",
    onlyCompleted: searchParams.get("onlyCompleted") === "true",
  });

  const filtered =
    searchParams.get("exceptions") === "true"
      ? records.filter((r) => EXCEPTION_STATUSES.has(r.status))
      : records;

  const counts = {
    total: filtered.length,
    pending: filtered.filter((r) => r.status === "PENDING").length,
    collected: filtered.filter((r) => r.status === "COLLECTED").length,
    partial: filtered.filter((r) => r.status === "PARTIAL").length,
    notAvailable: filtered.filter((r) => r.status === "NOT_AVAILABLE").length,
    refused: filtered.filter((r) => r.status === "REFUSED").length,
    creditReturns: filtered.filter((r) => r.type === "CREDIT_RETURN").length,
    uplifts: filtered.filter((r) => r.type === "NON_CREDIT_UPLIFT").length,
    exceptions: filtered.filter((r) => EXCEPTION_STATUSES.has(r.status)).length,
  };

  return NextResponse.json({
    collections: filtered,
    counts,
    from: since?.toISOString() ?? null,
    to: until?.toISOString() ?? null,
  });
});
