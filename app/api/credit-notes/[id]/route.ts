import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { reassessCreditNote, rereadCreditNote, setCreditNoteLink } from "@/lib/credit-intake";
import { fileSignedCreditNote, rejectCreditNote } from "@/lib/credit-signoff";
import type { CreditIssue, LineMatch } from "@/lib/credit-note";

/**
 * One credit note.
 *
 *   GET — the note, its lines (each with what it was matched to), the invoice
 *         it credits, the collections it pays for, and collections the office
 *         could link by hand. A note waiting to be signed is checked again
 *         first, so the page never shows a stale verdict.
 *   PUT { action: "reread" } — read the file again.
 *   PUT { action: "link" | "unlink", collectionId } — the office corrects
 *         which collections the note pays for.
 *
 * ADMIN only. An id from another scope is 404 through the scoped client, for
 * the note and for the collection alike.
 */

type Ctx = Awaited<ReturnType<typeof getScope>>;

const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));

async function detail(ctx: Ctx, id: string) {
  const evaluation = await reassessCreditNote(ctx.tenantId, id);
  const note = await ctx.db.creditNote.findFirst({
    where: { id },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      allocations: { orderBy: { lineNo: "asc" } },
      invoice: { select: { id: true, invoiceNo: true, customerName: true, invoiceDate: true, pdfFilename: true, isStub: true } },
      collections: {
        include: {
          collection: {
            select: {
              id: true,
              collectionNo: true,
              originalInvoiceNo: true,
              status: true,
              customerName: true,
              collectedAt: true,
              hasVariance: true,
              expectedQty: true,
              lines: { orderBy: { lineNo: "asc" } },
            },
          },
        },
      },
    },
  });
  if (!note) return null;

  const matches = new Map<number, LineMatch>((evaluation?.matches ?? []).map((m) => [m.lineNo, m]));
  const linkedIds = note.collections.filter((l) => l.source !== "EXCLUDED").map((l) => l.collectionId);
  const names = [note.deliverToName, note.billToName].filter((n): n is string => !!n);

  // Collections the office might link by hand: come back, a credit return,
  // and either against this invoice or for this customer.
  const orFilters = [
    ...(note.invoiceNoNormalized ? [{ invoiceNoNormalized: note.invoiceNoNormalized }] : []),
    ...names.map((n) => ({ customerName: { equals: n, mode: "insensitive" as const } })),
  ];
  const candidates = orFilters.length
    ? await ctx.db.collection.findMany({
        where: {
          id: { notIn: linkedIds },
          type: "CREDIT_RETURN",
          status: { in: ["COLLECTED", "PARTIAL"] },
          OR: orFilters,
        },
        select: { id: true, collectionNo: true, originalInvoiceNo: true, customerName: true, collectedAt: true, status: true },
        orderBy: { collectedAt: "desc" },
        take: 20,
      })
    : [];

  return {
    id: note.id,
    creditNo: note.creditNo,
    invoiceNo: note.invoiceNo,
    creditDate: note.creditDate?.toISOString().slice(0, 10) ?? null,
    accountNo: note.accountNo,
    deliverToName: note.deliverToName,
    billToName: note.billToName,
    subtotal: num(note.subtotal),
    vatAmount: num(note.vatAmount),
    total: num(note.total),
    status: note.status,
    issues: (note.issues as unknown as CreditIssue[] | null) ?? [],
    readSource: note.readSource,
    readAt: note.readAt?.toISOString() ?? null,
    readError: note.readError,
    rejectReason: note.rejectReason,
    sourceFilename: note.sourceFilename,
    sourceFolder: note.sourceFolder,
    fileError: note.fileError,
    uploadedBy: note.uploadedBy,
    receivedAt: note.createdAt.toISOString(),
    signedByName: note.signedByName,
    signedByLogin: note.signedByLogin,
    signedAt: note.signedAt?.toISOString() ?? null,
    acknowledgedIssues: (note.acknowledgedIssues as unknown as CreditIssue[] | null) ?? [],
    acknowledgement: note.acknowledgement,
    signedFilename: note.signedFilename,
    filedAt: note.filedAt?.toISOString() ?? null,
    filingError: note.filingError,
    originalRemoved: note.originalRemoved,
    rejectedBy: note.rejectedBy,
    rejectedAt: note.rejectedAt?.toISOString() ?? null,
    // What a signed note paid for, as frozen at signing.
    allocations: note.allocations.map((a) => ({ lineNo: a.lineNo, collectionNo: a.collectionNo, qty: Number(a.qty) })),
    invoice: note.invoice
      ? { ...note.invoice, invoiceDate: note.invoice.invoiceDate?.toISOString().slice(0, 10) ?? null }
      : null,
    lines: note.lines.map((l) => {
      const m = matches.get(l.lineNo);
      return {
        lineNo: l.lineNo,
        productCode: l.productCode,
        shortName: l.shortName,
        bin: l.bin,
        description: l.description,
        qty: Number(l.qty),
        unitPrice: num(l.unitPrice),
        discountPct: num(l.discountPct),
        nett: num(l.nett),
        match: m ? { status: m.status, uncoveredQty: m.uncoveredQty, allocations: m.allocations } : null,
      };
    }),
    collections: note.collections.map((l) => ({
      linkId: l.id,
      source: l.source,
      linkedBy: l.linkedBy,
      ...l.collection,
      collectedAt: l.collection.collectedAt?.toISOString() ?? null,
      lines: l.collection.lines.map((cl) => ({
        id: cl.id,
        lineNo: cl.lineNo,
        itemCode: cl.itemCode,
        description: cl.description,
        qtyListed: cl.qtyListed,
        qtyCollected: cl.qtyCollected,
        diffReason: cl.diffReason,
        isExtra: cl.isExtra,
        type: cl.type,
      })),
    })),
    candidates: candidates.map((c) => ({ ...c, collectedAt: c.collectedAt?.toISOString() ?? null })),
  };
}

