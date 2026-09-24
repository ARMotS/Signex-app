/**
 * Integration test harness: two fully-populated, independent ADMIN scopes plus a
 * SUPER_ADMIN, and a way to invoke route handlers with a synthetic session.
 *
 * Requires TEST_DATABASE_URL pointing at a THROWAWAY database — the fixtures
 * truncate every table. tests/setup.ts redirects DATABASE_URL to it so a real
 * database can never be hit by accident.
 */

import { vi } from "vitest";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { encryptToken } from "@/lib/crypto";

export const HAS_TEST_DB = !!process.env.TEST_DATABASE_URL;

let pool: pg.Pool | undefined;
let client: PrismaClient | undefined;

export function db(): PrismaClient {
  if (!client) {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
  }
  return client;
}

export async function disconnect() {
  await client?.$disconnect();
  await pool?.end();
  client = undefined;
  pool = undefined;
}

function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(secret, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export async function resetDatabase() {
  const p = db();
  // Order matters: children before parents.
  await p.collection.deleteMany();
  await p.stop.deleteMany();
  await p.tripSheet.deleteMany();
  await p.completedTripSheet.deleteMany();
  await p.contact.deleteMany();
  await p.importedFile.deleteMany();
  await p.cloudAccount.deleteMany();
  await p.appConfig.deleteMany();
  await p.auditLog.deleteMany();
  await p.driver.deleteMany();
  await p.user.deleteMany();
  await p.tenant.update({ where: { slug: "root" }, data: {} }).catch(() => {});
  await p.tenant.updateMany({ data: { ownerAdminId: null } });
  await p.admin.deleteMany();
  await p.tenant.deleteMany();
}

export interface ScopeFixture {
  tenantId: string;
  admin: { id: string; name: string; email: string };
  driver: { id: string; name: string };
  contact: { id: string; companyName: string };
  tripSheet: { id: string };
  stop: { id: string; invoiceNumber: string };
  collection: { id: string; collectionNo: string };
}

export interface Fixtures {
  a: ScopeFixture;
  b: ScopeFixture;
  superAdmin: { id: string; name: string; email: string; tenantId: string };
}

/**
 * Build two independent scopes with deliberately COLLIDING data — the same
 * driver name, the same company name, the same invoice number, the same
 * collection number — so that any test which passes could only pass because of
 * scoping, not because the values differ.
 */
export async function seedFixtures(): Promise<Fixtures> {
  const p = db();
  await resetDatabase();

  const rootTenant = await p.tenant.create({
    data: { name: "Root", slug: "root" },
  });

  const superAdminRow = await p.admin.create({
    data: {
      name: "Super Admin",
      email: "super@example.test",
      passwordHash: hashSecret("supersecret"),
      tenantId: rootTenant.id,
    },
  });
  await p.tenant.update({
    where: { id: rootTenant.id },
    data: { ownerAdminId: superAdminRow.id },
  });
  await p.user.create({
    data: {
      email: "super@example.test",
      name: "Super Admin",
      role: "SUPER_ADMIN",
      tenantId: rootTenant.id,
    },
  });

  const build = async (label: string): Promise<ScopeFixture> => {
    const tenant = await p.tenant.create({
      data: { name: `Scope ${label}`, slug: `scope-${label.toLowerCase()}` },
    });

    const admin = await p.admin.create({
      data: {
        name: `Admin ${label}`,
        email: `admin-${label.toLowerCase()}@example.test`,
        passwordHash: hashSecret("password123"),
        tenantId: tenant.id,
      },
      select: { id: true, name: true, email: true },
    });
    await p.tenant.update({
      where: { id: tenant.id },
      data: { ownerAdminId: admin.id },
    });
    await p.user.create({
      data: {
        email: admin.email,
        name: admin.name,
        role: "ADMIN",
        tenantId: tenant.id,
      },
    });

    // Same name in both scopes — only scoping can keep them apart.
    const driver = await p.driver.create({
      data: {
        name: "Jane Delivery",
        // Different PINs, so driver login stays unambiguous.
        pinHash: hashSecret(label === "A" ? "1111" : "2222"),
        tenantId: tenant.id,
      },
      select: { id: true, name: true },
    });

    // Same company name in both scopes.
    const contact = await p.contact.create({
      data: {
        companyName: "Acme Trading",
        contactPerson: `Contact ${label}`,
        email: `acme-${label.toLowerCase()}@example.test`,
        phone: `+27 11 000 000${label === "A" ? "1" : "2"}`,
        tenantId: tenant.id,
      },
      select: { id: true, companyName: true },
    });

    const tripSheet = await p.tripSheet.create({
      data: {
        sourceFilename: `route-${label.toLowerCase()}.csv`,
        uploadedBy: admin.id,
        driverId: driver.id,
        regNo: `REG-${label}`,
        tenantId: tenant.id,
      },
      select: { id: true },
    });

    // Same invoice number in both scopes — invoice numbers are sequential per
    // company, so collisions across scopes are the normal case, not an edge case.
    const stop = await p.stop.create({
      data: {
        stopNumber: 1,
        invoiceNumber: "INV-1001",
        customerName: "Acme Trading",
        address: `${label} Street`,
        tripSheetId: tripSheet.id,
        tenantId: tenant.id,
      },
      select: { id: true, invoiceNumber: true },
    });

    // Same collection number in both scopes, for the same reason the invoice
    // number is the same: collection numbers are sequential per company, so a
    // collision across scopes is the normal case.
    const collection = await p.collection.create({
      data: {
        collectionNo: "COL-500",
        type: "CREDIT_RETURN",
        originalInvoiceNo: "INV-1001",
        expectedQty: 2,
        sourceFilePath: `COL-500-${label}.pdf`,
        tripSheetId: tripSheet.id,
        stopId: stop.id,
        tenantId: tenant.id,
      },
      select: { id: true, collectionNo: true },
    });

    await p.cloudAccount.create({
      data: {
        provider: "onedrive",
        accountEmail: `onedrive-${label.toLowerCase()}@example.test`,
        accountName: `OneDrive ${label}`,
        accessToken: encryptToken(`access-token-${label}`),
        refreshToken: encryptToken(`refresh-token-${label}`),
        tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
        folderItemId: `folder-item-${label}`,
        folderPath: `/TripSheets-${label}`,
        invoiceFolderItemId: `invoice-folder-${label}`,
        invoiceFolderPath: `/Invoices-${label}`,
        collectionsFolderItemId: `collections-folder-${label}`,
        collectionsFolderPath: `/Collections-${label}`,
        tenantId: tenant.id,
      },
    });

    await p.appConfig.createMany({
      data: [
        {
          tenantId: tenant.id,
          key: "invoiceFolderPath",
          value: `C:\\Invoices-${label}`,
        },
        {
          tenantId: tenant.id,
          key: "tripSheetFolderPath",
          value: `C:\\TripSheets-${label}`,
        },
        {
          tenantId: tenant.id,
          key: "collectionsFolderPath",
          value: `C:\\Collections-${label}`,
        },
      ],
    });

    return { tenantId: tenant.id, admin, driver, contact, tripSheet, stop, collection };
  };

  const a = await build("A");
  const b = await build("B");

  return {
    a,
    b,
    superAdmin: {
      id: superAdminRow.id,
      name: superAdminRow.name,
      email: superAdminRow.email,
      tenantId: rootTenant.id,
    },
  };
}

// ─── Synthetic sessions ───────────────────────────────────────────────────

export interface FakeSession {
  id: string;
  role: "admin" | "driver" | "super_admin";
  name: string;
  email?: string;
  tenantId?: string;
  viewTenantId?: string | null;
  sessionToken: string;
  exp: number;
}

export function adminSession(f: ScopeFixture): FakeSession {
  return {
    id: f.admin.id,
    role: "admin",
    name: f.admin.name,
    email: f.admin.email,
    tenantId: f.tenantId,
    viewTenantId: null,
    sessionToken: "test-token",
    exp: Date.now() + 3_600_000,
  };
}

export function driverSession(f: ScopeFixture): FakeSession {
  return {
    id: f.driver.id,
    role: "driver",
    name: f.driver.name,
    tenantId: f.tenantId,
    viewTenantId: null,
    sessionToken: "test-token",
    exp: Date.now() + 3_600_000,
  };
}

export function superAdminSession(
  f: Fixtures,
  viewTenantId: string | null = null
): FakeSession {
  return {
    id: f.superAdmin.id,
    role: "super_admin",
    name: f.superAdmin.name,
    email: f.superAdmin.email,
    tenantId: f.superAdmin.tenantId,
    viewTenantId,
    sessionToken: "test-token",
    exp: Date.now() + 3_600_000,
  };
}

/**
 * An ADMIN session that has been tampered with to carry a viewTenantId, proving
 * the field is ignored for any role other than SUPER_ADMIN.
 */
export function tamperedAdminSession(
  f: ScopeFixture,
  viewTenantId: string
): FakeSession {
  return { ...adminSession(f), viewTenantId };
}

/** Install a session for the duration of a test. */
export function useSession(session: FakeSession | null) {
  currentSession = session;
}

let currentSession: FakeSession | null = null;

/**
 * Stub lib/session so route handlers and getScope() resolve the synthetic
 * session. Called from the test file's top-level vi.mock factory.
 */
export function sessionMockFactory() {
  return {
    getSession: vi.fn(async () => currentSession),
    createSession: vi.fn(async () => {}),
    setViewScope: vi.fn(async (tenantId: string | null) => {
      if (currentSession) currentSession.viewTenantId = tenantId;
      return true;
    }),
    validateSessionToken: vi.fn(async () => true),
    destroySession: vi.fn(async () => {}),
  };
}

/** Build a minimal NextRequest-alike for a route handler. */
export function req(
  url: string,
  init?: { method?: string; body?: unknown }
): any {
  const full = url.startsWith("http") ? url : `http://localhost${url}`;
  const request = new Request(full, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined && {
      body: JSON.stringify(init.body),
      headers: { "Content-Type": "application/json" },
    }),
  });
  // Route handlers read request.nextUrl in a few places.
  Object.defineProperty(request, "nextUrl", {
    value: new URL(full),
    writable: false,
  });
  return request;
}

