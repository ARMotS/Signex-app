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
} from "@/lib/collections";
import { logAudit } from "@/lib/audit";
import { RECEIPT_STATUSES, scheduleCollectionReceipt } from "@/lib/collection-notify";
import { getScope, requireRole } from "@/lib/tenant";
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
    },
  });

  if (!collection) return null;

  if (ctx.role === "DRIVER") {
    const driver = await ctx.db.driver.findFirst({ where: { id: ctx.userId } });
    if (!driver || collection.tripSheet.driverId !== driver.id) return null;
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

  const body = await request.json();
  const {
    status,
    exceptionReason,
    collectedQty,
    signedByName,
    signatureImage,
  } = body as {
    status: CollectionStatus;
    exceptionReason?: string;
    collectedQty?: number | null;
    signedByName?: string;
    signatureImage?: string;
  };

  const validation = validateCollectionOutcome({
    status,
    exceptionReason,
    collectedQty: collectedQty ?? null,
    expectedQty: collection.expectedQty,
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
          where: { id: collection.tripSheet.driverId },
        });

  const collectedAt = new Date();

  // 1. The record first. Everything below can fail without costing a signature.
  const updated = await ctx.db.collection.update({
    where: { id },
    data: {
      status,
      exceptionReason: exceptionReason?.trim() || null,
      collectedQty: collectedQty ?? null,
      signedByName: signedByName?.trim() || null,
      signature: signatureImage || null,
      collectedAt,
      driverId: driver?.id ?? null,
    },
  });

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
        collectedQty: collectedQty ?? null,
        exceptionReason: exceptionReason?.trim() || null,
        notes: collection.notes,
        customerName: collection.stop.customerName,
        signedByName: signedByName?.trim() || null,
        driverName: driver?.name ?? null,
        collectedAt,
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
      data: { signedFilePath: outputName, signedFileId: saved.fileId ?? null },
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

  // 3. The customer's copy, after the response — never in the driver's way, and
  //    never able to fail what is already recorded. Scheduled after the document
  //    step so the signed sheet exists to attach.
  if (RECEIPT_STATUSES.includes(status)) {
    await scheduleCollectionReceipt(ctx.tenantId, id);
  }

  return NextResponse.json({
    success: true,
    status: updated.status,
    signedFilePath,
    // Surfaced rather than swallowed: the driver has finished, but the office
    // has a document to produce by hand.
    documentError,
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
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
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

  const updated = await ctx.db.collection.update({
    where: { id },
    data: {
      type,
      // A credit return has no subtype; clearing it keeps the row honest after
      // an uplift is re-typed.
      upliftSubtype: type === "NON_CREDIT_UPLIFT" ? upliftSubtype : null,
      notes,
      ...(body.originalInvoiceNo !== undefined && {
        originalInvoiceNo: String(body.originalInvoiceNo).trim() || null,
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
