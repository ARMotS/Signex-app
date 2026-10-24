import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import {
  deleteTemplate,
  findTemplate,
  readTemplateInput,
  saveTemplate,
  summarize,
  TemplateNameTaken,
} from "@/lib/sheet-templates";

type Ctx = { params: Promise<{ id: string }> };

// Every lookup is scoped: another ADMIN's template is not found, with the same
// 404 as an id that exists nowhere.
const notFound = () => NextResponse.json({ error: "Import template not found" }, { status: 404 });

export const GET = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const row = await findTemplate(ctx.tenantId, (await params).id);
  return row ? NextResponse.json(summarize(row)) : notFound();
});

/**
 * Replace a template. The body is merged over what is stored, so renaming or
 * making it the default needs no more than that field — but a change to where
 * the header row is needs the sample's header row again (`headers`), because
 * the stored fingerprint was taken from the old one.
 *
 * Trip sheets already read with this template keep the snapshot they were
 * read with; only later uploads see the change.
 */
export const PUT = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const { id } = await params;
  const row = await findTemplate(ctx.tenantId, id);
  if (!row) return notFound();

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  }

  const layoutMoved =
    ("headerRow" in body && body.headerRow !== row.headerRow) ||
    ("worksheet" in body && (body.worksheet || null) !== row.worksheet);
  if (layoutMoved && !Array.isArray(body.headers)) {
    return NextResponse.json(
      { error: "The header row moved — send the sample file's header row again." },
      { status: 400 }
    );
  }

  // The sheet type is part of what the template is; it does not change.
  const merged = {
    ...summarize(row),
    ...body,
    sheetType: row.sheetType,
    headers: Array.isArray(body.headers) ? body.headers : null,
  };
  const read = readTemplateInput({ ...merged, headers: merged.headers ?? [] });
  if (!read.ok) {
    return NextResponse.json({ error: read.errors[0], errors: read.errors }, { status: 400 });
  }

  const input = merged.headers
    ? read.input
    : // No new sample: keep the stored fingerprint.
      { ...read.input, headers: row.headerFingerprint.split("|") };

  try {
    const saved = await saveTemplate(ctx.tenantId, input, { id: ctx.userId, name: ctx.name ?? null }, id);
    if (!saved) return notFound();
    await logAudit({
      action: "CONFIG_UPDATE",
      entity: "import_template",
      entityId: id,
      userName: ctx.name,
      details: `Updated template "${saved.name}"${saved.isDefault ? " (default)" : ""}`,
      tenantId: ctx.tenantId,
    });
    return NextResponse.json(summarize(saved));
  } catch (err) {
    if (err instanceof TemplateNameTaken) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
});

export const DELETE = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const { id } = await params;
  const row = await findTemplate(ctx.tenantId, id);
  if (!row || !(await deleteTemplate(ctx.tenantId, id))) return notFound();

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "import_template",
    entityId: id,
    userName: ctx.name,
    details: `Deleted template "${row.name}"`,
    tenantId: ctx.tenantId,
  });
  return NextResponse.json({ success: true });
});
