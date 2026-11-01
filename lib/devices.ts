/**
 * The devices page: which devices each account is signed in on, and signing
 * one out from somewhere else.
 *
 * Who sees whom runs down the chain (client decision, 2026-11-01): everyone
 * sees their own devices; a branch ADMIN also its branch's drivers; a
 * COMPANY_ADMIN also the branch admins allocated to it and their branches'
 * drivers; the SUPER_ADMIN everyone. The list of accounts a caller may see is
 * worked out here, from the session, on every call — a sign-out is allowed
 * only for a session whose account is in that list, and anything else is not
 * found (404), the same answer as an id that does not exist.
 *
 * UserSession carries no tenantId, so its rows are read by account id; every
 * id comes from the caller's own scope, allocations, or (SUPER_ADMIN) the
 * account registry. The IP address is the SUPER_ADMIN's alone.
 */

import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { hashSessionToken, SESSION_LIMITS, type SessionRole } from "./session";
import type { SessionContext } from "./tenant";
import { AuthError } from "./tenant";
import { deviceLabel } from "./device-label";

/** How far back "Recently signed out" goes. */
export const DEVICE_HISTORY_DAYS = 30;

export type AccountKind = "admin" | "driver";

export interface DeviceAccount {
  kind: AccountKind;
  id: string;
  name: string;
  username: string | null;
  /** The role as the session store knows it — sets the device limit. */
  role: SessionRole;
  branchTenantId: string | null;
  branch: string | null;
  companyName: string | null;
  isSelf: boolean;
}

export interface DeviceSession {
  id: string;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  signedInAt: Date;
  lastSeenAt: Date;
  /** Signed in right now. */
  live: boolean;
  endedAt: Date | null;
  /** logout | evicted | replaced | password_reset | deactivated | role_change | signed_out_remotely | expired */
  endedReason: string | null;
  /** The device this page is being looked at on. */
  isCurrent: boolean;
  /** SUPER_ADMIN only — absent for everyone else. */
  ipAddress?: string | null;
}

export class DeviceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
  }
}

type Caller = Pick<SessionContext, "role" | "userId" | "homeTenantId">;

const LOGIN = { select: { username: true } } as const;

/** Which ADMIN-table accounts are ADMIN by role (role lives on User, by email). */
async function rolesByEmail(emails: string[]) {
  if (emails.length === 0) return new Map<string, string>();
  // SCOPE-EXEMPT: the User role registry, read by email for accounts already
  // reached through the caller's own scope or allocations.
  const users = await UNSAFE_unscopedPrisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true, role: true },
  });
  return new Map(users.map((u) => [u.email.toLowerCase(), u.role as string]));
}

const SESSION_ROLE: Record<string, SessionRole> = {
  ADMIN: "admin",
  SUPER_ADMIN: "super_admin",
  COMPANY_ADMIN: "company_admin",
};

/** The drivers of one branch, read through that branch's own scope. */
async function driversOf(branchTenantId: string, branch: string, companyName: string | null): Promise<DeviceAccount[]> {
  const drivers = await scopedPrisma(branchTenantId).driver.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, login: LOGIN },
  });
  return drivers.map((d) => ({
    kind: "driver" as const,
    id: d.id,
    name: d.name,
    username: d.login?.username ?? null,
    role: "driver" as const,
    branchTenantId,
    branch,
    companyName,
    isSelf: false,
  }));
}

/** The caller's own account. */
async function self(ctx: Caller): Promise<DeviceAccount> {
  // SCOPE-EXEMPT: the caller's own account row, by its session id.
  const me = await UNSAFE_unscopedPrisma.admin.findUnique({
    where: { id: ctx.userId },
    select: { id: true, name: true, login: LOGIN, tenant: { select: { id: true, name: true, companyName: true, kind: true } } },
  });
  if (!me) throw new AuthError("Unauthenticated", 401);
  const isBranch = me.tenant.kind === "BRANCH";
  return {
    kind: "admin",
    id: me.id,
    name: me.name,
    username: me.login?.username ?? null,
    role: SESSION_ROLE[ctx.role] ?? "admin",
    branchTenantId: isBranch ? me.tenant.id : null,
    branch: isBranch ? me.tenant.companyName || me.tenant.name : null,
    companyName: null,
    isSelf: true,
  };
}

/**
 * Every account this caller may see devices for, self first. Drivers (and any
 * other role) are refused: the page is the office's.
 */
