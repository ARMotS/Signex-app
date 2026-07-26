/**
 * Account management — PostgreSQL via Prisma.
 * Supports admin accounts (email/password) and driver accounts (name/PIN).
 * Passwords are hashed with Node.js crypto scrypt.
 *
 * Every driver operation is scoped: a driver belongs to exactly one ADMIN's
 * tenant and is invisible to every other ADMIN. Login is the sole exception —
 * it necessarily runs before a scope exists, and is handled below with care not
 * to leak which scopes hold which names.
 */

import crypto from "crypto";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";

export type AccountRole = "admin" | "driver";

// ─── Password Hashing ─────────────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  // Constant-time compare — both sides are fixed-length hex of the same length.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Admin Account Operations ─────────────────────────────────────────────

/**
 * Create an admin account inside a scope.
 *
 * @param tenantId The scope this admin OWNS. For a new ADMIN this must be a
 *                 freshly created tenant — never the creator's own scope, or
 *                 the two admins share data. See app/api/admin/users/route.ts.
 */
export async function createAdminAccount(
  name: string,
  email: string,
  password: string,
  tenantId: string
): Promise<{ success: boolean; error?: string; account?: { id: string; name: string; email: string } }> {
  try {
    // SCOPE-EXEMPT: Admin.email is globally unique across the installation, so
    // this collision check must span scopes. It returns only a boolean-ish
    // "already exists" and never surfaces the other scope's row.
    const existing = await UNSAFE_unscopedPrisma.admin.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return { success: false, error: "An account with this email already exists" };
    }

    const admin = await scopedPrisma(tenantId).admin.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash: hashPassword(password),
      },
      select: { id: true, name: true, email: true },
    });

    await logAudit({
      action: "LOGIN",
      entity: "admin",
      entityId: admin.id,
      userName: admin.name,
      details: `Admin account created: ${admin.email}`,
      tenantId,
    });

    return { success: true, account: admin };
  } catch (err) {
    console.error("Failed to create admin:", err);
    return { success: false, error: "Failed to create account" };
  }
}

/**
 * Update an admin credential row, matched by its current email.
 * Only touches the Admin table (email/password/name live here); the
 * companion User row is updated separately by the caller.
 */
export async function updateAdminAccount(
  tenantId: string,
  currentEmail: string,
  updates: { name?: string; email?: string; password?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    // Scoped lookup: an admin outside this scope is simply not found, so a
    // SUPER_ADMIN cannot rewrite another scope's credentials by guessing an email.
    const admin = await db.admin.findFirst({
      where: { email: currentEmail.toLowerCase() },
    });
    if (!admin) {
      return { success: false, error: "Admin credentials not found" };
    }

    // SCOPE-EXEMPT: Admin.email is globally unique, so a rename must not collide
    // with an account in another scope. Only existence is used.
    if (updates.email !== undefined && updates.email.toLowerCase() !== admin.email) {
      const clash = await UNSAFE_unscopedPrisma.admin.findUnique({
        where: { email: updates.email.toLowerCase() },
      });
      if (clash) {
        return { success: false, error: "An account with this email already exists" };
      }
    }

    await db.admin.update({
      where: { id: admin.id },
      data: {
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.email !== undefined && { email: updates.email.toLowerCase() }),
        ...(updates.password !== undefined &&
          updates.password !== "" && {
            passwordHash: hashPassword(updates.password),
          }),
      },
    });

    await logAudit({
      action: "CONFIG_UPDATE",
      entity: "admin",
      entityId: admin.id,
      userName: updates.name || admin.name,
      details: `Admin account updated: ${(updates.email || admin.email).toLowerCase()}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to update admin:", err);
    return { success: false, error: "Failed to update admin credentials" };
  }
}

/**
 * Delete an admin credential row by email.
 * The companion User row is deleted separately by the caller.
 */
export async function deleteAdminAccount(
  tenantId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Scoped delete: an email belonging to another scope matches zero rows rather
    // than deleting that scope's admin.
    const res = await scopedPrisma(tenantId).admin.deleteMany({
      where: { email: email.toLowerCase() },
    });

    if (res.count === 0) {
      return { success: false, error: "Admin credentials not found" };
    }

    await logAudit({
      action: "CONFIG_UPDATE",
      entity: "admin",
      details: `Admin account deleted: ${email.toLowerCase()}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete admin:", err);
    return { success: false, error: "Failed to delete admin credentials" };
  }
}

export async function loginAdmin(
  email: string,
  password: string
): Promise<{
  success: boolean;
  error?: string;
  account?: { id: string; name: string; email: string; tenantId: string };
}> {
  // SCOPE-EXEMPT: pre-session. Email is globally unique, so this resolves to at
  // most one admin and its scope comes from the row itself.
  const admin = await UNSAFE_unscopedPrisma.admin.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!admin) {
    return { success: false, error: "Invalid email or password" };
  }

  if (!verifyPassword(password, admin.passwordHash)) {
    return { success: false, error: "Invalid email or password" };
  }

  await logAudit({
    action: "LOGIN",
    entity: "admin",
    entityId: admin.id,
    userName: admin.name,
    details: "Admin login",
    tenantId: admin.tenantId,
  });

  return {
    success: true,
    account: {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      tenantId: admin.tenantId,
    },
  };
}

// ─── Driver Account Operations ────────────────────────────────────────────

