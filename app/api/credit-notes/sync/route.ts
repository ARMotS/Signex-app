import { NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { syncCreditsFolder } from "@/lib/credit-intake";
import { retryPendingFilings } from "@/lib/credit-signoff";

/**
 * POST /api/credit-notes/sync — "Check folder": look at the credits folder now
 * rather than waiting for the page's next automatic look. Still claimed (with a
 * short lease), so pressing it on two screens at once lists the folder once.
 */
export const POST = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);

  const result = await syncCreditsFolder(ctx.tenantId, { minIntervalMs: 5_000, by: ctx.name });
  switch (result.outcome) {
    case "not_configured":
      return NextResponse.json({ error: "Choose a credits folder in Settings → OneDrive first." }, { status: 409 });
    case "error":
      return NextResponse.json({ error: `The credits folder could not be read: ${result.error}` }, { status: 502 });
    default: {
      // Signed notes whose filing did not finish get another go too.
      const refiled = result.outcome === "checked" ? await retryPendingFilings(ctx.tenantId) : 0;
      return NextResponse.json({ success: true, ...result, refiled });
    }
  }
});
