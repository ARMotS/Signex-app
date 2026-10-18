import { NextRequest, NextResponse } from "next/server";
import type { CreditNoteStatus, Prisma } from "@prisma/client";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { looksLikePdf, MAX_INVOICE_UPLOAD_BYTES, sanitizeInvoiceFilename } from "@/lib/invoices";
import { uploadCreditNote } from "@/lib/credit-intake";
import { scheduleCreditsWork } from "@/lib/credit-signoff";
import type { CreditIssue } from "@/lib/credit-note";

/**
 * The Credits page.
 *
 *   GET  ?status=&q=  — this scope's credit notes, newest first, with the
 *        credits folder's state. Opening (and polling) the page also looks at
 *        the folder, after the response and throttled per scope.
 *   POST (multipart: file) — "Upload credit note": stored in Originals/ and
 *        read, exactly as if the accounting software had written it.
 *
 * ADMIN only. Every read goes through the scoped client — like the dashboard,
 * this aggregates the whole scope on every poll, so a scoping bug here would
 * be a standing side channel (covered in tests/isolation.test.ts).
 */

const STATUSES: CreditNoteStatus[] = ["RECEIVED", "NEEDS_REVIEW", "SIGNED", "REJECTED"];

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const q = (searchParams.get("q") ?? "").trim().slice(0, 60);

  const where: Prisma.CreditNoteWhereInput = {
    ...(status && STATUSES.includes(status as CreditNoteStatus) ? { status: status as CreditNoteStatus } : {}),
    ...(q
      ? {
          OR: [
            { creditNo: { contains: q, mode: "insensitive" } },
            { invoiceNo: { contains: q, mode: "insensitive" } },
            { deliverToName: { contains: q, mode: "insensitive" } },
            { billToName: { contains: q, mode: "insensitive" } },
            { accountNo: { contains: q, mode: "insensitive" } },
            { sourceFilename: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [notes, grouped, account] = await Promise.all([
    ctx.db.creditNote.findMany({
      where,
      orderBy: [{ creditDate: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 200,
      include: {
        collections: {
          where: { source: { in: ["AUTO", "MANUAL"] } },
          select: { collection: { select: { collectionNo: true } } },
        },
      },
    }),
    ctx.db.creditNote.groupBy({ by: ["status"], _count: { _all: true } }),
    ctx.db.cloudAccount.findFirst({
      where: { provider: "onedrive" },
      select: { creditsFolderPath: true, creditsCheckedAt: true, creditsError: true },
    }),
  ]);

  if (account?.creditsFolderPath) scheduleCreditsWork(ctx.tenantId);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<CreditNoteStatus, number>;
  for (const g of grouped) counts[g.status] = g._count._all;

  return NextResponse.json({
    folder: {
      connected: !!account,
      path: account?.creditsFolderPath ?? null,
      checkedAt: account?.creditsCheckedAt?.toISOString() ?? null,
      error: account?.creditsError ?? null,
    },
    counts,
    creditNotes: notes.map((n) => {
      const issues = (n.issues as unknown as CreditIssue[] | null) ?? [];
      return {
        id: n.id,
        creditNo: n.creditNo,
        invoiceNo: n.invoiceNo,
        creditDate: n.creditDate?.toISOString().slice(0, 10) ?? null,
        customerName: n.deliverToName ?? n.billToName,
        accountNo: n.accountNo,
        total: n.total === null ? null : Number(n.total),
        status: n.status,
        reviewCount: issues.filter((i) => i.level === "review").length,
        warningCount: issues.filter((i) => i.level === "warning").length,
        collectionNos: n.collections.map((c) => c.collection.collectionNo),
        sourceFilename: n.sourceFilename,
        sourceFolder: n.sourceFolder,
        fileError: n.fileError,
        readSource: n.readSource,
        uploadedBy: n.uploadedBy,
        signedByName: n.signedByName,
        signedAt: n.signedAt?.toISOString() ?? null,
        filingError: n.filingError,
        receivedAt: n.createdAt.toISOString(),
      };
    }),
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a PDF to upload" }, { status: 400 });
  }
  if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
    return NextResponse.json({ error: "That file is too large" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!looksLikePdf(buffer)) {
    return NextResponse.json({ error: "That file is not a PDF (no PDF header found)" }, { status: 400 });
  }
  // Kept under its own name: the accounting software's name (CR-407712-C007H014)
  // is what the office will look for in the folder.
  const filename = sanitizeInvoiceFilename(file.name);
  if (!filename) {
    return NextResponse.json({ error: "That filename cannot be used" }, { status: 400 });
  }

  const result = await uploadCreditNote(ctx.tenantId, filename, buffer, ctx.name);
  switch (result.outcome) {
    case "not_configured":
      return NextResponse.json(
        { error: "Choose a credits folder in Settings → OneDrive first." },
        { status: 409 }
      );
    case "conflict":
      return NextResponse.json(
        { error: `${result.filename} is already in the credits folder.`, conflict: true },
        { status: 409 }
      );
    case "closed":
      return NextResponse.json({ error: "That credit note has already been dealt with." }, { status: 409 });
    default:
      return NextResponse.json({ success: true, ...result });
  }
});
