import { NextRequest, NextResponse } from "next/server";
import type { CollectionStatus, CollectionType, UpliftSubtype } from "@prisma/client";
import {
  buildSignedCollectionPdf,
  readCollectionDocument,
  resolveCollectionSource,
  saveSignedCollection,
  signedCollectionFilename,
  validateCollectionOutcome,
  validateCollectionType,
  isTerminalStatus,
  type ReceiptLine,
} from "@/lib/collections";
import {
  DIFF_REASON_LABEL,
  resolveConfirmation,
  type Confirmation,
  type ConfirmInput,
} from "@/lib/collection-confirm";
import { logAudit } from "@/lib/audit";
import { readCollectionDeclaration, readInvoiceNoPattern } from "@/lib/config";
import { normalizedInvoiceNoOrNull } from "@/lib/invoice-number";
import { RECEIPT_STATUSES, sendCollectionReceiptEmail } from "@/lib/collection-notify";
import { getScope, requireOffice } from "@/lib/tenant";
import { normalizeRemovalReason, removeCollectionFromTrip } from "@/lib/stop-removal";
import { withAuth } from "@/lib/api-handler";

/**
 * Recording an outcome downloads the source document from OneDrive, stamps it
 * and uploads the result back — the same chain of real work that signing an
 * invoice does, and far longer than the platform's default budget. A timeout
 * here would leave a collection the customer has signed for with no document
 * on file.
 */
export const maxDuration = 60;

const VALID_TYPES: CollectionType[] = ["CREDIT_RETURN", "NON_CREDIT_UPLIFT"];
const VALID_SUBTYPES: UpliftSubtype[] = [
  "COMPANY_PARCEL",
  "EQUIPMENT_OR_CRATES",
  "DOCUMENTS",
  "SPECIAL_REQUEST",
];

/**
 * A collection id from another ADMIN's scope is "not found" — 404, never a 403
 * that would confirm it exists. Drivers are narrowed further to the trip sheets
 * assigned to them.
 */
async function loadCollection(
  ctx: Awaited<ReturnType<typeof getScope>>,
  id: string
) {
  const collection = await ctx.db.collection.findFirst({
    where: { id },
    include: {
      stop: { select: { id: true, customerName: true, stopNumber: true } },
      tripSheet: { select: { driverId: true } },
      // What the office's sheet lists — shown to the driver read-only. The
      // sheet carries no prices, and nothing priced is selected here.
      lines: {
        orderBy: { lineNo: "asc" },
        select: {
          lineNo: true,
          itemCode: true,
          shortName: true,
          description: true,
          qtyListed: true,
          type: true,
          isExtra: true,
        },
      },
    },
  });

  if (!collection) return null;

  if (ctx.role === "DRIVER") {
    // An archived collection (its trip completed) has no trip left, so it is
    // no driver's any more — as before collections were kept, when it was gone.
    const driver = await ctx.db.driver.findFirst({ where: { id: ctx.userId } });
    if (!driver || !collection.tripSheet || collection.tripSheet.driverId !== driver.id) return null;
  }

  return collection;
}

export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  const { id } = await params;

  const collection = await loadCollection(ctx, id);
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  // A document the office added after the sheet was imported is picked up
  // here, so the driver at the door sees it. Outstanding work only — a closed
  // collection's paperwork is already on its signed copy.
  if (collection.status === "PENDING" && !collection.sourceFilePath) {
    collection.sourceFilePath = await resolveCollectionSource(ctx.tenantId, collection);
  }

  // The signature is a full-size PNG data URL. It is not sent to a list screen
  // and it is not sent here either — nothing renders it, and it is already
  // baked into the stamped PDF.
  const { signature, ...rest } = collection;
  return NextResponse.json({ collection: { ...rest, hasSignature: !!signature } });
});

/**
 * Record what happened at the customer.
 *
 * The signature is durable before anything else is attempted, in the same order
 * the invoice flow uses: the row is what the office and the archive read, and a
 * failed OneDrive upload must not cost a signature the customer has already
 * given. A document that could not be written leaves signedFilePath null, which
 * the dispatcher sees as an exception to chase rather than as a lost collection.
 */
