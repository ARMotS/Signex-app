/**
 * courier-import.ts
 * Courier trip sheets in the database and the folders: import, the checks
 * behind "needs attention", the office's fixes, and the kept original.
 *
 * The rules themselves are in lib/courier-sheet.ts. Everything here is scoped:
 * the invoice folder, stops, other courier sheets and contacts it consults are
 * the caller's own, so a sheet can never be flagged (or cleared) by another
 * scope's runs.
 */

import fs from "fs";
import path from "path";
import { Prisma, type CourierStatus } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { readInvoiceNoPattern } from "./config";
import { ensureInvoices } from "./invoice-registry";
import { buildInvoiceLookup, matchInvoiceFile } from "./invoice-number";
import { listInvoiceFiles } from "./invoices";
import { logAudit } from "./audit";
import { parseWithTemplate, readGrid } from "./sheet-mapping";
import { chooseTemplate, templateRef, templateSnapshot, type TemplatePrompt } from "./sheet-templates";
import { getTripSheetFolderPath } from "./trip-sheet-folder";
import { downloadFileById } from "./microsoft-graph";
import { fileCourierOriginal, resolveCourierFolder } from "./courier-folder";
import {
  assessCourierSheet,
  blocksHandover,
  companyKey,
  confirmationState,
  originalFileName,
  originalFolder,
  readCourierSheet,
  todayInJohannesburg,
  type ConfirmationState,
  type CourierIssue,
  type CourierSheetRead,
  type LineFacts,
} from "./courier-sheet";

/** Statuses in which the sheet is still the office's to change. */
const OPEN: CourierStatus[] = ["NEEDS_ATTENTION", "AWAITING_COLLECTION"];

/** Codes found while reading the file — kept across re-checks, which cannot see the file. */
const READ_CODES = new Set<CourierIssue["code"]>(["DUPLICATE_INVOICE"]);

const MAX_BYTES = 10 * 1024 * 1024;

export class CourierError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public extra: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

// ─── Facts ────────────────────────────────────────────────────────────────

interface ContactMatch {
  id: string;
  companyName: string;
  email: string | null;
}

/**
 * What the scope knows about these invoices and this customer: the PDFs,
 * whether one of our drivers has them, whether another courier sheet does,
 * and the contact. `excludeSheetId` keeps a sheet from flagging itself.
 */
async function gatherFacts(
  tenantId: string,
  lines: { invoiceNo: string; invoiceNoNormalized: string | null }[],
  customerName: string,
  opts: { excludeSheetId?: string; contactId?: string | null } = {}
): Promise<{ facts: LineFacts[]; contact: ContactMatch | null }> {
  const db = scopedPrisma(tenantId);
  const [files, pattern] = await Promise.all([listInvoiceFiles(tenantId), readInvoiceNoPattern(tenantId)]);
  const lookup = buildInvoiceLookup(files, 3, pattern);
  const signedFiles = new Set(files.filter((f) => f.isSigned).map((f) => f.filename.toLowerCase()));
  const keys = lines.map((l) => l.invoiceNoNormalized).filter((k): k is string => !!k);

  const [stops, others, contacts] = await Promise.all([
    keys.length
      ? db.stop.findMany({
          where: { invoiceNoNormalized: { in: keys } },
          select: {
            invoiceNoNormalized: true,
            status: true,
            tripSheet: { select: { driver: { select: { name: true } } } },
          },
        })
      : Promise.resolve([]),
    keys.length
      ? db.courierTripSheetInvoice.findMany({
          where: {
            invoiceNoNormalized: { in: keys },
            ...(opts.excludeSheetId ? { courierSheetId: { not: opts.excludeSheetId } } : {}),
          },
          select: { invoiceNoNormalized: true, courierSheet: { select: { courierSheetNo: true } } },
        })
      : Promise.resolve([]),
    db.contact.findMany({
      where: { deletedAt: null, ...(opts.contactId ? { id: opts.contactId } : {}) },
      select: { id: true, companyName: true, email: true },
    }),
  ]);

  const facts = lines.map((line): LineFacts => {
    const file = matchInvoiceFile(lookup, line.invoiceNo, 3, pattern) ?? null;
    const key = line.invoiceNoNormalized;
    const mine = key ? stops.filter((s) => s.invoiceNoNormalized === key) : [];
    const live = mine.find((s) => s.status !== "SIGNED");
    const other = key ? others.find((o) => o.invoiceNoNormalized === key) : undefined;
    return {
      invoiceNo: line.invoiceNo,
      invoiceFile: file,
      signedInHouse: (!!file && signedFiles.has(file.toLowerCase())) || mine.some((s) => s.status === "SIGNED"),
      liveRun: live ? { driverName: live.tripSheet?.driver?.name ?? "a driver" } : null,
      otherCourierSheet: other ? { courierSheetNo: other.courierSheet.courierSheetNo } : null,
    };
  });

  // A contact linked by hand stands; otherwise the exact company name finds
  // one — preferring one with an email, as that is what the contact is for.
  let contact: ContactMatch | null = null;
  if (opts.contactId) {
    contact = contacts[0] ?? null;
  } else {
    const key = companyKey(customerName);
    const named = contacts.filter((c) => companyKey(c.companyName) === key);
    contact = named.find((c) => c.email?.trim()) ?? named[0] ?? null;
  }
  return { facts, contact };
}

