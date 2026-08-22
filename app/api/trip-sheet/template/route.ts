import { NextResponse } from "next/server";
import {
  buildTripSheetTemplate,
  TRIP_SHEET_TEMPLATE_FILENAME,
} from "@/lib/import-templates";
import { listDrivers } from "@/lib/accounts";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * The blank trip sheet workbook, with this ADMIN's own active driver names on
 * the reference tab. Driver names are scope-local (two ADMINs may each employ a
 * John Smith), so the list comes from `ctx.tenantId` and never from a parameter.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const drivers = await listDrivers(ctx.tenantId);
  const buffer = buildTripSheetTemplate(
    drivers.filter((d) => d.active).map((d) => d.name)
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${TRIP_SHEET_TEMPLATE_FILENAME}"`,
      "Content-Length": String(buffer.length),
      // The driver list changes when drivers do; a cached copy would hand out
      // stale names, which is exactly the mistake the tab exists to prevent.
      "Cache-Control": "no-store",
    },
  });
});
