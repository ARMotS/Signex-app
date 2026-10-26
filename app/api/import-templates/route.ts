import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { SHEET_TYPES, type ImportSheetType } from "@/lib/import-fields";
import {
  builtInLayout,
  BUILT_IN_ID,
  listTemplates,
  readTemplateInput,
  saveTemplate,
  summarize,
  TemplateNameTaken,
} from "@/lib/sheet-templates";

/**
 * This scope's import templates (saved column mappings), and the built-in
 * layouts beside them so the office can see what an upload falls back to.
 * See lib/sheet-templates.ts.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const raw = new URL(request.url).searchParams.get("sheetType");
  const sheetType = raw && raw in SHEET_TYPES ? (raw as ImportSheetType) : undefined;

  const builtIn = (Object.keys(SHEET_TYPES) as ImportSheetType[])
    .filter((type) => !sheetType || type === sheetType)
    .flatMap((type) => {
      const layout = builtInLayout(type);
      return layout ? [{ id: BUILT_IN_ID, sheetType: type, name: layout.name }] : [];
    });

  return NextResponse.json({
    templates: await listTemplates(ctx.tenantId, sheetType),
    builtIn,
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const read = readTemplateInput(await request.json().catch(() => null));
  if (!read.ok) {
    return NextResponse.json({ error: read.errors[0], errors: read.errors }, { status: 400 });
  }

  try {
    const saved = await saveTemplate(ctx.tenantId, read.input, { id: ctx.userId, name: ctx.name ?? null });
    await logAudit({
      action: "CONFIG_UPDATE",
      entity: "import_template",
      entityId: saved!.id,
      userName: ctx.name,
      details: `Created ${SHEET_TYPES[read.input.sheetType].label.toLowerCase()} template "${read.input.name}"${read.input.isDefault ? " (default)" : ""}`,
      tenantId: ctx.tenantId,
    });
    return NextResponse.json(summarize(saved!), { status: 201 });
  } catch (err) {
    if (err instanceof TemplateNameTaken) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});
