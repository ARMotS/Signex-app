/**
 * A COMPANY_ADMIN's own page: the branch admins allocated to it, and the two
 * things it may do to them — change a username, reset a password.
 *
 * Every lookup goes through the allocation registry, addressed by the
 * caller's OWN account id from the session. An admin is reachable only while
 * an allocation row ties it to this COMPANY_ADMIN and its company is active;
 * the row's composite foreign keys already pin it to a BRANCH scope of the
 * same company. Anything else — unallocated, another company, the
 * SUPER_ADMIN, a driver, another company admin, this account itself — is not
 * found (404), the same answer as an id that does not exist.
 */

import { UNSAFE_unscopedPrisma } from "./db-scoped";
import { updateAdminAccount } from "./accounts";
import { USERNAME_TAKEN } from "./credentials";

export interface MyAdmin {
  id: string;
  name: string;
  username: string | null;
  branchTenantId: string;
  branch: string;
  active: boolean;
  /** The latest moment any of its sessions was seen; null if never signed in. */
  lastActiveAt: Date | null;
}

export class CompanyAdminActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
  }
}

const notFound = () => new CompanyAdminActionError("NOT_FOUND", "Not found", 404);

/** Only ADMIN accounts are branch admins (role lives on User, by email). */
async function branchAdminEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  // SCOPE-EXEMPT: the User role registry, read by email for admins already
  // reached through this COMPANY_ADMIN's allocations.
  const users = await UNSAFE_unscopedPrisma.user.findMany({
    where: { email: { in: emails } },
    select: { email: true, role: true },
  });
  const roleOf = new Map(users.map((u) => [u.email.toLowerCase(), u.role]));
  return new Set(emails.filter((e) => (roleOf.get(e.toLowerCase()) ?? "ADMIN") === "ADMIN"));
}

/** The branch admins this COMPANY_ADMIN oversees, by branch then name. */
export async function listMyAdmins(companyAdminId: string): Promise<MyAdmin[]> {
  // SCOPE-EXEMPT: the allocation registry, addressed by the session's own
  // account id; account metadata of allocated admins only.
  const rows = await UNSAFE_unscopedPrisma.companyAdminAllocation.findMany({
    where: { companyAdminId, company: { isActive: true } },
    select: {
      branch: { select: { id: true, name: true, companyName: true } },
      admin: {
        select: { id: true, name: true, email: true, active: true, login: { select: { username: true } } },
      },
    },
  });
  const admins = await branchAdminEmails(rows.map((r) => r.admin.email));
  const allowed = rows.filter((r) => admins.has(r.admin.email));

  // SCOPE-EXEMPT: session rows of the admins listed above, by their ids.
  const seen = allowed.length
    ? await UNSAFE_unscopedPrisma.userSession.groupBy({
        by: ["adminId"],
        where: { adminId: { in: allowed.map((r) => r.admin.id) } },
        _max: { lastSeenAt: true },
      })
    : [];
  const lastSeen = new Map(seen.map((s) => [s.adminId, s._max.lastSeenAt]));

  return allowed
    .map(({ admin, branch }) => ({
      id: admin.id,
      name: admin.name,
      username: admin.login?.username ?? null,
      branchTenantId: branch.id,
      branch: branch.companyName || branch.name,
      active: admin.active,
      lastActiveAt: lastSeen.get(admin.id) ?? null,
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name));
}

/** The one admin this COMPANY_ADMIN may act on, or 404. Checked on every call. */
async function allocatedAdmin(companyAdminId: string, adminId: unknown) {
  if (typeof adminId !== "string" || !adminId) throw notFound();
  // SCOPE-EXEMPT: the allocation registry, addressed by the session's own
  // account id and the admin it names.
  const row = await UNSAFE_unscopedPrisma.companyAdminAllocation.findFirst({
    where: { companyAdminId, adminId, company: { isActive: true } },
    select: { branchTenantId: true, admin: { select: { id: true, email: true, name: true } } },
  });
  if (!row || !(await branchAdminEmails([row.admin.email])).has(row.admin.email)) throw notFound();
  return row;
}

/**
 * Change an allocated admin's username or reset its password. A reset signs
 * it out of every device (updateAdminAccount revokes in the same write), and
 * each change is audited in the branch's own log with this COMPANY_ADMIN as
 * the actor.
 */
export async function updateMyAdmin(
  companyAdminId: string,
  adminId: unknown,
  body: { username?: unknown; password?: unknown }
): Promise<void> {
  const target = await allocatedAdmin(companyAdminId, adminId);
  const username = typeof body.username === "string" ? body.username : undefined;
  const password = typeof body.password === "string" ? body.password : undefined;
  if (!username && !password) {
    throw new CompanyAdminActionError("BAD_REQUEST", "Give a new username or a new password.", 400);
  }
  const result = await updateAdminAccount(target.branchTenantId, target.admin.email, { username, password });
  if (!result.success) {
    if (result.error === USERNAME_TAKEN) throw new CompanyAdminActionError("USERNAME_TAKEN", USERNAME_TAKEN, 409);
    throw new CompanyAdminActionError("BAD_REQUEST", result.error ?? "That did not save", 400);
  }
}
