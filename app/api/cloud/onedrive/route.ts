import { NextResponse } from "next/server";
import { getCloudAccountStatus, disconnectCloudAccount } from "@/lib/microsoft-graph";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/cloud/onedrive
 * Returns the current OneDrive connection status.
 */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const status = await getCloudAccountStatus();
  return NextResponse.json({ connected: !!status, account: status });
});

/**
 * DELETE /api/cloud/onedrive
 * Disconnects the OneDrive account.
 */
export const DELETE = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  await disconnectCloudAccount();
  return NextResponse.json({ success: true });
});
