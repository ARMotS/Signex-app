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
import { logAudit } from "./audit";

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

type Tx = Parameters<Parameters<typeof UNSAFE_unscopedPrisma.$transaction>[0]>[0];

/** A company's home scope (kind COMPANY): where its COMPANY_ADMINs live. */
async function createCompanyHome(tx: Tx, companyId: string, companyName: string): Promise<string> {
  const base = `company-${slugify(companyName)}`;
  let slug = base;
  for (let n = 2; await tx.tenant.findUnique({ where: { slug }, select: { id: true } }); n++) {
    slug = `${base}-${n}`;
  }
  const home = await tx.tenant.create({
    data: { name: companyName, companyName, slug, kind: "COMPANY", companyId },
    select: { id: true },
  });
  return home.id;
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

    const homeId = home?.id ?? (await createCompanyHome(tx, company.id, companyName));

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

// ─── The SUPER_ADMIN's console ────────────────────────────────────────────
//
// Every function below is SUPER_ADMIN-only: the routes in
// app/api/admin/companies check the role before calling. They read and write
// the Company / Tenant / allocation registries, which span scopes by nature.

export class CompanyError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const COMPANY_NAME_MAX = 100;

function readCompanyName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new CompanyError("BAD_REQUEST", "Enter the company's name.", 400);
  if (name.length > COMPANY_NAME_MAX) {
    throw new CompanyError("BAD_REQUEST", `Company name must be ${COMPANY_NAME_MAX} characters or fewer.`, 400);
  }
  return name;
}

export interface PersonView {
  id: string;
  name: string;
  email: string;
  username: string | null;
  active: boolean;
}

export interface BranchView {
  tenantId: string;
  name: string;
  companyName: string | null;
  /** The branch's ADMIN accounts — the ones that can be allocated. */
  admins: PersonView[];
}

export interface CompanyAdminView extends PersonView {
  allocatedAdminIds: string[];
}

export interface CompanyView {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  homeTenantId: string | null;
  branches: BranchView[];
  companyAdmins: CompanyAdminView[];
}

const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  active: true,
  login: { select: { username: true } },
} as const;

function person(a: {
  id: string;
  name: string;
  email: string;
  active: boolean;
  login: { username: string } | null;
}): PersonView {
  return { id: a.id, name: a.name, email: a.email, username: a.login?.username ?? null, active: a.active };
}

/** Every company with its branches, company admins and allocations, plus the branches no company has. */
export async function listCompanies(): Promise<{ companies: CompanyView[]; unassignedBranches: BranchView[] }> {
  // SCOPE-EXEMPT: the SUPER_ADMIN's company console; account metadata only.
  const db = UNSAFE_unscopedPrisma;
  const branchSelect = {
    id: true,
    name: true,
    companyName: true,
    kind: true,
    admins: { select: PERSON_SELECT, orderBy: { createdAt: "asc" as const } },
  };
  const [companies, unassigned] = await Promise.all([
    db.company.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        isActive: true,
        createdAt: true,
        tenants: { orderBy: { name: "asc" }, select: branchSelect },
        companyAdmins: {
          orderBy: { createdAt: "asc" },
          select: { ...PERSON_SELECT, overseesAllocations: { select: { adminId: true } } },
        },
      },
    }),
    db.tenant.findMany({ where: { kind: "BRANCH", companyId: null }, orderBy: { name: "asc" }, select: branchSelect }),
  ]);

  // Only ADMIN accounts are branch admins (role lives on User, by email).
  const emails = [...companies.flatMap((c) => c.tenants), ...unassigned].flatMap((t) => t.admins.map((a) => a.email));
  const users = await db.user.findMany({ where: { email: { in: emails } }, select: { email: true, role: true } });
  const roleOf = new Map(users.map((u) => [u.email.toLowerCase(), u.role]));
  const branchView = (t: (typeof unassigned)[number]): BranchView => ({
    tenantId: t.id,
    name: t.name,
    companyName: t.companyName,
    admins: t.admins.filter((a) => (roleOf.get(a.email.toLowerCase()) ?? "ADMIN") === "ADMIN").map(person),
  });

  return {
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      createdAt: c.createdAt,
      homeTenantId: c.tenants.find((t) => t.kind === "COMPANY")?.id ?? null,
      branches: c.tenants.filter((t) => t.kind === "BRANCH").map(branchView),
      companyAdmins: c.companyAdmins.map((a) => ({
        ...person(a),
        allocatedAdminIds: a.overseesAllocations.map((x) => x.adminId),
      })),
    })),
    unassignedBranches: unassigned.map(branchView),
  };
}

