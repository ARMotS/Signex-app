import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { getInvoiceLines, readInvoiceLines, saveManualLines } from "@/lib/invoice-lines";
import { readManualLines } from "@/lib/invoice-lines-input";

// A scan or an unknown layout is read by Claude, inside this request.
export const maxDuration = 60;

/**
 * An invoice's product lines and the state of their reading
 * (lib/invoice-lines.ts) — quantities only, nothing priced. Office only;
 * another scope's id is 404 through the scoped client.
 */
export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const view = await getInvoiceLines(ctx.tenantId, id);
  if (!view) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  return NextResponse.json(view);
});

/**
 * Read the lines now, one invoice per request. Answers at once from what is
 * stored when this PDF has been read already; `{ force: true }` reads it
 * again — and may replace lines typed in by hand (user decision, 2026-11-25),
 * which is audited. An unforced read never touches them.
 */
export const POST = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await readInvoiceLines(ctx.tenantId, id, { force: body?.force === true });
  if (!result) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  if (result.replacedManual) {
    await logAudit({
      action: "STATUS_CHANGE",
      entity: "invoice",
      entityId: id,
      details: `Invoice ${result.view.invoiceNo}: lines typed by hand replaced by a re-read of the PDF (${result.view.lines.length} line${result.view.lines.length === 1 ? "" : "s"} read)`,
      tenantId: ctx.tenantId,
      metadata: { linesSource: { from: "MANUAL", to: result.view.source }, lines: result.view.lines.length },
    });
  }
  return NextResponse.json({ outcome: result.outcome, ...result.view });
});

/**
 * Type an invoice's lines in by hand — for a scan nobody could read, a stub
 * with no PDF, or a read that went wrong. `{ lines, basedOn }`: `basedOn` is
 * the `readAt` the editor was opened on (null when there were no lines), so
 * lines that changed since (a read landing, a colleague's save) answer 409
 * LINES_CHANGED with the current state instead of being overwritten unseen.
 * Quantities only; anything priced in the body is ignored.
 */
export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const checked = readManualLines(body?.lines);
  if (!checked.ok) return NextResponse.json({ error: checked.error, line: checked.line }, { status: 400 });

  if (body.basedOn === undefined) {
    return NextResponse.json({ error: "basedOn is required (null when there were no lines)" }, { status: 400 });
  }
  let basedOn: Date | null = null;
  if (body.basedOn !== null) {
    basedOn = new Date(String(body.basedOn));
    if (Number.isNaN(basedOn.getTime())) return NextResponse.json({ error: "basedOn must be a timestamp" }, { status: 400 });
  }

  const result = await saveManualLines(ctx.tenantId, id, checked.lines, { basedOn });
  if (!result) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (result.outcome === "CHANGED") {
    return NextResponse.json(
      {
        ...result.view,
        // The view's `error` is the last read's; this answer's is the clash.
        readError: result.view.error,
        error: "These lines changed since you opened them. Check what is there now and make your change again.",
        code: "LINES_CHANGED",
      },
      { status: 409 }
    );
  }

  const n = checked.lines.length;
  await logAudit({
    action: "STATUS_CHANGE",
    entity: "invoice",
    entityId: id,
    details:
      `Invoice ${result.view.invoiceNo}: ${n} line${n === 1 ? "" : "s"} entered by hand` +
      (result.previous.count > 0 ? ` (replacing ${result.previous.count} ${result.previous.source === "MANUAL" ? "typed" : "read"})` : ""),
    tenantId: ctx.tenantId,
    metadata: { linesSource: { from: result.previous.source, to: "MANUAL" }, lines: { from: result.previous.count, to: n } },
  });
  return NextResponse.json({ outcome: "SAVED", ...result.view });
});