const issuesOf = (value: Prisma.JsonValue | null): CourierIssue[] =>
  Array.isArray(value) ? (value as unknown as CourierIssue[]) : [];

// ─── Preview and import ───────────────────────────────────────────────────

export interface CourierPreview {
  template: { id: string; name: string; prompts: TemplatePrompt[] };
  sheet: CourierSheetRead;
  lines: (CourierSheetRead["lines"][number] & { invoiceFile: string | null })[];
  contact: ContactMatch | null;
  issues: CourierIssue[];
  status: CourierStatus;
  /** A sheet with this number already imported in this scope. */
  duplicateOf: { id: string; status: CourierStatus } | null;
}

interface ReadInput {
  buffer: Buffer;
  filename: string;
  templateId?: string | null;
  prompts: Record<string, string>;
}

/** Read a courier trip sheet and check it, without saving anything. */
export async function previewCourierSheet(tenantId: string, input: ReadInput): Promise<CourierPreview> {
  if (!/\.xlsx?$/i.test(input.filename)) {
    throw new CourierError("UNSUPPORTED_FILE", "Courier trip sheets are imported from Excel (.xlsx or .xls).", 400);
  }
  if (input.buffer.length > MAX_BYTES) {
    throw new CourierError("FILE_TOO_LARGE", "File too large. Maximum size is 10MB.", 400);
  }

  const choice = await chooseTemplate(tenantId, "COURIER_TRIP_SHEET", input.buffer, input.filename, input.templateId);
  if (!choice.ok) {
    throw new CourierError(choice.code, choice.error, choice.code === "TEMPLATE_NOT_FOUND" ? 404 : 400, {
      missingColumns: choice.missingColumns,
      template: choice.template,
    });
  }

  const grid = readGrid(input.buffer, input.filename, choice.template.worksheet);
  if (!grid.ok) throw new CourierError("UNREADABLE", grid.error, 400);
  const mapped = parseWithTemplate(grid.grid, choice.template, { prompts: input.prompts, filename: input.filename });
  if (mapped.missingColumns.length > 0) {
    throw new CourierError(
      "MISSING_COLUMNS",
      `This sheet is missing ${mapped.missingColumns.map((m) => `"${m.column}" (${m.label})`).join(", ")}.`,
      400,
      { missingColumns: mapped.missingColumns, template: templateRef(choice) }
    );
  }

  const pattern = await readInvoiceNoPattern(tenantId);
  const read = readCourierSheet(mapped, {
    pattern,
    today: todayInJohannesburg(),
    typedSheetNo: input.prompts.courierSheetNo,
  });
  if (!read.ok) {
    throw new CourierError(read.code, read.error, 400, {
      template: templateRef(choice),
      ...(read.customers ? { customers: read.customers } : {}),
    });
  }

  const { sheet } = read;
  const [{ facts, contact }, existing] = await Promise.all([
    gatherFacts(tenantId, sheet.lines, sheet.customerName),
    scopedPrisma(tenantId).courierTripSheet.findFirst({
      where: { courierSheetNo: sheet.courierSheetNo },
      select: { id: true, status: true },
    }),
  ]);
  const issues = assessCourierSheet({
    lines: facts,
    contact: { found: !!contact, email: contact?.email?.trim() || null },
    readWarnings: sheet.warnings,
  });

  return {
    template: templateRef(choice),
    sheet,
    lines: sheet.lines.map((l, i) => ({ ...l, invoiceFile: facts[i].invoiceFile })),
    contact,
    issues,
    status: blocksHandover(issues) ? "NEEDS_ATTENTION" : "AWAITING_COLLECTION",
    duplicateOf: existing,
  };
}