async function companyOrThrow(id: string) {
  // SCOPE-EXEMPT: the Company registry, addressed by primary key.
  const company = await UNSAFE_unscopedPrisma.company.findUnique({
    where: { id },
    select: { id: true, name: true, isActive: true },
  });
  if (!company) throw new CompanyError("NOT_FOUND", "Company not found", 404);
  return company;
}

async function homeOf(companyId: string): Promise<string | null> {
  // SCOPE-EXEMPT: the Tenant registry — the company's own home scope.
  const home = await UNSAFE_unscopedPrisma.tenant.findFirst({
    where: { kind: "COMPANY", companyId },
    select: { id: true },
  });
  return home?.id ?? null;
}

async function assertNameFree(name: string, exceptId?: string) {
  // SCOPE-EXEMPT: company names are compared across the installation.
  const clash = await UNSAFE_unscopedPrisma.company.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new CompanyError("DUPLICATE", `A company called "${name}" already exists.`, 409);
}

/** A new company and its home scope. */
export async function createCompany(rawName: unknown): Promise<{ id: string; homeTenantId: string }> {
  const name = readCompanyName(rawName);
  await assertNameFree(name);
  // SCOPE-EXEMPT: the Company/Tenant registries.
  const created = await UNSAFE_unscopedPrisma.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name }, select: { id: true } });
    return { id: company.id, homeTenantId: await createCompanyHome(tx, company.id, name) };
  });
  await logAudit({
    action: "COMPANY_CREATE",
    entity: "company",
    entityId: created.id,
    details: `Company created: ${name}`,
    tenantId: created.homeTenantId,
  });
  return created;
}

/** Rename, or deactivate / reactivate. An inactive company's admins see no branch. */
export async function updateCompany(id: string, changes: { name?: unknown; isActive?: unknown }): Promise<void> {
  const company = await companyOrThrow(id);
  const data: { name?: string; isActive?: boolean } = {};
  if (changes.name !== undefined) {
    const name = readCompanyName(changes.name);
    if (name !== company.name) {
      await assertNameFree(name, id);
      data.name = name;
    }
  }
  if (changes.isActive !== undefined) {
    if (typeof changes.isActive !== "boolean") {
      throw new CompanyError("BAD_REQUEST", "isActive must be true or false.", 400);
    }
    if (changes.isActive !== company.isActive) data.isActive = changes.isActive;
  }
  if (Object.keys(data).length === 0) return;

  // SCOPE-EXEMPT: the Company/Tenant registries.
  await UNSAFE_unscopedPrisma.$transaction(async (tx) => {
    await tx.company.update({ where: { id }, data });
    // The home scope carries the company's name as its label.
    if (data.name) {
      await tx.tenant.updateMany({
        where: { kind: "COMPANY", companyId: id },
        data: { name: data.name, companyName: data.name },
      });
    }
  });
  await logAudit({
    action: "COMPANY_UPDATE",
    entity: "company",
    entityId: id,
    details: [
      data.name !== undefined ? `Renamed ${company.name} → ${data.name}` : null,
      data.isActive !== undefined
        ? data.isActive
          ? "Reactivated"
          : "Deactivated — its company admins see no branch"
        : null,
    ]
      .filter(Boolean)
      .join("; "),
    metadata: {
      ...(data.name !== undefined && { name: { from: company.name, to: data.name } }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
    tenantId: await homeOf(id),
  });
}

/** Give an unassigned branch to this company. */
export async function attachBranch(companyId: string, tenantId: unknown): Promise<void> {
  const company = await companyOrThrow(companyId);
  if (typeof tenantId !== "string") throw new CompanyError("BAD_REQUEST", "Choose a branch.", 400);
  // SCOPE-EXEMPT: the Tenant registry, addressed by primary key.
  const branch = await UNSAFE_unscopedPrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, kind: true, companyId: true },
  });
  // The root scope and company scopes are not branches; as far as this
  // console is concerned they do not exist here.
  if (!branch || branch.kind !== "BRANCH") throw new CompanyError("NOT_FOUND", "Branch not found", 404);
  if (branch.companyId === companyId) return;
  if (branch.companyId) {
    throw new CompanyError("OTHER_COMPANY", "That branch belongs to another company — detach it there first.", 409);
  }
  const moved = await UNSAFE_unscopedPrisma.tenant.updateMany({
    where: { id: tenantId, kind: "BRANCH", companyId: null },
    data: { companyId },
  });
  if (moved.count !== 1) throw new CompanyError("CHANGED", "That branch changed while this was saved — try again.", 409);
  await logAudit({
    action: "BRANCH_ATTACH",
    entity: "branch",
    entityId: tenantId,
    details: `Branch ${branch.name} attached to ${company.name}`,
    metadata: { companyId },
    tenantId,
  });
}

