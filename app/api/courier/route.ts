import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { readPrompts } from "@/lib/sheet-templates";
import { courierInboxState, scheduleCourierInbox } from "@/lib/courier-inbox";
import {
  CourierError,
  importCourierSheet,
  listCourierSheets,
  previewCourierSheet,
} from "@/lib/courier-import";

/**
 * Courier trip sheets. ADMIN only — never a DRIVER's: a courier sheet is
 * signed at the office by the courier's own driver, who has no account.
 * See lib/courier-import.ts.
 */

/** Reading a sheet lists the invoice folder — see the note in ../trip-sheet/route.ts. */
export const maxDuration = 60;

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  // This tab polls, so it carries the look at the courier folder (throttled
  // per scope, after the response — see lib/courier-inbox.ts).
  scheduleCourierInbox(ctx.tenantId);
  const [sheets, inbox] = await Promise.all([listCourierSheets(ctx.tenantId), courierInboxState(ctx.tenantId)]);
  return NextResponse.json({ sheets, inbox });
});

/**
 * multipart: file, action ("preview" | "import"), templateId (the preview's,
 * sent back with the import), prompts (JSON — e.g. the courier company, or a
 * sheet number the file name does not carry).
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const form = await request.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  const input = {
    buffer: Buffer.from(await file.arrayBuffer()),
    filename: file.name,
    templateId: (form.get("templateId") as string | null) || null,
    prompts: readPrompts(form.get("prompts")),
  };

  try {
    if (form.get("action") === "import") {
      const { id, preview } = await importCourierSheet(ctx.tenantId, input, { id: ctx.userId, name: ctx.name ?? null });
      return NextResponse.json({ success: true, id, status: preview.status }, { status: 201 });
    }
    return NextResponse.json({ success: true, preview: await previewCourierSheet(ctx.tenantId, input) });
  } catch (err) {
    if (err instanceof CourierError) {
      return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
    }
    throw err;
  }
});
