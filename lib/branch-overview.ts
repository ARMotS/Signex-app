/**
 * Looking across branches: the COMPANY_ADMIN's "All my branches" (overview +
 * activity) and the usage page (COMPANY_ADMIN for its branches, SUPER_ADMIN
 * for every branch).
 *
 * Fan-out, never a mixed query: the branch list comes from the registry (the
 * caller's own allocations, or the Tenant registry for the SUPER_ADMIN), and
 * every figure is then read through scopedPrisma(branch) — one branch at a
 * time — and merged here. A scoping slip can therefore only ever show a
 * branch the caller was already entitled to.
 *
 * Read-only, and nothing here shows the SUPER_ADMIN to a COMPANY_ADMIN: its
 * audit entries are left out of the activity feed, and only ADMIN and DRIVER
 * accounts are listed in usage. No IP, user agent or device id leaves this
 * module — device detail is the devices page's.
 */

import type { AuditAction, Prisma } from "@prisma/client";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import { listAllocatedBranches } from "./company";
import { courierOverview } from "./courier-confirm";
import { outstandingEmailWhere } from "./email-queue";
import { AuthError, type SessionContext } from "./tenant";

export interface BranchRef {
  tenantId: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
}

/**
 * The branches this caller may look across. COMPANY_ADMIN: its allocated
 * branches (company active) — checked on every call, so a removed allocation
 * drops the branch at once. SUPER_ADMIN: every BRANCH scope. Anyone else: 403.
 */
export async function branchesVisibleTo(ctx: Pick<SessionContext, "role" | "userId">): Promise<BranchRef[]> {
  if (ctx.role === "COMPANY_ADMIN") {
    const branches = await listAllocatedBranches(ctx.userId);
    // SCOPE-EXEMPT: the caller's own company, by its own account id.
    const own = await UNSAFE_unscopedPrisma.admin.findUnique({
      where: { id: ctx.userId },
      select: { company: { select: { id: true, name: true } } },
    });
    return branches.map((b) => ({
      tenantId: b.tenantId,
      name: b.companyName || b.name,
      companyId: own?.company?.id ?? null,
      companyName: own?.company?.name ?? null,
    }));
  }
  if (ctx.role === "SUPER_ADMIN") {
    // SCOPE-EXEMPT: the Tenant registry, SUPER_ADMIN only.
    const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
      where: { kind: "BRANCH" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, companyName: true, company: { select: { id: true, name: true } } },
    });
    return tenants.map((t) => ({
      tenantId: t.id,
      name: t.companyName || t.name,
      companyId: t.company?.id ?? null,
      companyName: t.company?.name ?? null,
    }));
  }
  throw new AuthError("Forbidden", 403);
}

// ─── Overview: today's numbers, one card per branch ───────────────────────

export interface BranchSummary {
  tenantId: string;
  name: string;
  deliveredToday: number;
  remainingStops: number;
  activeSheets: number;
  driversOnRoad: number;
  closedOutToday: number;
  emailsToFix: number;
  courierAttention: number;
  collectionsPending: number;
  awaitingApproval: number;
  creditNotesToReview: number;
  creditNotesToSign: number;
}

export async function branchSummary(branch: BranchRef, day: { start: Date; end: Date }, now = new Date()): Promise<BranchSummary> {
  const db = scopedPrisma(branch.tenantId);
  const today = { gte: day.start, lt: day.end };
  const [signedLive, closed, remaining, activeSheets, onRoad, emails, pending, approval, review, toSign, courier] =
    await Promise.all([
      db.stop.count({ where: { status: "SIGNED", signedAt: today } }),
      db.completedTripSheet.aggregate({ where: { completedAt: today }, _sum: { signedStops: true }, _count: { _all: true } }),
      db.stop.count({ where: { status: { in: ["PENDING", "IN_PROGRESS"] } } }),
      db.tripSheet.count({ where: { status: "ACTIVE" } }),
      db.tripSheet.findMany({
        where: { status: "ACTIVE", stops: { some: { status: { not: "SIGNED" } } } },
        distinct: ["driverId"],
        select: { driverId: true },
      }),
      db.stop.count({ where: outstandingEmailWhere(now) }),
      db.collection.count({ where: { status: "PENDING", tripSheetId: { not: null } } }),
      // awaitingCreditReview (lib/collection-confirm.ts), as a query.
      db.collection.count({
        where: {
          type: "CREDIT_RETURN",
          originalInvoiceNo: { not: null },
          status: { in: ["COLLECTED", "PARTIAL"] },
          creditReview: null,
        },
      }),
      db.creditNote.count({ where: { status: "NEEDS_REVIEW" } }),
      db.creditNote.count({ where: { status: "RECEIVED" } }),
      courierOverview(branch.tenantId, day.start, now),
    ]);
  return {
    tenantId: branch.tenantId,
    name: branch.name,
    // Signed on live sheets today, plus everything already closed out today.
    deliveredToday: signedLive + (closed._sum.signedStops ?? 0),
    remainingStops: remaining,
    activeSheets,
    driversOnRoad: onRoad.length,
    closedOutToday: closed._count._all,
    emailsToFix: emails,
    courierAttention: courier.attention,
    collectionsPending: pending,
    awaitingApproval: approval,
    creditNotesToReview: review,
    creditNotesToSign: toSign,
  };
}