/** Take a branch out of this company. Refused while any of its admins is allocated. */
export async function detachBranch(companyId: string, tenantId: unknown): Promise<void> {
  const company = await companyOrThrow(companyId);
  if (typeof tenantId !== "string") throw new CompanyError("BAD_REQUEST", "Choose a branch.", 400);
  // SCOPE-EXEMPT: the Tenant / allocation registries, addressed by primary key.
  const branch = await UNSAFE_unscopedPrisma.tenant.findFirst({
    where: { id: tenantId, kind: "BRANCH", companyId },
    select: { id: true, name: true },
  });
  if (!branch) throw new CompanyError("NOT_FOUND", "Branch not found in this company", 404);
  const allocated = await UNSAFE_unscopedPrisma.companyAdminAllocation.count({ where: { branchTenantId: tenantId } });
  if (allocated > 0) {
    throw new CompanyError(
      "ALLOCATED",
      allocated === 1
        ? "This branch is allocated to a company admin — remove that allocation first."
        : `This branch is allocated to ${allocated} company admins — remove those allocations first.`,
      409
    );
  }
  try {
    await UNSAFE_unscopedPrisma.tenant.updateMany({ where: { id: tenantId, companyId }, data: { companyId: null } });
  } catch {
    // An allocation made between the count and the update: the foreign key
    // refuses to orphan it (ON UPDATE RESTRICT).
    throw new CompanyError("ALLOCATED", "This branch was just allocated — remove that allocation first.", 409);
  }
  await logAudit({
    action: "BRANCH_DETACH",
    entity: "branch",
    entityId: tenantId,
    details: `Branch ${branch.name} detached from ${company.name}`,
    metadata: { companyId },
    tenantId,
  });
}

/** A new COMPANY_ADMIN account in this company. */
export async function addCompanyAdmin(
  companyId: string,
  input: { name?: unknown; email?: unknown; username?: unknown; password?: unknown }
): Promise<{ id: string; username: string }> {
  const company = await companyOrThrow(companyId);
  const homeTenantId =
    (await homeOf(companyId)) ??
    // SCOPE-EXEMPT: a company made without a home scope gets one now.
    (await UNSAFE_unscopedPrisma.$transaction((tx) => createCompanyHome(tx, companyId, company.name)));
  const { createCompanyAdminAccount } = await import("./accounts");
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const result = await createCompanyAdminAccount(companyId, homeTenantId, {
    name: text(input.name),
    email: text(input.email),
    username: text(input.username),
    password: text(input.password),
  });
  if (!result.success || !result.account) {
    throw new CompanyError("BAD_REQUEST", result.error ?? "Failed to create account", 400);
  }
  return { id: result.account.id, username: result.account.username };
}

