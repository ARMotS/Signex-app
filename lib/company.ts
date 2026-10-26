/**
 * Companies and COMPANY_ADMIN oversight.
 *
 * A COMPANY_ADMIN may view (and act in) exactly the branches of the branch
 * ADMINs a SUPER_ADMIN allocated to it, and only while its company is active.
 * The allocation table's composite foreign keys already make an allocation
 * across companies unrepresentable; these lookups are what every request a
 * COMPANY_ADMIN makes is checked against, so removing an allocation or
 * deactivating the company takes effect on the next request.
 *
 * Everything here reads the allocation registry, which spans scopes by
 * nature (a company's branches are separate tenants). Each query is
 * addressed by the caller's OWN account id, taken from the session.
 */

import { UNSAFE_unscopedPrisma } from "./db-scoped";

/**
 * Whether this COMPANY_ADMIN may view this branch right now. The one check
 * getSessionContext() runs on every request a COMPANY_ADMIN makes.
 */
export async function isBranchAllocated(
  companyAdminId: string,
  branchTenantId: string
): Promise<boolean> {
  // SCOPE-EXEMPT: the allocation registry, addressed by the session's own
  // account id and the branch it asks for. Returns a yes/no only.
  const row = await UNSAFE_unscopedPrisma.companyAdminAllocation.findFirst({
    where: { companyAdminId, branchTenantId, company: { isActive: true } },
    select: { id: true },
  });
  return row !== null;
}

export interface AllocatedBranch {
  tenantId: string;
  name: string;
  companyName: string | null;
  admins: { id: string; name: string; email: string; username: string | null }[];
  counts: { drivers: number; contacts: number; tripSheets: number; stops: number };
}

/**
 * The branches this COMPANY_ADMIN may view, oldest allocation first, each
 * with the allocated admins in it. Nothing outside its allocations — in
 * particular never the root scope or any SUPER_ADMIN, which cannot be
 * allocated (the composite FK admits only BRANCH scopes).
 */
export async function listAllocatedBranches(companyAdminId: string): Promise<AllocatedBranch[]> {
  // SCOPE-EXEMPT: the allocation registry, addressed by the session's own
  // account id; returns account metadata and row counts for allocated
  // branches only.
  const rows = await UNSAFE_unscopedPrisma.companyAdminAllocation.findMany({
    where: { companyAdminId, company: { isActive: true } },
    orderBy: { allocatedAt: "asc" },
    select: {
      admin: {
        select: { id: true, name: true, email: true, login: { select: { username: true } } },
      },
      branch: {
        select: {
          id: true,
          name: true,
          companyName: true,
          _count: { select: { drivers: true, contacts: true, tripSheets: true, stops: true } },
        },
      },
    },
  });

  const byTenant = new Map<string, AllocatedBranch>();
  for (const { admin, branch } of rows) {
    const entry =
      byTenant.get(branch.id) ??
      byTenant
        .set(branch.id, {
          tenantId: branch.id,
          name: branch.name,
          companyName: branch.companyName,
          admins: [],
          counts: branch._count,
        })
        .get(branch.id)!;
    entry.admins.push({
      id: admin.id,
      name: admin.name,
      email: admin.email,
      username: admin.login?.username ?? null,
    });
  }
  return [...byTenant.values()];
}

/** The branch a COMPANY_ADMIN lands in on sign-in: its oldest allocation. */
export async function firstAllocatedBranch(companyAdminId: string): Promise<string | null> {
  // SCOPE-EXEMPT: the allocation registry, addressed by the signing-in
  // account's own id.
  const row = await UNSAFE_unscopedPrisma.companyAdminAllocation.findFirst({
    where: { companyAdminId, company: { isActive: true } },
    orderBy: { allocatedAt: "asc" },
    select: { branchTenantId: true },
  });
  return row?.branchTenantId ?? null;
}

// ─── Backfill: create a company and attach branches ───────────────────────

export interface CompanyBackfillBranch {
  username: string;
  tenantId: string | null;
  tenantName: string | null;
  action: "attach" | "already" | "refused";
  reason?: string;
}

export interface CompanyBackfillResult {
  applied: boolean;
  companyName: string;
  company: { id: string | null; created: boolean };
  homeTenant: { id: string | null; created: boolean };
  branches: CompanyBackfillBranch[];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "company"
  );
}