/**
 * Build a NextRequest-alike carrying a multipart body.
 *
 * File uploads cannot go through `req()` — that JSON-encodes its body, and a
 * route reading `request.formData()` would see nothing.
 */
export function formReq(
  url: string,
  form: FormData,
  method: string = "POST"
): any {
  const full = url.startsWith("http") ? url : `http://localhost${url}`;
  const request = new Request(full, { method, body: form });
  Object.defineProperty(request, "nextUrl", {
    value: new URL(full),
    writable: false,
  });
  return request;
}

/** A minimal but genuine PDF header — routes check for one before saving. */
export function pdfFile(name: string): File {
  return new File([Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n")], name, {
    type: "application/pdf",
  });
}

/** A trip sheet CSV naming one stop, for driver `driverName`. */
export function tripSheetCsv(
  driverName: string,
  invoiceNumber: string,
  regNo: string = "REG-X"
): File {
  const csv = [
    "Date,Driver,REGNO,Customer,INVOICENO,NOP",
    `2026-08-26,${driverName},${regNo},Acme Trading,${invoiceNumber},3`,
  ].join("\n");
  return new File([csv], "run.csv", { type: "text/csv" });
}

/**
 * A trip sheet CSV carrying a delivery and a collection at the same customer.
 * Used to prove a deployed collection lands in the uploader's scope and nowhere
 * else.
 */
export function tripSheetCsvWithCollection(
  driverName: string,
  invoiceNumber: string,
  collectionNo: string,
  regNo: string = "REG-X"
): File {
  const csv = [
    "Date,Driver,REGNO,Customer,INVOICENO,COLLECTNO,COLLECTTYPE,NOP",
    `2026-08-26,${driverName},${regNo},Acme Trading,${invoiceNumber},${collectionNo},Credit Return,3`,
  ].join("\n");
  return new File([csv], "run.csv", { type: "text/csv" });
}

export const params = <T extends object>(p: T) => ({ params: Promise.resolve(p) });