/**
 * Import a courier trip sheet: the record first, in one transaction, then the
 * original file. A failed upload never costs the import — it is recorded on
 * the sheet with a Retry, and the bytes are held until then.
 *
 * `originalItemId`: the sheet was picked up from the courier folder, so its
 * original is already in OneDrive — no bytes are held, and filing it is a move.
 */
export async function importCourierSheet(
  tenantId: string,
  input: ReadInput,
  by: { id: string; name: string | null },
  { originalItemId }: { originalItemId?: string } = {}
): Promise<{ id: string; preview: CourierPreview }> {
  const preview = await previewCourierSheet(tenantId, input);
  if (preview.duplicateOf) {
    throw new CourierError(
      "DUPLICATE",
      `Courier trip sheet ${preview.sheet.courierSheetNo} has already been imported.`,
      409,
      { existingId: preview.duplicateOf.id }
    );
  }

  const db = scopedPrisma(tenantId);
  const pattern = await readInvoiceNoPattern(tenantId);
  const { sheet } = preview;

  // The registry is written before the sheet, as a deploy does, so a failure
  // here leaves no half-saved sheet.
  const invoiceIds = await ensureInvoices(
    tenantId,
    preview.lines.map((l) => ({ invoiceNo: l.invoiceNo, pdfFilename: l.invoiceFile, customerName: sheet.customerName })),
    pattern
  );

  const choice = await chooseTemplate(tenantId, "COURIER_TRIP_SHEET", input.buffer, input.filename, preview.template.id);

  let created;
  try {
    created = await db.$transaction(async (tx) => {
      const row = await tx.courierTripSheet.create({
        data: {
          courierSheetNo: sheet.courierSheetNo,
          sheetDate: new Date(`${sheet.sheetDate}T00:00:00Z`),
          courierCompany: sheet.courierCompany,
          courierService: sheet.courierService,
          courierContact: sheet.courierContact,
          customerName: sheet.customerName,
          contactId: preview.contact?.id ?? null,
          customerEmail: preview.contact?.email?.trim() || null,
          parcels: sheet.parcels,
          waybills: sheet.waybills,
          status: preview.status,
          issues: preview.issues as unknown as Prisma.InputJsonValue,
          checkedAt: new Date(),
          sourceFileName: input.filename,
          ...(originalItemId
            ? { sourceFileId: originalItemId }
            : { sourceFileBytes: new Uint8Array(input.buffer) }),
          importTemplateId: choice.ok ? choice.id : null,
          ...(choice.ok && templateSnapshot(choice) ? { mappingSnapshot: templateSnapshot(choice) } : {}),
          importedById: by.id,
          importedByName: by.name,
        },
        select: { id: true },
      });
      await tx.courierTripSheetInvoice.createMany({
        data: preview.lines.map((l) => ({
          courierSheetId: row.id,
          lineNo: l.lineNo,
          invoiceNo: l.invoiceNo,
          invoiceNoNormalized: l.invoiceNoNormalized,
          invoiceId: l.invoiceNoNormalized ? invoiceIds.get(l.invoiceNoNormalized) ?? null : null,
          invoiceFile: l.invoiceFile,
          invoiceDate: l.invoiceDate ? new Date(`${l.invoiceDate}T00:00:00Z`) : null,
          waybillNo: l.waybillNo,
          parcels: l.parcels,
        })),
      });
      return row;
    });
  } catch (err) {
    // Two imports of one sheet at the same moment: the unique key decides.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.courierTripSheet.findFirst({
        where: { courierSheetNo: sheet.courierSheetNo },
        select: { id: true },
      });
      throw new CourierError("DUPLICATE", `Courier trip sheet ${sheet.courierSheetNo} has already been imported.`, 409, {
        existingId: existing?.id,
      });
    }
    throw err;
  }

  await logAudit({
    action: "UPLOAD",
    entity: "courier_sheet",
    entityId: created.id,
    userName: by.name ?? undefined,
    details: `Imported courier trip sheet ${sheet.courierSheetNo} for ${sheet.customerName} (${sheet.lines.length} invoice${
      sheet.lines.length === 1 ? "" : "s"
    }) from ${input.filename}${preview.status === "NEEDS_ATTENTION" ? " — needs attention" : ""}`,
    tenantId,
  });

  await storeCourierOriginal(tenantId, created.id, by.name);
  return { id: created.id, preview };
}

