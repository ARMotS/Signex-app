/**
 * courier-collect.ts
 * The courier driver signs for a courier trip sheet at the office, and each
 * invoice on it gets a stamped copy in the existing signed-invoice location.
 *
 * The handover is recorded FIRST, in one conditional update, and the sheet
 * becomes COLLECTED there and then (client decision): once the courier has
 * driven off with the goods, a OneDrive outage must not leave the sheet
 * "awaiting collection" and signable a second time. Filing the signed copies
 * follows, idempotent per invoice; a copy that cannot be filed is recorded on
 * the sheet (filingError) and finished by "Retry filing". The confirmation
 * email waits for filingCompletedAt — the customer is sent signed copies, so
 * they must all exist first.
 */

import type { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { readConfig, readDispatchCompany } from "./config";
import { readInvoiceFile, saveSignedInvoiceDetailed } from "./invoices";
import { CourierError, recheckCourierSheet } from "./courier-import";
import { courierStampLines } from "./courier-stamp-text";
import { pngFromDataUrl, stampCourierHandover } from "./courier-stamp";
import { scheduleCourierConfirmation } from "./courier-confirm";

const MAX_SIGNATURE_BYTES = 600_000;
const FILING_ATTEMPTS = 3;
const FILING_CONCURRENCY = 3;

export interface CollectInput {
  dispatcherName: string;
  courierDriverName: string;
  courierCompany: string;
  /** "I have checked {parcels} parcel(s) for {invoiceCount} invoice(s)". */
  checked: boolean;
  /** PNG data URL from the signature pad. */
  signature: string;
}

/** The form, or every reason it cannot be submitted. Shared rules for the screen and the route. */
export function readCollectInput(body: unknown): { ok: true; input: CollectInput } | { ok: false; errors: string[] } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const input: CollectInput = {
    dispatcherName: text(b.dispatcherName),
    courierDriverName: text(b.courierDriverName),
    courierCompany: text(b.courierCompany),
    checked: b.checked === true,
    signature: typeof b.signature === "string" ? b.signature : "",
  };
  const errors: string[] = [];
  if (!input.checked) errors.push("Tick that the parcels were checked.");
  if (!input.dispatcherName) errors.push("Enter the dispatcher's name.");
  if (!input.courierDriverName) errors.push("Enter the courier driver's name.");
  if (!input.courierCompany) errors.push("Enter the courier company.");
  for (const [label, value] of [
    ["Dispatcher name", input.dispatcherName],
    ["Courier driver name", input.courierDriverName],
    ["Courier company", input.courierCompany],
  ] as const) {
    if (value.length > 80) errors.push(`${label} is too long.`);
  }
  if (!input.signature || input.signature.length > MAX_SIGNATURE_BYTES || !pngFromDataUrl(input.signature)) {
    errors.push("The courier driver needs to sign.");
  }
  return errors.length ? { ok: false, errors } : { ok: true, input };
}

/**
 * Record the handover. Re-checked first, so a block that appeared since the
 * page loaded (the invoice signed in-house meanwhile, its PDF deleted) still
 * stops it. Exactly one submission wins the conditional update.
 */
export async function collectCourierSheet(
  tenantId: string,
  id: string,
  input: CollectInput,
  by: { userId: string; name: string | null }
) {
  const db = scopedPrisma(tenantId);
  const before = await db.courierTripSheet.findFirst({ where: { id }, select: { status: true, courierCompany: true } });
  if (!before) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
  if (before.status === "COLLECTED" || before.status === "DELIVERED") {
    throw new CourierError("ALREADY_COLLECTED", "The courier has already signed for this sheet.", 409);
  }

  await recheckCourierSheet(tenantId, id, by.name);
  const checked = await db.courierTripSheet.findFirst({ where: { id }, select: { status: true, issues: true } });
  if (checked?.status === "NEEDS_ATTENTION") {
    throw new CourierError("NEEDS_ATTENTION", "Something on the sheet needs fixing before the courier can sign.", 409, {
      issues: checked.issues,
    });
  }

  const dispatchCompany = await readDispatchCompany(tenantId);
  // The sheet's own Courier column is the record; what the form sent counts
  // only for a sheet in the older layout, which names no courier.
  const courierCompany = before.courierCompany?.trim() || input.courierCompany;
  const now = new Date();
  const claim = await db.courierTripSheet.updateMany({
    where: { id, status: "AWAITING_COLLECTION" },
    data: {
      status: "COLLECTED",
      collectedAt: now,
      dispatcherName: input.dispatcherName,
      dispatcherUserId: by.userId,
      dispatchCompany,
      courierDriverName: input.courierDriverName,
      courierCompany,
      driverSignature: input.signature,
      filingError: null,
    },
  });
  if (claim.count === 0) {
    throw new CourierError("ALREADY_COLLECTED", "This handover has just been recorded by someone else.", 409);
  }

  await logAudit({
    action: "SIGN",
    entity: "courier_sheet",
    entityId: id,
    userName: by.name ?? undefined,
    details: `Collected by ${input.courierDriverName} (${courierCompany}), dispatched by ${input.dispatcherName} from ${dispatchCompany}`,
    tenantId,
  });

  return fileCourierSheet(tenantId, id, by.name);
}

