import { NextResponse } from "next/server";
import { getCloudSyncRoots } from "@/lib/cloud-detect";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const roots = getCloudSyncRoots();
  return NextResponse.json({ roots });
});
