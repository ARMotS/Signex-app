import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { checkCourierInbox, courierInboxState } from "@/lib/courier-inbox";
import { resolveCourierFolder } from "@/lib/courier-folder";

/** A look reads and imports up to ten sheets, each listing the invoice folder. */
export const maxDuration = 60;

/**
 * The courier folder (lib/courier-inbox.ts). ADMIN only.
 *   { action: "check" }        — "Check folder": look now, failures included
 *   { action: "createFolder" } — make the folder beside the trip sheet folder,
 *                                so the Trip application can be pointed at it
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const body = await request.json().catch(() => ({}));

  if (body?.action === "createFolder") {
    try {
      const folder = await resolveCourierFolder(ctx.tenantId, { create: true });
      if (!folder) {
        return NextResponse.json(
          { error: "Connect OneDrive and choose a Trip Sheet folder first — the courier folder goes beside it." },
          { status: 400 }
        );
      }
      return NextResponse.json({ folderPath: folder.path, inbox: await courierInboxState(ctx.tenantId) });
    } catch (err) {
      return NextResponse.json(
        { error: `Could not create the folder: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  const result = await checkCourierInbox(ctx.tenantId, { force: true });
  return NextResponse.json({ result, inbox: await courierInboxState(ctx.tenantId) });
});