export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const body = await detail(ctx, id);
  if (!body) return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
  return NextResponse.json({ creditNote: body });
});

export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  if (body.action === "reread") {
    const result = await rereadCreditNote(ctx.tenantId, id, ctx.name);
    if (result.outcome === "not_found") return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
    if (result.outcome === "closed") {
      return NextResponse.json({ error: "This credit note has been dealt with; it is no longer read again." }, { status: 409 });
    }
    if (result.outcome === "error") {
      return NextResponse.json({ error: `The file could not be fetched: ${result.error}` }, { status: 502 });
    }
  } else if (body.action === "link" || body.action === "unlink") {
    if (typeof body.collectionId !== "string" || !body.collectionId) {
      return NextResponse.json({ error: "collectionId is required" }, { status: 400 });
    }
    const result = await setCreditNoteLink(ctx.tenantId, id, body.collectionId, body.action === "link", ctx.name);
    if (result.outcome === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (result.outcome === "closed") {
      return NextResponse.json({ error: "This credit note has been dealt with; its collections are settled." }, { status: 409 });
    }
    if (result.outcome === "not_collected") {
      return NextResponse.json(
        { error: "Only a credit-return collection that has come back (collected or partly collected) can be linked." },
        { status: 409 }
      );
    }
  } else if (body.action === "reject") {
    const result = await rejectCreditNote(ctx.tenantId, id, body.reason, ctx.name);
    if (result.outcome === "not_found") return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
    if (result.outcome === "invalid") return NextResponse.json({ error: result.error }, { status: 400 });
    if (result.outcome === "closed") {
      return NextResponse.json({ error: "This credit note has already been signed or rejected." }, { status: 409 });
    }
  } else if (body.action === "file") {
    // Retry whatever filing a signed note has left — never re-signs.
    const exists = await ctx.db.creditNote.findFirst({ where: { id }, select: { status: true } });
    if (!exists) return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
    if (exists.status !== "SIGNED") return NextResponse.json({ error: "Only a signed credit note is filed." }, { status: 409 });
    await fileSignedCreditNote(ctx.tenantId, id);
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const updated = await detail(ctx, id);
  if (!updated) return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
  return NextResponse.json({ success: true, creditNote: updated });
});
