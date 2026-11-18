import { NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { navBadges } from "@/lib/nav-badges";

/**
 * The Courier nav badge for tabs on an old bundle (the badge now rides on
 * /api/sync): courier sheets not yet signed for. ADMIN only, scoped.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { courier } = await navBadges(ctx.tenantId);
  return NextResponse.json({ attention: courier });
});
