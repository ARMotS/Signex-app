/**
 * Seed (or reset) one test account per role, for checking sign-in by hand on a
 * development or preview database:
 *
 *   SEED_TEST_ACCOUNTS=1 npx tsx scripts/seed-test-accounts.ts
 *
 * Creates, or resets the password of:
 *   test.super    SUPER_ADMIN, in the root scope
 *   test.office   ADMIN, owning its own "Signex Test Co" scope
 *   test.driver   DRIVER in that scope, with one stop on a trip sheet
 *   test.driver2  a second DRIVER in that scope, with a different stop — so you
 *                 can confirm each driver sees only their own run
 *
 * Passwords are random and printed once; run again to issue new ones.
 *
 * Refuses to run against production. It writes a SUPER_ADMIN, so it must never
 * be pointed at a database real people sign in to.
 */
try { require("dotenv/config"); } catch {}
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

if (process.env.SEED_TEST_ACCOUNTS !== "1") {
  console.error("Refusing to run: set SEED_TEST_ACCOUNTS=1 to confirm this is a test database.");
  process.exit(1);
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  console.error("Refusing to run in production.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

/** Same format as lib/accounts.ts — salt:scrypt-hash. */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

/** Random, and always meets the rules (8+ chars, a letter and a number). */
function newPassword(): string {
  return `${crypto.randomBytes(6).toString("base64url")}-${crypto.randomInt(10, 99)}a`;
}

async function claimUsername(username: string, owner: { adminId: string } | { driverId: string }) {
  const existing = await prisma.loginName.findUnique({ where: { username } });
  const ownerId = "adminId" in owner ? owner.adminId : owner.driverId;
  if (existing && existing.adminId !== ownerId && existing.driverId !== ownerId) {
    throw new Error(`"${username}" already belongs to a different account — not touching it.`);
  }
  await prisma.loginName.upsert({ where: { username }, update: {}, create: { username, ...owner } });
}

async function upsertAdmin(opts: {
  username: string;
  email: string;
  name: string;
  role: "SUPER_ADMIN" | "ADMIN";
  tenantId: string;
  password: string;
}) {
  const admin = await prisma.admin.upsert({
    where: { email: opts.email },
    update: { passwordHash: hashPassword(opts.password), active: true, sessionToken: null },
    create: {
      name: opts.name,
      email: opts.email,
      passwordHash: hashPassword(opts.password),
      tenantId: opts.tenantId,
    },
  });
  await prisma.user.upsert({
    where: { email: opts.email },
    update: { role: opts.role },
    create: { email: opts.email, name: opts.name, role: opts.role, tenantId: opts.tenantId },
  });
  await claimUsername(opts.username, { adminId: admin.id });
  return admin;
}

async function upsertDriverWithStop(opts: {
  username: string;
  name: string;
  tenantId: string;
  adminId: string;
  password: string;
  invoiceNumber: string;
  customerName: string;
}) {
  const driver = await prisma.driver.upsert({
    where: { tenantId_name: { tenantId: opts.tenantId, name: opts.name } },
    update: { passwordHash: hashPassword(opts.password), active: true, sessionToken: null },
    create: { name: opts.name, passwordHash: hashPassword(opts.password), tenantId: opts.tenantId },
  });
  await claimUsername(opts.username, { driverId: driver.id });

  const hasRun = await prisma.tripSheet.findFirst({ where: { driverId: driver.id } });
  if (!hasRun) {
    await prisma.tripSheet.create({
      data: {
        sourceFilename: `test-run-${opts.username}.csv`,
        uploadedBy: opts.adminId,
        adminId: opts.adminId,
        driverId: driver.id,
        regNo: "TEST-REG",
        tenantId: opts.tenantId,
        stops: {
          create: {
            stopNumber: 1,
            invoiceNumber: opts.invoiceNumber,
            customerName: opts.customerName,
            address: "1 Test Street",
          },
        },
      },
    });
  }
  return driver;
}

async function main() {
  const root = await prisma.tenant.upsert({
    where: { slug: "default" },
    update: {},
    create: { name: "Default", slug: "default" },
  });
  const testCo = await prisma.tenant.upsert({
    where: { slug: "signex-test-co" },
    update: {},
    create: { name: "Signex Test Co", slug: "signex-test-co", companyName: "Signex Test Co" },
  });

  const passwords = {
    super: newPassword(),
    office: newPassword(),
    driver: newPassword(),
    driver2: newPassword(),
  };

  await upsertAdmin({
    username: "test.super",
    email: "test.super@signex.test",
    name: "Test Super",
    role: "SUPER_ADMIN",
    tenantId: root.id,
    password: passwords.super,
  });
  const office = await upsertAdmin({
    username: "test.office",
    email: "test.office@signex.test",
    name: "Test Office",
    role: "ADMIN",
    tenantId: testCo.id,
    password: passwords.office,
  });
  await prisma.tenant.update({ where: { id: testCo.id }, data: { ownerAdminId: office.id } });

  await upsertDriverWithStop({
    username: "test.driver",
    name: "Test Driver One",
    tenantId: testCo.id,
    adminId: office.id,
    password: passwords.driver,
    invoiceNumber: "TEST-INV-1",
    customerName: "First Test Customer",
  });
  await upsertDriverWithStop({
    username: "test.driver2",
    name: "Test Driver Two",
    tenantId: testCo.id,
    adminId: office.id,
    password: passwords.driver2,
    invoiceNumber: "TEST-INV-2",
    customerName: "Second Test Customer",
  });

  console.log("\nTest accounts ready (passwords shown once):\n");
  console.table([
    { username: "test.super", role: "SUPER_ADMIN", lands: "/users", password: passwords.super },
    { username: "test.office", role: "ADMIN", lands: "/dashboard", password: passwords.office },
    { username: "test.driver", role: "DRIVER", lands: "/run", password: passwords.driver },
    { username: "test.driver2", role: "DRIVER", lands: "/run", password: passwords.driver2 },
  ]);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