export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  const { id } = await params;

  const collection = await loadCollection(ctx, id);
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  // Mirrors the invoice sign page, which refuses a stop that is already SIGNED.
  // An office correction is an ADMIN action, on purpose: re-recording rewrites
  // the document a customer has already signed for.
  if (ctx.role === "DRIVER" && isTerminalStatus(collection.status)) {
    return NextResponse.json(
      { error: "This collection has already been completed. Ask the office to change it." },
      { status: 409 }
    );
  }

  // Its trip is closed and archived. Re-recording would rewrite a signed
  // document the archive and any credit note already rely on.
  if (!collection.tripSheet) {
    return NextResponse.json(
      { error: "This collection's trip sheet has been completed and archived; its outcome can no longer be changed." },
      { status: 409 }
    );
  }
  const tripDriverId = collection.tripSheet.driverId;

  const body = await request.json();
  const { signedByName, signatureImage } = body as {
    signedByName?: string;
    signatureImage?: string;
  };

  // Two shapes. With `mode`, the driver confirmed against the office's sheet
  // (confirm-by-exception) and the outcome is derived from the lines. Without
  // it, the outcome is given directly — a collection whose sheet was never
  // read, and any phone still running the previous version of the screen.
  const listedLines = collection.lines.filter((l) => !l.isExtra);
  let status: CollectionStatus;
  let exceptionReason: string | null;
  let collectedQty: number | null;
  let confirmation: Extract<Confirmation, { ok: true }> | null = null;

  if (body.mode !== undefined) {
    if (listedLines.length === 0) {
      return NextResponse.json(
        { error: "This collection has no sheet lines to confirm against — record the outcome directly." },
        { status: 400 }
      );
    }
    const resolved = resolveConfirmation(listedLines, body as ConfirmInput);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    confirmation = resolved;
    status = resolved.status;
    exceptionReason = resolved.exceptionReason;
    collectedQty = resolved.collectedItems;
  } else {
    status = body.status as CollectionStatus;
    exceptionReason = typeof body.exceptionReason === "string" ? body.exceptionReason.trim() || null : null;
    collectedQty = body.collectedQty ?? null;
  }

  const validation = validateCollectionOutcome({
    status,
    exceptionReason,
    // Line counts are checked line by line above; the box count is not an
    // item count, so it is only compared on the direct path.
    collectedQty: confirmation ? null : collectedQty,
    expectedQty: confirmation ? null : collection.expectedQty,
    signedByName,
    signatureImage,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const driver =
    ctx.role === "DRIVER"
      ? await ctx.db.driver.findFirst({ where: { id: ctx.userId } })
      : await ctx.db.driver.findFirst({
          where: { id: tripDriverId },
        });

  const collectedAt = new Date();

  // 1. The record first, lines and all, in one transaction. Everything below
  //    can fail without costing a signature.
  const lineType = listedLines[0]?.type ?? "CREDIT_RETURN";
  const updated = await ctx.db.$transaction(async (tx) => {
    const row = await tx.collection.update({
      where: { id },
      data: {
        status,
        exceptionReason,
        collectedQty,
        signedByName: signedByName?.trim() || null,
        signature: signatureImage || null,
        collectedAt,
        driverId: driver?.id ?? null,
        hasVariance: confirmation?.hasVariance ?? false,
        failReason: confirmation?.failReason ?? null,
      },
    });
    if (confirmation) {
      for (const u of confirmation.lineUpdates) {
        await tx.collectionLine.updateMany({
          where: { collectionId: id, lineNo: u.lineNo, isExtra: false },
          data: { qtyCollected: u.qtyCollected, diffReason: u.diffReason, diffNote: u.diffNote },
        });
      }
      // An office re-record replaces the extras rather than adding to them.
      await tx.collectionLine.deleteMany({ where: { collectionId: id, isExtra: true } });
      const lastLineNo = Math.max(...listedLines.map((l) => l.lineNo));
      if (confirmation.extras.length > 0) {
        await tx.collectionLine.createMany({
          data: confirmation.extras.map((e, i) => ({
            collectionId: id,
            lineNo: lastLineNo + i + 1,
            description: e.description,
            qtyListed: 0,
            qtyCollected: e.qty,
            isExtra: true,
            type: lineType,
          })),
        });
      }
    }
    return row;
  });

  // The receipt's item table, straight from what was just recorded.
  const receiptLines: ReceiptLine[] | undefined = confirmation
    ? [
        ...listedLines.map((l) => {
          const u = confirmation!.lineUpdates.find((x) => x.lineNo === l.lineNo)!;
          return {
            itemCode: l.itemCode,
            description: l.description,
            qtyListed: l.qtyListed,
            qtyCollected: u.qtyCollected,
            diffReason: u.diffReason ? DIFF_REASON_LABEL[u.diffReason] : null,
            diffNote: u.diffNote,
            isExtra: false,
          };
        }),
        ...confirmation.extras.map((e) => ({
          itemCode: null,
          description: e.description,
          qtyListed: 0,
          qtyCollected: e.qty,
          diffReason: null,
          diffNote: null,
          isExtra: true,
        })),
      ]
    : undefined;

  // 2. The document. A NOT_AVAILABLE or REFUSED collection still produces one —
  //    "we went and it was not there" is a result accounts needs on paper too.
  let signedFilePath: string | null = null;
  let documentError: string | null = null;

  try {
    // Re-checked rather than trusted from import: the office may have added
    // the document since, and the receipt belongs on it when it exists.
    const sourceName = await resolveCollectionSource(ctx.tenantId, collection);

    const outputName = signedCollectionFilename(
      sourceName,
      collection.collectionNo,
      status
    );
    if (!outputName) throw new Error("Could not derive a filename for the receipt");

    const sourcePdf = sourceName
      ? await readCollectionDocument(ctx.tenantId, sourceName)
      : null;

    const signatureBytes = signatureImage
      ? Uint8Array.from(
          Buffer.from(signatureImage.replace(/^data:image\/png;base64,/, ""), "base64")
        )
      : null;

    const pdf = await buildSignedCollectionPdf(
      sourcePdf,
      {
        collectionNo: collection.collectionNo,
        type: collection.type,
        upliftSubtype: collection.upliftSubtype,
        originalInvoiceNo: collection.originalInvoiceNo,
        status,
        expectedQty: collection.expectedQty,
        collectedQty,
        exceptionReason,
        notes: collection.notes,
        customerName: collection.stop?.customerName ?? collection.customerName ?? "Unknown",
        signedByName: signedByName?.trim() || null,
        driverName: driver?.name ?? null,
        collectedAt,
        lines: receiptLines,
        declaration: await readCollectionDeclaration(ctx.tenantId),
      },
      signatureBytes
    );

    const saved = await saveSignedCollection(ctx.tenantId, outputName, pdf);

    // The FILENAME, not saved.filePath: it is the key both the OneDrive reader
    // and the local reader address a file by. saved.filePath is a display
    // location that would not survive the folder being reconfigured.
    signedFilePath = outputName;

    await ctx.db.collection.update({
      where: { id },
      data: {
        signedFilePath: outputName,
        signedFileId: saved.fileId ?? null,
        // Whether the office's original pages are inside this PDF. Only then
        // may the original be cleared out of Pending/ when the trip completes.
        signedIncludesSource: sourcePdf !== null,
      },
    });
  } catch (err) {
    console.error(`Failed to write the signed document for collection ${id}:`, err);
    documentError =
      "The collection is recorded, but its document could not be written to the collections folder.";
  }

  await logAudit({
    action: "SIGN",
    entity: "collection",
    entityId: id,
    userName: driver?.name || ctx.name,
    details: `Collection ${collection.collectionNo} → ${status}${
      exceptionReason ? ` (${exceptionReason})` : ""
    }${documentError ? " — document NOT written" : ""}`,
    tenantId: ctx.tenantId,
  });

  // 3. The customer's copy, sent as part of Confirm so the driver sees whether
  //    it went. Inside this request, not deferred: the office wanted the email
  //    tied to the driver's confirmation, with the dispatcher's Send as the
  //    fallback only when it fails. It still cannot fail what is recorded —
  //    sendCollectionReceiptEmail never throws, the record and document are
  //    already written, and the transport's timeouts are bounded in lib/email.ts
  //    so a dead network costs the driver seconds, not minutes.
  const email = RECEIPT_STATUSES.includes(status)
    ? await sendCollectionReceiptEmail(ctx.tenantId, id)
    : null;

  return NextResponse.json({
    success: true,
    status: updated.status,
    signedFilePath,
    // Surfaced rather than swallowed: the driver has finished, but the office
    // has a document to produce by hand.
    documentError,
    email: email && {
      outcome: email.outcome,
      recipient: email.recipient ?? null,
      error: email.error ?? null,
    },
  });
});