// ─── The kept original ────────────────────────────────────────────────────

/**
 * File the sheet's original beneath the courier folder, in {YYYY}/{MM}/ —
 * OneDrive when connected (lib/courier-folder.ts), else beside the local trip
 * sheet folder. Never overwrites: a name already there gets _2, _3.
 *
 * Two kinds of original: bytes Signex holds (a manual upload — uploaded, then
 * cleared), or a file already in the courier folder (picked up from it —
 * moved, keeping its item id). Idempotent; on failure the reason is kept on
 * the sheet and the next try (Retry, or the folder's next look) finishes it.
 */
export async function storeCourierOriginal(
  tenantId: string,
  id: string,
  userName: string | null = null
): Promise<{ ok: boolean; error?: string }> {
  const db = scopedPrisma(tenantId);
  const row = await db.courierTripSheet.findFirst({
    where: { id },
    select: {
      courierSheetNo: true,
      customerName: true,
      sheetDate: true,
      sourceFileName: true,
      sourceFileBytes: true,
      sourceFileId: true,
      sourceFilePath: true,
    },
  });
  if (!row) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
  const inFolder = !row.sourceFileBytes && !!row.sourceFileId && !row.sourceFilePath;
  if (!row.sourceFileBytes && !inFolder) return { ok: true };

  const names = {
    courierSheetNo: row.courierSheetNo,
    customerName: row.customerName,
    sheetDate: row.sheetDate.toISOString().slice(0, 10),
    sourceFileName: row.sourceFileName,
  };
  const contentType = /\.xls$/i.test(row.sourceFileName)
    ? "application/vnd.ms-excel"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  try {
    let stored: { id: string | null; path: string } | null = null;
    const onedrive = await db.cloudAccount.findFirst({ where: { provider: "onedrive" }, select: { id: true } });

    if (onedrive) {
      const folder = await resolveCourierFolder(tenantId, { create: true });
      if (!folder) {
        throw new Error(
          "No Courier Trip Sheets folder: choose one in Settings → OneDrive, or a Trip Sheet folder for Signex to put it beside."
        );
      }
      const filed = await fileCourierOriginal(
        tenantId,
        folder,
        names,
        row.sourceFileBytes
          ? { upload: { bytes: Buffer.from(row.sourceFileBytes), contentType } }
          : { move: { itemId: row.sourceFileId! } }
      );
      stored = { id: filed.itemId, path: filed.path };
    } else {
      if (!row.sourceFileBytes) throw new Error("The original is in OneDrive, which is no longer connected.");
      const tripFolder = await getTripSheetFolderPath(tenantId);
      if (!tripFolder) {
        throw new Error("No trip sheet folder is set up, so there is nowhere beside it to keep the original. Set one in Settings.");
      }
      const dir = path.join(path.dirname(path.resolve(tripFolder)), ...originalFolder(names.sheetDate));
      fs.mkdirSync(dir, { recursive: true });
      const bytes = Buffer.from(row.sourceFileBytes);
      for (let attempt = 1; attempt <= 50 && !stored; attempt++) {
        const file = path.join(dir, originalFileName(row.courierSheetNo, row.customerName, row.sourceFileName, attempt));
        try {
          fs.writeFileSync(file, bytes, { flag: "wx" });
          stored = { id: null, path: file };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      if (!stored) throw new Error("Could not find a free file name for the original.");
    }

    await db.courierTripSheet.updateMany({
      where: { id },
      data: { sourceFileId: stored.id, sourceFilePath: stored.path, sourceFileBytes: null, sourceFileError: null },
    });
    await logAudit({
      action: "UPLOAD",
      entity: "courier_sheet",
      entityId: id,
      userName: userName ?? undefined,
      details: `Original sheet ${inFolder ? "filed" : "saved"} to ${stored.path}`,
      tenantId,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.courierTripSheet.updateMany({ where: { id }, data: { sourceFileError: message.slice(0, 500) } });
    return { ok: false, error: message };
  }
}

// ─── Re-checking and the office's fixes ───────────────────────────────────

/**
 * Check an open sheet again — after a PDF upload, a contact fix, a removed
 * invoice. Conditional on the sheet still being open, so a check finishing
 * after the courier signed cannot pull it back.
 */
export async function recheckCourierSheet(tenantId: string, id: string, userName: string | null = null) {
  const db = scopedPrisma(tenantId);
  const row = await db.courierTripSheet.findFirst({
    where: { id },
    select: {
      status: true,
      customerName: true,
      contactId: true,
      issues: true,
      invoices: { orderBy: { lineNo: "asc" }, select: { id: true, invoiceNo: true, invoiceNoNormalized: true, invoiceFile: true } },
    },
  });
  if (!row) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
  if (!OPEN.includes(row.status)) return { status: row.status, changed: false };

  const { facts, contact } = await gatherFacts(tenantId, row.invoices, row.customerName, {
    excludeSheetId: id,
    contactId: row.contactId,
  });
  const issues = assessCourierSheet({
    lines: facts,
    contact: { found: !!contact, email: contact?.email?.trim() || null },
    readWarnings: issuesOf(row.issues).filter((i) => READ_CODES.has(i.code)),
  });
  const status: CourierStatus = blocksHandover(issues) ? "NEEDS_ATTENTION" : "AWAITING_COLLECTION";

  // PDFs that turned up since: register them, and the lines point at them.
  const pattern = await readInvoiceNoPattern(tenantId);
  const found = row.invoices.map((inv, i) => ({ inv, file: facts[i].invoiceFile })).filter((x) => x.file && x.file !== x.inv.invoiceFile);
  const invoiceIds = found.length
    ? await ensureInvoices(
        tenantId,
        found.map((x) => ({ invoiceNo: x.inv.invoiceNo, pdfFilename: x.file, customerName: row.customerName })),
        pattern
      )
    : new Map<string, string>();

  const updated = await db.$transaction(async (tx) => {
    const claim = await tx.courierTripSheet.updateMany({
      where: { id, status: { in: OPEN } },
      data: {
        status,
        issues: issues as unknown as Prisma.InputJsonValue,
        checkedAt: new Date(),
        contactId: contact?.id ?? null,
        customerEmail: contact?.email?.trim() || null,
      },
    });
    if (claim.count === 1) {
      for (const { inv, file } of found) {
        await tx.courierTripSheetInvoice.updateMany({
          where: { id: inv.id },
          data: {
            invoiceFile: file,
            ...(inv.invoiceNoNormalized && invoiceIds.get(inv.invoiceNoNormalized)
              ? { invoiceId: invoiceIds.get(inv.invoiceNoNormalized) }
              : {}),
          },
        });
      }
    }
    return claim.count === 1;
  });

  if (updated && status !== row.status) {
    await logAudit({
      action: "STATUS_CHANGE",
      entity: "courier_sheet",
      entityId: id,
      userName: userName ?? undefined,
      details: status === "AWAITING_COLLECTION" ? "Ready for collection" : "Needs attention",
      tenantId,
    });
  }
  return { status, changed: updated };
}

async function openSheet(tenantId: string, id: string) {
  const row = await scopedPrisma(tenantId).courierTripSheet.findFirst({
    where: { id },
    select: { id: true, status: true, courierSheetNo: true },
  });
  if (!row) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
  if (!OPEN.includes(row.status)) {
    throw new CourierError("NOT_OPEN", "The courier has already signed for this sheet; it can no longer be changed.", 409);
  }
  return row;
}

/**
 * Link a contact by hand — the sheet's customer name did not match one. Also
 * allowed once COLLECTED, while the customer has not confirmed: the contact
 * is then only where the confirmation email goes (the caller sends it).
 */
export async function linkCourierContact(tenantId: string, id: string, contactId: string, userName: string | null) {
  const sheet = await scopedPrisma(tenantId).courierTripSheet.findFirst({ where: { id }, select: { status: true } });
  const collected = sheet?.status === "COLLECTED";
  if (!collected) await openSheet(tenantId, id);
  const contact = await scopedPrisma(tenantId).contact.findFirst({
    where: { id: contactId, deletedAt: null },
    select: { id: true, companyName: true, email: true },
  });
  // Another scope's contact is simply not found.
  if (!contact) throw new CourierError("NOT_FOUND", "Contact not found", 404);
  await scopedPrisma(tenantId).courierTripSheet.updateMany({
    where: { id, status: { in: collected ? ["COLLECTED"] : OPEN } },
    data: { contactId: contact.id, ...(collected ? { customerEmail: contact.email?.trim() || null } : {}) },
  });
  if (collected) {
    await logAudit({
      action: "CONFIG_UPDATE",
      entity: "courier_sheet",
      entityId: id,
      userName: userName ?? undefined,
      details: `Linked contact ${contact.companyName} for the confirmation email`,
      tenantId,
    });
    return { status: "COLLECTED" as CourierStatus, changed: true };
  }
  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "courier_sheet",
    entityId: id,
    userName: userName ?? undefined,
    details: `Linked contact ${contact.companyName}`,
    tenantId,
  });
  return recheckCourierSheet(tenantId, id, userName);
}

export interface CourierFields {
  courierCompany?: string | null;
  courierService?: string | null;
  courierContact?: string | null;
}

/** The courier's details, which the client's export does not carry. */
export async function updateCourierFields(tenantId: string, id: string, fields: CourierFields, userName: string | null) {
  await openSheet(tenantId, id);
  const clean = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 120) || null : null);
  const data: Record<string, string | null> = {};
  for (const key of ["courierCompany", "courierService", "courierContact"] as const) {
    if (key in fields) data[key] = clean(fields[key]);
  }
  if (Object.keys(data).length === 0) throw new CourierError("NOTHING_TO_CHANGE", "No changes sent.", 400);
  await scopedPrisma(tenantId).courierTripSheet.updateMany({ where: { id, status: { in: OPEN } }, data });
  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "courier_sheet",
    entityId: id,
    userName: userName ?? undefined,
    details: `Courier details: ${Object.entries(data).map(([k, v]) => `${k} = ${v ?? "—"}`).join(", ")}`,
    tenantId,
  });
}

