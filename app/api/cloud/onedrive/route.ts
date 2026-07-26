import { NextResponse } from "next/server";
import { getCloudAccountStatus, disconnectCloudAccount } from "@/lib/microsoft-graph";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/cloud/onedrive
 * Returns the current OneDrive connection status.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  // This scope's own connection. An ADMIN without one sees "not connected" even
  // when other ADMINs have connected drives.
  const status = await getCloudAccountStatus(ctx.tenantId);
  return NextResponse.json({ connected: !!status, account: status });
});

/**
 * DELETE /api/cloud/onedrive
 * Disconnects the OneDrive account.
 */
export const DELETE = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  await disconnectCloudAccount(ctx.tenantId);
  return NextResponse.json({ success: true });
});