/**
 * Create a company (if it does not exist) with its company-home scope, and
 * attach the branches of the named ADMIN accounts to it. Branches are named
 * by their ADMIN's username: stable, globally unique, and what an office can
 * read off the Users page — unlike a tenant id.
 *
 * All or nothing: if any username is unknown, not a branch ADMIN, or its
 * branch already belongs to ANOTHER company, nothing is written. Idempotent:
 * a second run finds the company and reports every branch "already".
 * Without `apply` it only reports.
 */
export async function backfillCompany(opts: {
  companyName: string;
  usernames: string[];
  apply: boolean;
}): Promise<CompanyBackfillResult> {
  const companyName = opts.companyName.trim();
  if (!companyName) throw new Error("A company name is required");
  const usernames = [...new Set(opts.usernames.map((u) => u.trim().toLowerCase()).filter(Boolean))];
  if (usernames.length === 0) throw new Error("At least one admin username is required");

  // SCOPE-EXEMPT: migration helper — the Company/Tenant/LoginName registries
  // span scopes by nature. SUPER_ADMIN-only (run from a script or by the
  // SUPER_ADMIN), and it writes registry columns only, never scoped data.
  const db = UNSAFE_unscopedPrisma;

  const companies = await db.company.findMany({
    where: { name: { equals: companyName, mode: "insensitive" } },
    select: { id: true },
  });
  if (companies.length > 1) {
    throw new Error(`More than one company is called "${companyName}" — resolve that by hand first`);
  }
  const existing = companies[0] ?? null;

  const branches: CompanyBackfillBranch[] = [];
  for (const username of usernames) {
    const login = await db.loginName.findUnique({
      where: { username },
      select: {
        admin: {
          select: {
            email: true,
            tenant: { select: { id: true, name: true, kind: true, companyId: true } },
          },
        },
      },
    });
    const tenant = login?.admin?.tenant ?? null;
    const refuse = (reason: string) =>
      branches.push({
        username,
        tenantId: tenant?.id ?? null,
        tenantName: tenant?.name ?? null,
        action: "refused",
        reason,
      });

    if (!login?.admin || !tenant) {
      refuse(login ? "not an admin account" : "no such username");
      continue;
    }
    const user = await db.user.findUnique({
      where: { email: login.admin.email.toLowerCase() },
      select: { role: true },
    });
    if ((user?.role ?? "ADMIN") !== "ADMIN") {
      refuse(`a ${user?.role} account, not a branch admin`);
      continue;
    }
    if (tenant.kind !== "BRANCH") {
      refuse(`its scope is a ${tenant.kind} scope, not a branch`);
      continue;
    }
    if (tenant.companyId && tenant.companyId !== existing?.id) {
      refuse("its branch already belongs to another company");
      continue;
    }
    branches.push({
      username,
      tenantId: tenant.id,
      tenantName: tenant.name,
      action: tenant.companyId ? "already" : "attach",
    });
  }

  const home = existing
    ? await db.tenant.findFirst({
        where: { kind: "COMPANY", companyId: existing.id },
        select: { id: true },
      })
    : null;

  const result: CompanyBackfillResult = {
    applied: false,
    companyName,
    company: { id: existing?.id ?? null, created: !existing },
    homeTenant: { id: home?.id ?? null, created: !home },
    branches,
  };
  if (!opts.apply || branches.some((b) => b.action === "refused")) return result;

  await db.$transaction(async (tx) => {
    const company =
      existing ?? (await tx.company.create({ data: { name: companyName }, select: { id: true } }));

    let homeId = home?.id ?? null;
    if (!homeId) {
      const base = `company-${slugify(companyName)}`;
      let slug = base;
      for (let n = 2; await tx.tenant.findUnique({ where: { slug }, select: { id: true } }); n++) {
        slug = `${base}-${n}`;
      }
      homeId = (
        await tx.tenant.create({
          data: { name: companyName, companyName, slug, kind: "COMPANY", companyId: company.id },
          select: { id: true },
        })
      ).id;
    }

    const attach = branches.filter((b) => b.action === "attach").map((b) => b.tenantId!);
    if (attach.length > 0) {
      // Conditional on still being unassigned, so a branch claimed by another
      // company since the check above is not silently moved.
      const moved = await tx.tenant.updateMany({
        where: { id: { in: attach }, kind: "BRANCH", companyId: null },
        data: { companyId: company.id },
      });
      if (moved.count !== attach.length) {
        throw new Error("A branch changed company while this ran — nothing was written");
      }
    }

    result.company.id = company.id;
    result.homeTenant.id = homeId;
  });

  result.applied = true;
  return result;
}