/**
 * Office corrections: the type a sheet guessed wrong, the invoice a credit
 * actually goes back against, the quantity the depot expected.
 *
 * ADMIN only. These are the fields accounts reconciles on, and a driver
 * standing at a door is not the person who should be changing them.
 */
export const PATCH = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const collection = await loadCollection(ctx, id);
  if (!collection) {
    return NextResponse.json({ error: "Collection not found" }, { status: 404 });
  }

  const body = await request.json();
  const type: CollectionType = body.type ?? collection.type;
  const upliftSubtype: UpliftSubtype | null =
    body.upliftSubtype !== undefined ? body.upliftSubtype : collection.upliftSubtype;
  const notes: string | null =
    body.notes !== undefined ? String(body.notes).trim() || null : collection.notes;

  if (!VALID_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `Invalid type. Use: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (upliftSubtype && !VALID_SUBTYPES.includes(upliftSubtype)) {
    return NextResponse.json(
      { error: `Invalid uplift subtype. Use: ${VALID_SUBTYPES.join(", ")}` },
      { status: 400 }
    );
  }

  const typing = validateCollectionType(type, upliftSubtype, notes);
  if (!typing.ok) {
    return NextResponse.json({ error: typing.error }, { status: 400 });
  }

  const originalInvoiceNo =
    body.originalInvoiceNo !== undefined
      ? String(body.originalInvoiceNo ?? "").trim() || null
      : undefined;

  const updated = await ctx.db.collection.update({
    where: { id },
    data: {
      type,
      // A credit return has no subtype; clearing it keeps the row honest after
      // an uplift is re-typed.
      upliftSubtype: type === "NON_CREDIT_UPLIFT" ? upliftSubtype : null,
      notes,
      ...(originalInvoiceNo !== undefined && {
        originalInvoiceNo,
        invoiceNoNormalized: normalizedInvoiceNoOrNull(
          originalInvoiceNo,
          await readInvoiceNoPattern(ctx.tenantId)
        ),
      }),
      ...(body.expectedQty !== undefined && {
        expectedQty:
          body.expectedQty === null || body.expectedQty === ""
            ? null
            : Number(body.expectedQty),
      }),
    },
  });

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "collection",
    entityId: id,
    userName: ctx.name,
    details: `Collection ${collection.collectionNo} edited (${type}${
      updated.upliftSubtype ? `/${updated.upliftSubtype}` : ""
    })`,
    tenantId: ctx.tenantId,
  });

  const { signature, ...rest } = updated;
  return NextResponse.json({
    success: true,
    collection: { ...rest, hasSignature: !!signature },
  });
});

/**
 * Take a collection off the run before the driver gets to it — the customer
 * rang to say not to collect. ADMIN only, reason required, kept as a
 * RemovedCollection record. A collection from another scope is 404; one the
 * driver has already recorded, or whose trip is archived, is 409.
 */
export const DELETE = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const body = await request.json().catch(() => ({}));
  const reason = normalizeRemovalReason(body?.reason);
  if (!reason) {
    return NextResponse.json({ error: "A reason is required to remove a collection" }, { status: 400 });
  }

  const result = await removeCollectionFromTrip(ctx.tenantId, id, { reason, removedBy: ctx.name });
  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    case "done":
      return NextResponse.json(
        { error: "The driver has already recorded this collection — it can no longer be removed." },
        { status: 409 }
      );
    case "closed":
      return NextResponse.json(
        { error: "This collection's trip sheet has been completed and archived." },
        { status: 409 }
      );
    case "removed":
      return NextResponse.json({ success: true, ...result });
  }
});
