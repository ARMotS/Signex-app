import { NextRequest, NextResponse } from "next/server";
import { getSessionContext } from "@/lib/tenant";
import { getSession, hashSessionToken } from "@/lib/session";
import { withAuth } from "@/lib/api-handler";
import { DEVICE_HISTORY_DAYS, devicesOf, visibleAccounts, type AccountDevices } from "@/lib/devices";

const SIZES = [10, 25, 50];

/**
 * GET /api/devices?q&branch&all&page&size — the devices of every account the
 * caller may see (lib/devices.ts: own; + drivers for a branch ADMIN; +
 * allocated admins and their drivers for a COMPANY_ADMIN; everyone for the
 * SUPER_ADMIN), paged by account. By default only accounts with a device
 * signed in now or in the last 30 days; `all=1` lists the rest too. The IP
 * address is included for the SUPER_ADMIN only. Works from any scope.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  const params = new URL(request.url).searchParams;
  const session = await getSession();
  const accounts = await visibleAccounts(ctx);

  const q = (params.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const branch = params.get("branch") ?? "";
  const matching = accounts.filter(
    (a) =>
      (!branch || a.branchTenantId === branch) &&
      (!q || [a.name, a.username ?? "", a.branch ?? "", a.companyName ?? ""].some((v) => v.toLowerCase().includes(q)))
  );

  const withIp = ctx.role === "SUPER_ADMIN";
  const all = await devicesOf(matching, {
    currentTokenHash: session ? hashSessionToken(session.sessionToken) : null,
    withIp,
  });
  const shown = params.get("all") === "1" ? all : all.filter((a) => a.isSelf || a.devices.length > 0 || a.recent.length > 0);
  const lastSeen = (a: AccountDevices) => Math.max(0, ...[...a.devices, ...a.recent].map((s) => new Date(s.lastSeenAt).getTime()));
  shown.sort(
    (a, b) => Number(b.isSelf) - Number(a.isSelf) || b.liveCount - a.liveCount || lastSeen(b) - lastSeen(a) || a.name.localeCompare(b.name)
  );

  const sizeAsked = Number.parseInt(params.get("size") ?? "", 10);
  const size = SIZES.includes(sizeAsked) ? sizeAsked : 25;
  const pages = Math.max(1, Math.ceil(shown.length / size));
  const pageAsked = Number.parseInt(params.get("page") ?? "", 10);
  const page = Math.min(Math.max(1, pageAsked || 1), pages);

  const branches = new Map<string, string>();
  for (const a of accounts) if (a.branchTenantId && a.branch) branches.set(a.branchTenantId, a.branch);

  return NextResponse.json({
    accounts: shown.slice((page - 1) * size, page * size),
    total: shown.length,
    page,
    size,
    signedInNow: all.reduce((n, a) => n + a.liveCount, 0),
    branches: [...branches].map(([tenantId, name]) => ({ tenantId, name })).sort((a, b) => a.name.localeCompare(b.name)),
    withIp,
    historyDays: DEVICE_HISTORY_DAYS,
  });
});