export async function createDriverAccount(
  name: string,
  pin: string,
  tenantId: string
): Promise<{ success: boolean; error?: string; account?: { id: string; name: string; active: boolean } }> {
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    return { success: false, error: "PIN must be exactly 4 digits" };
  }

  try {
    const db = scopedPrisma(tenantId);

    // Uniqueness is per-scope. A global check would leak the fact that another
    // ADMIN already employs a driver with this name.
    const existing = await db.driver.findFirst({ where: { name } });

    if (existing) {
      return { success: false, error: "A driver with this name already exists" };
    }

    const driver = await db.driver.create({
      data: {
        name,
        pinHash: hashPassword(pin),
      },
      select: { id: true, name: true, active: true },
    });

    await logAudit({
      action: "DRIVER_CREATE",
      entity: "driver",
      entityId: driver.id,
      userName: driver.name,
      details: `Driver created: ${driver.name}`,
      tenantId,
    });

    return { success: true, account: driver };
  } catch (err) {
    console.error("Failed to create driver:", err);
    return { success: false, error: "Failed to create driver account" };
  }
}

/**
 * Log a driver in by name + PIN, resolving their scope from the matched row.
 *
 * Driver names are unique only WITHIN a scope, so a name may exist in several
 * tenants. We therefore fetch every candidate with that name and accept the
 * login only if exactly one candidate's PIN verifies. Every failure path returns
 * the identical message, so the response can't be used to discover which names
 * exist, how many tenants hold them, or which ADMIN owns one.
 *
 * All PINs are verified before deciding, so response time does not depend on
 * which candidate matched.
 */
export async function loginDriver(
  name: string,
  pin: string
): Promise<{
  success: boolean;
  error?: string;
  account?: { id: string; name: string; active: boolean; tenantId: string };
}> {
  const GENERIC_ERROR = "Invalid name or PIN";

  // SCOPE-EXEMPT: pre-session. No scope exists yet; the scope is the *output* of
  // this function. Narrowed to a single row by PIN verification below, and
  // nothing about the non-matching candidates is ever returned.
  const candidates = await UNSAFE_unscopedPrisma.driver.findMany({
    where: { name },
  });

  const verified = candidates.filter((d) => verifyPassword(pin, d.pinHash));

  // 0 matches → wrong name or wrong PIN (indistinguishable, by design).
  // >1 matches → two tenants have a same-named driver sharing a PIN. Refusing
  // is the only safe answer: guessing would drop the driver into the wrong
  // ADMIN's scope and expose that ADMIN's deliveries.
  if (verified.length !== 1) {
    if (verified.length > 1) {
      console.error(
        `[auth] Ambiguous driver login for "${name}": ${verified.length} scopes matched the same PIN. Login refused.`
      );
    }
    return { success: false, error: GENERIC_ERROR };
  }

  const driver = verified[0];

  if (!driver.active) {
    return { success: false, error: "This driver account is deactivated" };
  }

  await logAudit({
    action: "LOGIN",
    entity: "driver",
    entityId: driver.id,
    userName: driver.name,
    details: "Driver login",
    tenantId: driver.tenantId,
  });

  return {
    success: true,
    account: {
      id: driver.id,
      name: driver.name,
      active: driver.active,
      tenantId: driver.tenantId,
    },
  };
}

export async function listDrivers(
  tenantId: string
): Promise<{ id: string; name: string; active: boolean; createdAt: Date }[]> {
  return scopedPrisma(tenantId).driver.findMany({
    select: {
      id: true,
      name: true,
      active: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });
}

export async function updateDriver(
  tenantId: string,
  id: string,
  updates: { name?: string; active?: boolean; pin?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    // Scoped read: a driver in another tenant is simply not found.
    const driver = await db.driver.findFirst({ where: { id } });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    if (updates.pin !== undefined) {
      if (updates.pin.length !== 4 || !/^\d{4}$/.test(updates.pin)) {
        return { success: false, error: "PIN must be exactly 4 digits" };
      }
    }

    // Renaming must not collide within the scope.
    if (updates.name !== undefined && updates.name !== driver.name) {
      const clash = await db.driver.findFirst({ where: { name: updates.name } });
      if (clash) {
        return { success: false, error: "A driver with this name already exists" };
      }
    }

    await db.driver.update({
      where: { id },
      data: {
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.active !== undefined && { active: updates.active }),
        ...(updates.pin !== undefined && { pinHash: hashPassword(updates.pin) }),
      },
    });

    await logAudit({
      action: "DRIVER_UPDATE",
      entity: "driver",
      entityId: id,
      userName: driver.name,
      details: JSON.stringify(Object.keys(updates)),
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to update driver:", err);
    return { success: false, error: "Failed to update driver" };
  }
}

export async function deleteDriver(
  tenantId: string,
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    const driver = await db.driver.findFirst({ where: { id } });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    await db.driver.delete({ where: { id } });

    await logAudit({
      action: "DRIVER_DELETE",
      entity: "driver",
      entityId: id,
      userName: driver.name,
      details: `Driver deleted: ${driver.name}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete driver:", err);
    return { success: false, error: "Failed to delete driver" };
  }
}

/**
 * Total admin accounts across the installation. Used only to detect first-run
 * bootstrap, so it is deliberately global.
 */
export async function getAdminCount(): Promise<number> {
  // SCOPE-EXEMPT: installation-wide bootstrap check; returns a count, no rows.
  return UNSAFE_unscopedPrisma.admin.count();
}
