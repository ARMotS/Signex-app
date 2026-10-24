import { NextResponse } from "next/server";
import { getCloudSyncRoots } from "@/lib/cloud-detect";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);

  const roots = getCloudSyncRoots();
  return NextResponse.json({ roots });
});