async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= FILING_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (attempt < FILING_ATTEMPTS) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw last;
}

export interface FilingResult {
  filed: number;
  failed: { invoiceNo: string; error: string }[];
  complete: boolean;
}

/**
 * Stamp and file every invoice not filed yet. Idempotent: an invoice with a
 * signedAt is done and left alone, so "Retry filing" only does what is left.
 */
export async function fileCourierSheet(tenantId: string, id: string, userName: string | null = null): Promise<FilingResult> {
  const db = scopedPrisma(tenantId);
  const sheet = await db.courierTripSheet.findFirst({
    where: { id },
    select: {
      status: true,
      courierSheetNo: true,
      collectedAt: true,
      dispatcherName: true,
      dispatchCompany: true,
      courierDriverName: true,
      courierCompany: true,
      driverSignature: true,
      filingCompletedAt: true,
      invoices: {
        orderBy: { lineNo: "asc" },
        select: { id: true, invoiceNo: true, invoiceFile: true, waybillNo: true, signedAt: true },
      },
    },
  });
  if (!sheet) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
  if (sheet.status !== "COLLECTED" && sheet.status !== "DELIVERED") {
    throw new CourierError("NOT_COLLECTED", "The courier has not signed for this sheet yet.", 409);
  }
  const pending = sheet.invoices.filter((i) => !i.signedAt);
  if (pending.length === 0) return { filed: 0, failed: [], complete: true };

  const signature = sheet.driverSignature ? pngFromDataUrl(sheet.driverSignature) : null;
  if (!signature) {
    // Cleared only once everything was filed — reaching here means a copy
    // went missing afterwards. Say so rather than stamp without a signature.
    const error = "The courier's signature is no longer held, so the remaining copies cannot be stamped.";
    await db.courierTripSheet.updateMany({ where: { id }, data: { filingError: error } });
    return { filed: 0, failed: pending.map((p) => ({ invoiceNo: p.invoiceNo, error })), complete: false };
  }

  const { courierStampArea } = await readConfig(tenantId);
  const failed: FilingResult["failed"] = [];
  let filed = 0;

  const fileOne = async (inv: (typeof pending)[number]) => {
    try {
      if (!inv.invoiceFile) throw new Error("No invoice PDF on file.");
      const original = await withRetries(async () => {
        const buf = await readInvoiceFile(tenantId, inv.invoiceFile!);
        if (!buf) throw new Error("The invoice PDF is no longer in the invoice folder.");
        return buf;
      });
      const { pdf } = await stampCourierHandover(original, {
        lines: courierStampLines({
          dispatcherName: sheet.dispatcherName ?? "",
          dispatchCompany: sheet.dispatchCompany ?? "",
          courierDriverName: sheet.courierDriverName ?? "",
          courierCompany: sheet.courierCompany ?? "",
          at: sheet.collectedAt ?? new Date(),
          courierSheetNo: sheet.courierSheetNo,
          waybillNo: inv.waybillNo,
        }),
        signaturePng: signature,
        area: courierStampArea,
      });
      // The existing signed-invoice location and name — the invoice's own
      // filename in signed/. The original is never touched.
      const saved = await withRetries(() => saveSignedInvoiceDetailed(tenantId, inv.invoiceFile!, pdf));
      await db.courierTripSheetInvoice.updateMany({
        where: { id: inv.id, signedAt: null },
        data: { signedAt: new Date(), signedFileName: inv.invoiceFile, signedFileId: saved.itemId, signedFilePath: saved.path },
      });
      filed++;
    } catch (err) {
      failed.push({ invoiceNo: inv.invoiceNo, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  };

  for (let i = 0; i < pending.length; i += FILING_CONCURRENCY) {
    await Promise.all(pending.slice(i, i + FILING_CONCURRENCY).map(fileOne));
  }

  const complete = failed.length === 0;
  const data: Prisma.CourierTripSheetUpdateManyMutationInput = complete
    ? // Filed: the stamped PDFs are the record now, as for collections.
      { filingCompletedAt: new Date(), filingError: null, driverSignature: null }
    : { filingError: failed.map((f) => `Invoice ${f.invoiceNo}: ${f.error}`).join(" · ").slice(0, 2000) };
  await db.courierTripSheet.updateMany({ where: { id }, data });

  await logAudit({
    action: "UPLOAD",
    entity: "courier_sheet",
    entityId: id,
    userName: userName ?? undefined,
    details: complete
      ? `Signed copies filed for ${filed} invoice${filed === 1 ? "" : "s"}`
      : `${failed.length} signed cop${failed.length === 1 ? "y" : "ies"} could not be filed: ${failed.map((f) => f.invoiceNo).join(", ")}`,
    tenantId,
  });

  // Every copy is filed: the customer's email (which carries them) can go.
  if (complete) await scheduleCourierConfirmation(tenantId, id);
  return { filed, failed, complete };
}
