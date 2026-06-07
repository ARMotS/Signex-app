/**
 * Account management — PostgreSQL via Prisma.
 * Supports admin accounts (email/password) and driver accounts (name/PIN).
 * Passwords are hashed with Node.js crypto scrypt.
 */

import crypto from "crypto";
import { prisma } from "./db";
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
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === computed;
}

// ─── Admin Account Operations ─────────────────────────────────────────────

export async function createAdminAccount(
  name: string,
  email: string,
  password: string
): Promise<{ success: boolean; error?: string; account?: { id: string; name: string; email: string } }> {
  try {
    const existing = await prisma.admin.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return { success: false, error: "An account with this email already exists" };
    }

    const admin = await prisma.admin.create({
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
    });

    return { success: true, account: admin };
  } catch (err) {
    console.error("Failed to create admin:", err);
    return { success: false, error: "Failed to create account" };
  }
}

export async function loginAdmin(
  email: string,
  password: string
): Promise<{ success: boolean; error?: string; account?: { id: string; name: string; email: string } }> {
  const admin = await prisma.admin.findUnique({
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
  });

  return {
    success: true,
    account: { id: admin.id, name: admin.name, email: admin.email },
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
    const existing = await prisma.driver.findUnique({
      where: { name },
    });

    if (existing) {
      return { success: false, error: "A driver with this name already exists" };
    }

    const driver = await prisma.driver.create({
      data: {
        name,
        pinHash: hashPassword(pin),
        tenantId,
      },
      select: { id: true, name: true, active: true },
    });

    await logAudit({
      action: "DRIVER_CREATE",
      entity: "driver",
      entityId: driver.id,
      userName: driver.name,
      details: `Driver created: ${driver.name}`,
    });

    return { success: true, account: driver as any };
  } catch (err) {
    console.error("Failed to create driver:", err);
    return { success: false, error: "Failed to create driver account" };
  }
}

export async function loginDriver(
  name: string,
  pin: string
): Promise<{ success: boolean; error?: string; account?: { id: string; name: string; active: boolean; tenantId: string } }> {
  const driver = await prisma.driver.findUnique({
    where: { name },
  });

  if (!driver) {
    return { success: false, error: "Driver not found" };
  }

  if (!driver.active) {
    return { success: false, error: "This driver account is deactivated" };
  }

  if (!verifyPassword(pin, driver.pinHash)) {
    return { success: false, error: "Incorrect PIN" };
  }

  await logAudit({
    action: "LOGIN",
    entity: "driver",
    entityId: driver.id,
    userName: driver.name,
    details: "Driver login",
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

export async function listDrivers(): Promise<
  { id: string; name: string; active: boolean; createdAt: Date }[]
> {
  return prisma.driver.findMany({
    select: {
      id: true,
      name: true,
      active: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  }) as any;
}

export async function updateDriver(
  id: string,
  updates: { name?: string; active?: boolean; pin?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    if (updates.pin !== undefined) {
      if (updates.pin.length !== 4 || !/^\d{4}$/.test(updates.pin)) {
        return { success: false, error: "PIN must be exactly 4 digits" };
      }
    }

    await prisma.driver.update({
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
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to update driver:", err);
    return { success: false, error: "Failed to update driver" };
  }
}

export async function deleteDriver(
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    await prisma.driver.delete({ where: { id } });

    await logAudit({
      action: "DRIVER_DELETE",
      entity: "driver",
      entityId: id,
      userName: driver.name,
      details: `Driver deleted: ${driver.name}`,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete driver:", err);
    return { success: false, error: "Failed to delete driver" };
  }
}

export async function getAdminCount(): Promise<number> {
  return prisma.admin.count();
}


