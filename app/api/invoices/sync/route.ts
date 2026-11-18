import { NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { INVOICE_INDEX_SYNC_LEASE_MS, syncInvoiceIndex } from "@/lib/invoice-index-sync";

export const maxDuration = 60;

/**
 * POST /api/invoices/sync — Sync on the Invoices tab: bring the invoice folder
 * index up to date now, instead of waiting for the next automatic look.
 * Usually one small Graph request (what changed since the last look). Still
 * claimed, with a short lease, so pressing it on two screens costs one look.
 * The page then reloads GET /api/invoices.
 */
export const POST = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);

  const result = await syncInvoiceIndex(ctx.tenantId, {
    minIntervalMs: INVOICE_INDEX_SYNC_LEASE_MS,
    budgetMs: 20_000,
  });
  switch (result.outcome) {
    case "not_configured":
      // A local folder is read directly on every load; nothing to bring up to date.
      return NextResponse.json({ success: true, outcome: "not_configured" });
    case "error":
      return NextResponse.json(
        { error: `The invoice folder could not be checked: ${result.error}`, code: "FOLDER_UNREADABLE" },
        { status: 502 }
      );
    default:
      return NextResponse.json({ success: true, ...result });
  }
});