// ─── Activity: the branches' audit logs, merged ───────────────────────────

/** What a company admin's activity feed may show of an entry. */
export interface ActivityEntry {
  id: string;
  createdAt: Date;
  tenantId: string;
  branch: string;
  action: AuditAction;
  entity: string;
  details: string | null;
  userName: string | null;
  actorRole: string | null;
}

/** Deep enough for a working week of a busy branch; past it, narrow the dates. */
export const ACTIVITY_MAX_OFFSET = 2000;

/** Entries the SUPER_ADMIN made never reach a company admin (nulls kept: system work). */
const NOT_SUPER_ADMIN: Prisma.AuditLogWhereInput = {
  OR: [{ actorRole: null }, { actorRole: { not: "SUPER_ADMIN" } }],
};

export async function branchActivity(
  branches: BranchRef[],
  q: { action?: AuditAction; from?: Date; to?: Date; page: number; size: number }
): Promise<{ entries: ActivityEntry[]; total: number; page: number; capped: boolean }> {
  const where: Prisma.AuditLogWhereInput = {
    ...NOT_SUPER_ADMIN,
    ...(q.action && { action: q.action }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
  };
  const counts = await Promise.all(branches.map((b) => scopedPrisma(b.tenantId).auditLog.count({ where })));
  const total = counts.reduce((a, b) => a + b, 0);
  const pages = Math.max(1, Math.ceil(total / q.size));
  const page = Math.min(Math.max(1, q.page), pages);
  const offset = (page - 1) * q.size;
  const capped = offset > ACTIVITY_MAX_OFFSET;
  if (capped) return { entries: [], total, page, capped };

  // The newest offset+size of each branch hold the newest offset+size overall.
  const perBranch = await Promise.all(
    branches.map(async (b, i) =>
      counts[i] === 0
        ? []
        : (
            await scopedPrisma(b.tenantId).auditLog.findMany({
              where,
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: offset + q.size,
              select: { id: true, createdAt: true, action: true, entity: true, details: true, userName: true, actorRole: true },
            })
          ).map((e) => ({ ...e, tenantId: b.tenantId, branch: b.name }))
    )
  );
  const entries = perBranch
    .flat()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(offset, offset + q.size);
  return { entries, total, page, capped };
}

// ─── Usage: who uses Signex, per branch and per account ───────────────────

export interface UsageAccount {
  id: string;
  name: string;
  username: string | null;
  role: "ADMIN" | "DRIVER";
  active: boolean;
  lastActiveAt: Date | null;
  /** Signed in right now, on this many devices. */
  devicesNow: number;
  signIns: number;
  /** Deliveries, collections, courier handovers and credit notes signed. */
  signatures: number;
  /** Everything else they did (sign-ins and sign-outs not counted). */
  actions: number;
}

export interface BranchUsage {
  tenantId: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  accounts: UsageAccount[];
  totals: {
    accounts: number;
    /** Accounts seen in the period (signed in, or active on a session). */
    activeUsers: number;
    devicesNow: number;
    signIns: number;
    deliveriesSigned: number;
    actions: number;
    lastActiveAt: Date | null;
  };
}

const NOT_ACTIONS = new Set<AuditAction>(["LOGIN", "LOGOUT", "LOGIN_FAILED"]);

export async function branchUsage(branch: BranchRef, since: Date, now = new Date()): Promise<BranchUsage> {
  const db = scopedPrisma(branch.tenantId);
  const [admins, drivers, audit, deliveries] = await Promise.all([
    db.admin.findMany({ select: { id: true, name: true, email: true, active: true, login: { select: { username: true } } } }),
    db.driver.findMany({ select: { id: true, name: true, active: true, login: { select: { username: true } } } }),
    db.auditLog.groupBy({
      by: ["actorId", "action"],
      where: { createdAt: { gte: since }, actorId: { not: null } },
      _count: { _all: true },
    }),
    db.auditLog.count({ where: { action: "SIGN", entity: "stop", createdAt: { gte: since } } }),
  ]);

  // Only ADMIN accounts are branch admins (role lives on User, by email): an
  // account promoted to SUPER_ADMIN, though it lives here, is not listed.
  // SCOPE-EXEMPT: the User role registry, read by email for this branch's admins.
  const roles = admins.length
    ? await UNSAFE_unscopedPrisma.user.findMany({
        where: { email: { in: admins.map((a) => a.email) } },
        select: { email: true, role: true },
      })
    : [];
  const roleOf = new Map(roles.map((r) => [r.email.toLowerCase(), r.role]));
  const branchAdmins = admins.filter((a) => (roleOf.get(a.email.toLowerCase()) ?? "ADMIN") === "ADMIN");

  // SCOPE-EXEMPT: UserSession has no tenantId; read only for the ids above,
  // which came from this branch's scoped client.
  const sessions = async (key: "adminId" | "driverId", ids: string[]) => {
    if (ids.length === 0) return { last: new Map<string, Date>(), live: new Map<string, number>() };
    const [last, live] = await Promise.all([
      UNSAFE_unscopedPrisma.userSession.groupBy({ by: [key], where: { [key]: { in: ids } }, _max: { lastSeenAt: true } }),
      UNSAFE_unscopedPrisma.userSession.groupBy({
        by: [key],
        where: { [key]: { in: ids }, revokedAt: null, expiresAt: { gt: now } },
        _count: { _all: true },
      }),
    ]);
    return {
      last: new Map(last.map((r) => [r[key] as string, r._max.lastSeenAt as Date])),
      live: new Map(live.map((r) => [r[key] as string, r._count._all])),
    };
  };
  const [adminSessions, driverSessions] = await Promise.all([
    sessions("adminId", branchAdmins.map((a) => a.id)),
    sessions("driverId", drivers.map((d) => d.id)),
  ]);

  const byActor = new Map<string, { signIns: number; signatures: number; actions: number }>();
  for (const g of audit) {
    const row = byActor.get(g.actorId!) ?? { signIns: 0, signatures: 0, actions: 0 };
    const n = g._count._all;
    if (g.action === "LOGIN") row.signIns += n;
    if (g.action === "SIGN") row.signatures += n;
    if (!NOT_ACTIONS.has(g.action)) row.actions += n;
    byActor.set(g.actorId!, row);
  }

  const account = (
    a: { id: string; name: string; active: boolean; login: { username: string } | null },
    role: "ADMIN" | "DRIVER",
    s: Awaited<ReturnType<typeof sessions>>
  ): UsageAccount => ({
    id: a.id,
    name: a.name,
    username: a.login?.username ?? null,
    role,
    active: a.active,
    lastActiveAt: s.last.get(a.id) ?? null,
    devicesNow: s.live.get(a.id) ?? 0,
    ...(byActor.get(a.id) ?? { signIns: 0, signatures: 0, actions: 0 }),
  });
  const accounts = [
    ...branchAdmins.map((a) => account(a, "ADMIN", adminSessions)),
    ...drivers.map((d) => account(d, "DRIVER", driverSessions)),
  ].sort(
    (a, b) =>
      (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0) || a.name.localeCompare(b.name)
  );

  const sum = (k: "devicesNow" | "signIns" | "actions") => accounts.reduce((n, a) => n + a[k], 0);
  return {
    tenantId: branch.tenantId,
    name: branch.name,
    companyId: branch.companyId,
    companyName: branch.companyName,
    accounts,
    totals: {
      accounts: accounts.length,
      activeUsers: accounts.filter((a) => a.signIns > 0 || a.actions > 0 || (a.lastActiveAt && a.lastActiveAt >= since)).length,
      devicesNow: sum("devicesNow"),
      signIns: sum("signIns"),
      deliveriesSigned: deliveries,
      actions: sum("actions"),
      lastActiveAt: accounts[0]?.lastActiveAt ?? null,
    },
  };
}