/**
 * Make this COMPANY_ADMIN's allocations exactly `adminIds`: every id must be
 * an ADMIN of a branch in this company, or nothing changes (404). The
 * allocation table's foreign keys hold the same line in the database.
 */
export async function setAllocations(
  companyId: string,
  companyAdminId: unknown,
  rawAdminIds: unknown,
  allocatedBy: string
): Promise<{ added: number; removed: number }> {
  await companyOrThrow(companyId);
  if (typeof companyAdminId !== "string") throw new CompanyError("BAD_REQUEST", "Choose a company admin.", 400);
  if (!Array.isArray(rawAdminIds) || rawAdminIds.some((x) => typeof x !== "string") || rawAdminIds.length > 500) {
    throw new CompanyError("BAD_REQUEST", "adminIds must be a list of admin ids.", 400);
  }
  const adminIds = [...new Set(rawAdminIds as string[])];
  const db = UNSAFE_unscopedPrisma;

  // SCOPE-EXEMPT: the allocation registry and the admins it may name, all
  // addressed by id and narrowed to this company.
  const companyAdmin = await db.admin.findFirst({
    where: { id: companyAdminId, companyId },
    select: { id: true, name: true, overseesAllocations: { select: { adminId: true } } },
  });
  if (!companyAdmin) throw new CompanyError("NOT_FOUND", "Company admin not found in this company", 404);

  const candidates = adminIds.length
    ? await db.admin.findMany({
        where: { id: { in: adminIds }, tenant: { kind: "BRANCH", companyId } },
        select: { id: true, name: true, email: true, tenantId: true },
      })
    : [];
  const roles = await db.user.findMany({
    where: { email: { in: candidates.map((c) => c.email) } },
    select: { email: true, role: true },
  });
  const roleOf = new Map(roles.map((r) => [r.email.toLowerCase(), r.role]));
  const valid = candidates.filter((c) => (roleOf.get(c.email.toLowerCase()) ?? "ADMIN") === "ADMIN");
  if (valid.length !== adminIds.length) {
    throw new CompanyError("NOT_FOUND", "One of those admins is not a branch admin of this company.", 404);
  }

  const current = new Set(companyAdmin.overseesAllocations.map((a) => a.adminId));
  const wanted = new Set(adminIds);
  const toAdd = valid.filter((a) => !current.has(a.id));
  const toRemove = [...current].filter((id) => !wanted.has(id));
  if (toAdd.length === 0 && toRemove.length === 0) return { added: 0, removed: 0 };

  // Who is being removed, for the log (read before the delete).
  const removedRows = toRemove.length
    ? await db.companyAdminAllocation.findMany({
        where: { companyAdminId, adminId: { in: toRemove } },
        select: { adminId: true, branchTenantId: true, admin: { select: { name: true } } },
      })
    : [];

  await db.$transaction(async (tx) => {
    if (toRemove.length) {
      await tx.companyAdminAllocation.deleteMany({ where: { companyAdminId, adminId: { in: toRemove } } });
    }
    if (toAdd.length) {
      await tx.companyAdminAllocation.createMany({
        data: toAdd.map((a) => ({ companyId, companyAdminId, adminId: a.id, branchTenantId: a.tenantId, allocatedBy })),
        skipDuplicates: true,
      });
    }
  });

  // One entry per change, in the branch's own log.
  for (const a of toAdd) {
    await logAudit({
      action: "ALLOCATE",
      entity: "allocation",
      entityId: a.id,
      userName: a.name,
      details: `${a.name} allocated to company admin ${companyAdmin.name}`,
      metadata: { companyId, companyAdminId, adminId: a.id },
      tenantId: a.tenantId,
    });
  }
  for (const r of removedRows) {
    await logAudit({
      action: "DEALLOCATE",
      entity: "allocation",
      entityId: r.adminId,
      userName: r.admin.name,
      details: `${r.admin.name} removed from company admin ${companyAdmin.name}`,
      metadata: { companyId, companyAdminId, adminId: r.adminId },
      tenantId: r.branchTenantId,
    });
  }
  return { added: toAdd.length, removed: removedRows.length };
}