/** Take one invoice off the sheet — the fix for a block that is a sheet mistake. */
export async function removeCourierInvoice(tenantId: string, id: string, lineId: string, userName: string | null) {
  await openSheet(tenantId, id);
  const db = scopedPrisma(tenantId);
  const lines = await db.courierTripSheetInvoice.findMany({
    where: { courierSheetId: id },
    select: { id: true, invoiceNo: true, waybillNo: true },
  });
  const line = lines.find((l) => l.id === lineId);
  if (!line) throw new CourierError("NOT_FOUND", "That invoice is not on this sheet", 404);
  if (lines.length === 1) {
    throw new CourierError("LAST_INVOICE", "This is the only invoice on the sheet — delete the sheet instead.", 409);
  }
  await db.courierTripSheetInvoice.deleteMany({ where: { id: lineId, courierSheetId: id } });
  const waybills = [...new Set(lines.filter((l) => l.id !== lineId).map((l) => l.waybillNo))];
  await db.courierTripSheet.updateMany({ where: { id, status: { in: OPEN } }, data: { waybills } });
  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "courier_sheet",
    entityId: id,
    userName: userName ?? undefined,
    details: `Removed invoice ${line.invoiceNo} from the sheet`,
    tenantId,
  });
  return recheckCourierSheet(tenantId, id, userName);
}

