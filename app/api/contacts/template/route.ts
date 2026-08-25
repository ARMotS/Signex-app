import { NextResponse } from "next/server";
import {
  buildContactsTemplate,
  CONTACTS_TEMPLATE_FILENAME,
} from "@/lib/import-templates";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * The blank contacts workbook. It carries no tenant data — the gate is here
 * because the template describes how the import behaves, not because the bytes
 * are sensitive.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const buffer = buildContactsTemplate();

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${CONTACTS_TEMPLATE_FILENAME}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
});