export async function visibleAccounts(ctx: Caller): Promise<DeviceAccount[]> {
  if (ctx.role === "DRIVER") throw new AuthError("Forbidden", 403);
  const me = await self(ctx);

  if (ctx.role === "ADMIN") {
    return [me, ...(me.branchTenantId ? await driversOf(me.branchTenantId, me.branch!, null) : [])];
  }

  if (ctx.role === "COMPANY_ADMIN") {
    // SCOPE-EXEMPT: the allocation registry, by the session's own account id.
    const rows = await UNSAFE_unscopedPrisma.companyAdminAllocation.findMany({
      where: { companyAdminId: ctx.userId, company: { isActive: true } },
      select: {
        branch: { select: { id: true, name: true, companyName: true } },
        company: { select: { name: true } },
        admin: { select: { id: true, name: true, email: true, login: LOGIN } },
      },
    });
    const roles = await rolesByEmail(rows.map((r) => r.admin.email));
    const admins = rows.filter((r) => (roles.get(r.admin.email.toLowerCase()) ?? "ADMIN") === "ADMIN");
    const branches = new Map(admins.map((r) => [r.branch.id, { name: r.branch.companyName || r.branch.name, company: r.company.name }]));
    const drivers = await Promise.all([...branches].map(([id, b]) => driversOf(id, b.name, b.company)));
    return [
      { ...me, companyName: rows[0]?.company.name ?? null },
      ...admins.map((r) => ({
        kind: "admin" as const,
        id: r.admin.id,
        name: r.admin.name,
        username: r.admin.login?.username ?? null,
        role: "admin" as const,
        branchTenantId: r.branch.id,
        branch: r.branch.companyName || r.branch.name,
        companyName: r.company.name,
        isSelf: false,
      })),
      ...drivers.flat(),
    ];
  }

  if (ctx.role === "SUPER_ADMIN") {
    // SCOPE-EXEMPT: the account registry, SUPER_ADMIN only.
    const [admins, drivers] = await Promise.all([
      UNSAFE_unscopedPrisma.admin.findMany({
        where: { NOT: { id: ctx.userId } },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          login: LOGIN,
          tenant: { select: { id: true, name: true, companyName: true, kind: true, company: { select: { name: true } } } },
          company: { select: { name: true } },
        },
      }),
      UNSAFE_unscopedPrisma.driver.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          login: LOGIN,
          tenant: { select: { id: true, name: true, companyName: true, company: { select: { name: true } } } },
        },
      }),
    ]);
    const roles = await rolesByEmail(admins.map((a) => a.email));
    return [
      me,
      ...admins.map((a) => ({
        kind: "admin" as const,
        id: a.id,
        name: a.name,
        username: a.login?.username ?? null,
        role: (a.company ? "company_admin" : SESSION_ROLE[roles.get(a.email.toLowerCase()) ?? "ADMIN"]) ?? "admin",
        branchTenantId: a.tenant.kind === "BRANCH" ? a.tenant.id : null,
        branch: a.tenant.kind === "BRANCH" ? a.tenant.companyName || a.tenant.name : null,
        companyName: a.company?.name ?? a.tenant.company?.name ?? null,
        isSelf: false,
      })),
      ...drivers.map((d) => ({
        kind: "driver" as const,
        id: d.id,
        name: d.name,
        username: d.login?.username ?? null,
        role: "driver" as const,
        branchTenantId: d.tenant.id,
        branch: d.tenant.companyName || d.tenant.name,
        companyName: d.tenant.company?.name ?? null,
        isSelf: false,
      })),
    ];
  }

  throw new AuthError("Forbidden", 403);
}

export interface AccountDevices extends DeviceAccount {
  limit: number;
  liveCount: number;
  devices: DeviceSession[];
  /** Signed out (or expired) in the last DEVICE_HISTORY_DAYS. */
  recent: DeviceSession[];
}

/**
 * The devices of the given accounts: signed in now, and ended in the last
 * DEVICE_HISTORY_DAYS. `currentTokenHash` marks the device this page is open
 * on; `withIp` (SUPER_ADMIN) adds the IP address.
 */