/** Delete an imported sheet that was a mistake. The kept original stays in its folder. */
export async function deleteCourierSheet(tenantId: string, id: string, userName: string | null) {
  const row = await openSheet(tenantId, id);
  const deleted = await scopedPrisma(tenantId).courierTripSheet.deleteMany({ where: { id, status: { in: OPEN } } });
  if (deleted.count !== 1) throw new CourierError("NOT_OPEN", "The sheet changed while it was being deleted.", 409);
  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "courier_sheet",
    entityId: id,
    userName: userName ?? undefined,
    details: `Deleted courier trip sheet ${row.courierSheetNo}`,
    tenantId,
  });
}

// ─── Reading ──────────────────────────────────────────────────────────────

export interface CourierSheetSummary {
  id: string;
  courierSheetNo: string;
  sheetDate: string;
  customerName: string;
  waybills: string[];
  invoiceCount: number;
  invoiceNos: string[];
  parcels: number | null;
  courierCompany: string | null;
  status: CourierStatus;
  blockCount: number;
  warningCount: number;
  hasEmail: boolean;
  /** After the handover: where it stands with the customer. */
  confirmation: ConfirmationState | null;
  createdAt: string;
}

/** The scope's courier trip sheets, newest first. */
export async function listCourierSheets(tenantId: string, limit = 500): Promise<CourierSheetSummary[]> {
  const rows = await scopedPrisma(tenantId).courierTripSheet.findMany({
    orderBy: [{ sheetDate: "desc" }, { createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      courierSheetNo: true,
      sheetDate: true,
      customerName: true,
      waybills: true,
      parcels: true,
      courierCompany: true,
      status: true,
      issues: true,
      customerEmail: true,
      filingCompletedAt: true,
      emailStatus: true,
      reminderSentAt: true,
      confirmedAt: true,
      createdAt: true,
      invoices: { orderBy: { lineNo: "asc" }, select: { invoiceNo: true } },
    },
  });
  return rows.map((r) => {
    const issues = issuesOf(r.issues);
    return {
      id: r.id,
      courierSheetNo: r.courierSheetNo,
      sheetDate: r.sheetDate.toISOString().slice(0, 10),
      customerName: r.customerName,
      waybills: r.waybills,
      invoiceCount: r.invoices.length,
      invoiceNos: r.invoices.map((i) => i.invoiceNo),
      parcels: r.parcels,
      courierCompany: r.courierCompany,
      status: r.status,
      blockCount: issues.filter((i) => i.level === "block").length,
      warningCount: issues.filter((i) => i.level === "warning").length,
      hasEmail: !!r.customerEmail,
      confirmation: confirmationState(r),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** One sheet, as the detail view shows it. Another scope's id is not found. */
export async function getCourierSheet(tenantId: string, id: string) {
  const row = await scopedPrisma(tenantId).courierTripSheet.findFirst({
    where: { id },
    select: {
      id: true,
      courierSheetNo: true,
      sheetDate: true,
      courierCompany: true,
      courierService: true,
      courierContact: true,
      customerName: true,
      customerEmail: true,
      parcels: true,
      waybills: true,
      status: true,
      issues: true,
      checkedAt: true,
      sourceFileName: true,
      sourceFileId: true,
      sourceFilePath: true,
      sourceFileError: true,
      importTemplateId: true,
      mappingSnapshot: true,
      importedByName: true,
      dispatcherName: true,
      dispatchCompany: true,
      courierDriverName: true,
      collectedAt: true,
      filingCompletedAt: true,
      filingError: true,
      driverSignature: true,
      // The customer's email and confirmation — never the link's token.
      emailStatus: true,
      emailSentAt: true,
      emailRecipient: true,
      emailError: true,
      reminderSentAt: true,
      confirmedAt: true,
      confirmTokenExpiresAt: true,
      createdAt: true,
      updatedAt: true,
      contact: { select: { id: true, companyName: true, email: true, contactPerson: true, phone: true } },
      invoices: {
        orderBy: { lineNo: "asc" },
        select: {
          id: true,
          lineNo: true,
          invoiceNo: true,
          invoiceFile: true,
          invoiceDate: true,
          waybillNo: true,
          parcels: true,
          invoiceId: true,
          signedAt: true,
          signedFileName: true,
        },
      },
    },
  });
  if (!row) return null;
  const snapshot = row.mappingSnapshot as { name?: string } | null;
  return {
    ...row,
    sheetDate: row.sheetDate.toISOString().slice(0, 10),
    issues: issuesOf(row.issues),
    /** Filed in its {YYYY}/{MM} folder — otherwise held, or still in the
     *  courier folder, for a retry (see sourceFileError). */
    originalSaved: !!row.sourceFilePath,
    readWith: snapshot?.name ?? "Built-in courier trip sheet layout",
    mappingSnapshot: undefined,
    // The image is not sent to the browser; whether it is still held is enough.
    driverSignature: undefined,
    signatureHeld: !!row.driverSignature,
    invoices: row.invoices.map((i) => ({ ...i, invoiceDate: i.invoiceDate?.toISOString().slice(0, 10) ?? null })),
  };
}

/** The original Excel, wherever it is: held bytes, OneDrive, or the local folder. */
export async function readCourierOriginal(
  tenantId: string,
  id: string
): Promise<{ filename: string; buffer: Buffer } | null> {
  const row = await scopedPrisma(tenantId).courierTripSheet.findFirst({
    where: { id },
    select: { sourceFileName: true, sourceFileBytes: true, sourceFileId: true, sourceFilePath: true },
  });
  if (!row) return null;
  if (row.sourceFileBytes) return { filename: row.sourceFileName, buffer: Buffer.from(row.sourceFileBytes) };
  if (row.sourceFileId) {
    return { filename: row.sourceFileName, buffer: await downloadFileById(tenantId, row.sourceFileId) };
  }
  if (row.sourceFilePath && fs.existsSync(row.sourceFilePath)) {
    return { filename: row.sourceFileName, buffer: fs.readFileSync(row.sourceFilePath) };
  }
  return null;
}