export async function devicesOf(
  accounts: DeviceAccount[],
  opts: { currentTokenHash: string | null; withIp: boolean; now?: Date }
): Promise<AccountDevices[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - DEVICE_HISTORY_DAYS * 86_400_000);
  const adminIds = accounts.filter((a) => a.kind === "admin").map((a) => a.id);
  const driverIds = accounts.filter((a) => a.kind === "driver").map((a) => a.id);
  if (adminIds.length + driverIds.length === 0) return [];

  // SCOPE-EXEMPT: UserSession has no tenantId; read only for the account ids
  // this caller may see (visibleAccounts).
  const rows = await UNSAFE_unscopedPrisma.userSession.findMany({
    where: {
      OR: [{ adminId: { in: adminIds } }, { driverId: { in: driverIds } }],
      AND: [
        {
          OR: [
            { revokedAt: null, expiresAt: { gt: since } },
            { revokedAt: { gte: since } },
          ],
        },
      ],
    },
    orderBy: { lastSeenAt: "desc" },
    take: 5000,
    select: {
      id: true,
      adminId: true,
      driverId: true,
      tokenHash: true,
      browser: true,
      os: true,
      deviceType: true,
      ipAddress: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });

  const byOwner = new Map<string, DeviceSession[]>();
  for (const r of rows) {
    const live = r.revokedAt === null && r.expiresAt > now;
    const session: DeviceSession = {
      id: r.id,
      browser: r.browser,
      os: r.os,
      deviceType: r.deviceType,
      signedInAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      live,
      endedAt: live ? null : r.revokedAt ?? r.expiresAt,
      endedReason: live ? null : r.revokedReason ?? "expired",
      isCurrent: live && opts.currentTokenHash !== null && r.tokenHash === opts.currentTokenHash,
      ...(opts.withIp && { ipAddress: r.ipAddress }),
    };
    const key = (r.adminId ?? r.driverId)!;
    byOwner.set(key, [...(byOwner.get(key) ?? []), session]);
  }

  return accounts.map((a) => {
    const all = byOwner.get(a.id) ?? [];
    const devices = all.filter((s) => s.live);
    return {
      ...a,
      limit: SESSION_LIMITS[a.role],
      liveCount: devices.length,
      devices,
      recent: all.filter((s) => !s.live).sort((x, y) => y.endedAt!.getTime() - x.endedAt!.getTime()),
    };
  });
}

/**
 * Sign one device out, for an account the caller may see. Not the caller's
 * own current device (that is Log out). Idempotent: a device already signed
 * out stays so. The session's token is cleared from the legacy columns too,
 * so a rollback to the previous deploy cannot revive it.
 */
export async function signOutDevice(
  ctx: Caller & { name: string },
  sessionId: unknown,
  currentTokenHash: string | null
): Promise<{ alreadyEnded: boolean }> {
  if (typeof sessionId !== "string" || !sessionId) throw new DeviceError("NOT_FOUND", "Not found", 404);
  // SCOPE-EXEMPT: one session row by id; it is acted on only if its account
  // is one this caller may see (below).
  const row = await UNSAFE_unscopedPrisma.userSession.findUnique({
    where: { id: sessionId },
    select: { id: true, adminId: true, driverId: true, tokenHash: true, revokedAt: true, expiresAt: true, browser: true, os: true, deviceType: true },
  });
  if (!row) throw new DeviceError("NOT_FOUND", "Not found", 404);

  const accounts = await visibleAccounts(ctx);
  const owner = accounts.find((a) =>
    a.kind === "admin" ? row.adminId !== null && a.id === row.adminId : row.driverId !== null && a.id === row.driverId
  );
  if (!owner) throw new DeviceError("NOT_FOUND", "Not found", 404);
  if (currentTokenHash && row.tokenHash === currentTokenHash) {
    throw new DeviceError("CURRENT_DEVICE", "This is the device you are using — use Log out instead.", 400);
  }

  // Conditional: two people pressing at once sign it out once.
  const ended = await UNSAFE_unscopedPrisma.userSession.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "signed_out_remotely" },
  });
  if (ended.count === 0) return { alreadyEnded: true };

  await clearLegacyToken(owner, row.tokenHash);

  const device = deviceLabel(row);
  await logAudit({
    action: "LOGOUT",
    entity: owner.kind,
    entityId: owner.id,
    userName: owner.name,
    details: owner.isSelf ? `Signed out ${device} from another device` : `Signed out ${device} — by ${ctx.name}`,
    metadata: { remote: true, sessionId: row.id, by: ctx.userId },
    tenantId: owner.branchTenantId ?? ctx.homeTenantId,
  });
  return { alreadyEnded: false };
}

/**
 * The rollout still writes live tokens to Admin.sessionTokens /
 * Admin.sessionToken / Driver.sessionToken (expand/contract), and the previous
 * deploy validates against them. Remove the one whose hash is this session's.
 */
async function clearLegacyToken(owner: DeviceAccount, tokenHash: string) {
  // SCOPE-EXEMPT: the owner's own row, already proven visible to the caller.
  const db = UNSAFE_unscopedPrisma;
  if (owner.kind === "driver") {
    const d = await db.driver.findUnique({ where: { id: owner.id }, select: { sessionToken: true } });
    if (d?.sessionToken && hashSessionToken(d.sessionToken) === tokenHash) {
      await db.driver.updateMany({ where: { id: owner.id, sessionToken: d.sessionToken }, data: { sessionToken: null } });
    }
    return;
  }
  const a = await db.admin.findUnique({ where: { id: owner.id }, select: { sessionToken: true, sessionTokens: true } });
  if (!a) return;
  const match = [...a.sessionTokens, a.sessionToken].find((t) => t && hashSessionToken(t) === tokenHash);
  if (!match) return;
  await db.$executeRaw`
    UPDATE "Admin"
    SET "sessionTokens" = array_remove("sessionTokens", ${match}),
        "sessionToken" = NULLIF("sessionToken", ${match})
    WHERE "id" = ${owner.id}`;
}
