/**
 * One-time backfill for strict per-ADMIN data isolation.
 *
 * Run ONCE, after `prisma migrate deploy` applies the new schema and before the
 * app serves traffic on it:
 *
 *   npm run db:backfill-isolation           # dry run, reports what it would do
 *   npm run db:backfill-isolation -- --apply
 *
 * What it does
 * ────────────
 *  1. Gives every ADMIN its own Tenant. Previously all admins shared the
 *     "default" tenant because signup and /api/admin/users both copied the
 *     creator's tenantId — the root cause of cross-ADMIN visibility.
 *  2. Keeps the first SUPER_ADMIN in the existing "default" tenant, which
 *     becomes the root scope.
 *  3. Leaves all existing drivers / trip sheets / stops / contacts in the root
 *     scope, so nothing moves under someone unexpected. The SUPER_ADMIN can
 *     view and reassign from there via the scope switcher.
 *  4. Stamps the previously-unscoped tables (AppConfig, CloudAccount,
 *     ImportedFile, AuditLog) with the root scope.
 *  5. Encrypts any plaintext OneDrive tokens (idempotent).
 *  6. Asserts post-conditions and refuses to report success if any fail.
 */

try { require("dotenv/config"); } catch {}
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import crypto from "crypto";
import { encryptToken, isEncrypted } from "../lib/crypto";

const APPLY = process.argv.includes("--apply");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const log = (msg: string) => console.log(`${APPLY ? "[apply]" : "[dry-run]"} ${msg}`);

async function main() {
  if (!APPLY) {
    console.log(
      "\nDRY RUN — nothing will be written. Re-run with `-- --apply` to commit.\n"
    );
  }

  // ── Root scope ─────────────────────────────────────────────────────
  let rootTenant = await prisma.tenant.findUnique({ where: { slug: "default" } });
  if (!rootTenant) {
    if (!APPLY) {
      console.error(
        'No tenant with slug "default" exists. Run `npm run db:seed` first so a root scope exists.'
      );
      process.exit(1);
    }
    rootTenant = await prisma.tenant.create({
      data: { name: "Default", slug: "default" },
    });
    log(`created root tenant ${rootTenant.id}`);
  }
  const rootId = rootTenant.id;
  log(`root scope: ${rootId} ("${rootTenant.name}")`);

  // ── 1. One tenant per ADMIN ────────────────────────────────────────
  const admins = await prisma.admin.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, tenantId: true },
  });

  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, tenantId: true },
  });
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  // The first SUPER_ADMIN (by creation order) keeps the root scope.
  const superAdmin =
    admins.find(
      (a) => userByEmail.get(a.email.toLowerCase())?.role === "SUPER_ADMIN"
    ) ?? admins[0];

  if (!superAdmin) {
    log("no admin accounts exist — nothing to split");
  } else {
    log(`SUPER_ADMIN keeps root scope: ${superAdmin.email}`);

    if (APPLY) {
      await prisma.admin.update({
        where: { id: superAdmin.id },
        data: { tenantId: rootId },
      });
      const su = userByEmail.get(superAdmin.email.toLowerCase());
      if (su) {
        await prisma.user.update({
          where: { id: su.id },
          data: { tenantId: rootId, role: "SUPER_ADMIN" },
        });
      }
      await prisma.tenant.update({
        where: { id: rootId },
        data: { ownerAdminId: superAdmin.id },
      });
    }
  }

  for (const admin of admins) {
    if (superAdmin && admin.id === superAdmin.id) continue;

    // Idempotent: skip an admin that already owns a non-root scope.
    if (admin.tenantId && admin.tenantId !== rootId && admin.tenantId !== "") {
      log(`skip ${admin.email} — already in its own scope ${admin.tenantId}`);
      continue;
    }

    const slug = `admin-${crypto.randomBytes(6).toString("hex")}`;
    log(`ADMIN ${admin.email} → NEW scope (slug ${slug})`);

    if (!APPLY) continue;

    const tenant = await prisma.tenant.create({
      data: { name: admin.name || admin.email, slug, ownerAdminId: admin.id },
    });

    // TripSheet.adminId composite-FKs to Admin[tenantId, id]. Existing trip
    // sheets stay in the root scope (see the header note), so once this admin
    // moves out, any "uploaded by admin X" attribution pointing at them from the
    // root scope can no longer be represented. Detach it rather than move the
    // trip sheet, which would hand another ADMIN's deliveries to this one.
    const detached = await prisma.tripSheet.updateMany({
      where: { adminId: admin.id },
      data: { adminId: null },
    });
    if (detached.count > 0) {
      log(
        `  detached adminId from ${detached.count} trip sheet(s) left behind in the root scope`
      );
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { tenantId: tenant.id },
    });

    const u = userByEmail.get(admin.email.toLowerCase());
    if (u) {
      await prisma.user.update({
        where: { id: u.id },
        data: { tenantId: tenant.id, role: "ADMIN" },
      });
    } else {
      await prisma.user.create({
        data: {
          email: admin.email.toLowerCase(),
          name: admin.name,
          role: "ADMIN",
          tenantId: tenant.id,
        },
      });
    }
  }

  // ── 2. Stamp previously-unscoped tables with the root scope ────────
  //
  // `tenantId: null` is only a legal filter on AuditLog — everywhere else the
  // column is non-nullable, so an unscoped row shows up as the empty-string
  // default rather than NULL.
  const orphanTables = [
    ["appConfig", prisma.appConfig, false],
    ["cloudAccount", prisma.cloudAccount, false],
    ["importedFile", prisma.importedFile, false],
    ["auditLog", prisma.auditLog, true],
  ] as const;

  for (const [name, delegate, nullable] of orphanTables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = delegate as any;
    const where = nullable
      ? { OR: [{ tenantId: null }, { tenantId: "" }] }
      : { tenantId: "" };

    const unscoped = await d.count({ where });
    if (unscoped === 0) {
      log(`${name}: already scoped`);
      continue;
    }
    log(`${name}: stamping ${unscoped} row(s) with root scope`);
    if (APPLY) {
      await d.updateMany({ where, data: { tenantId: rootId } });
    }
  }

  // Data tables should already carry the default tenant, but catch strays.
  const dataTables = [
    ["driver", prisma.driver],
    ["contact", prisma.contact],
    ["tripSheet", prisma.tripSheet],
    ["stop", prisma.stop],
    ["user", prisma.user],
    ["admin", prisma.admin],
  ] as const;

  for (const [name, delegate] of dataTables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = delegate as any;
    const blank = await d.count({ where: { tenantId: "" } });
    if (blank === 0) continue;
    log(`${name}: ${blank} row(s) with empty scope → root`);
    if (APPLY) {
      await d.updateMany({ where: { tenantId: "" }, data: { tenantId: rootId } });
    }
  }

  // ── 3. Encrypt any plaintext OneDrive tokens ───────────────────────
  const cloudAccounts = await prisma.cloudAccount.findMany({
    select: { id: true, accessToken: true, refreshToken: true },
  });

  for (const acct of cloudAccounts) {
    const needsAccess = !isEncrypted(acct.accessToken);
    const needsRefresh = !isEncrypted(acct.refreshToken);
    if (!needsAccess && !needsRefresh) continue;

    log(`cloudAccount ${acct.id}: encrypting stored tokens`);
    if (APPLY) {
      await prisma.cloudAccount.update({
        where: { id: acct.id },
        data: {
          ...(needsAccess && { accessToken: encryptToken(acct.accessToken) }),
          ...(needsRefresh && { refreshToken: encryptToken(acct.refreshToken) }),
        },
      });
    }
  }

  // ── 4. Post-conditions ─────────────────────────────────────────────
  if (!APPLY) {
    console.log("\nDry run complete. Re-run with `-- --apply` to commit.\n");
    return;
  }

  const failures: string[] = [];

  // Every ADMIN-role account must sit in a distinct scope.
  const adminUsers = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { email: true, tenantId: true },
  });
  const seen = new Map<string, string>();
  for (const u of adminUsers) {
    if (u.tenantId === rootId) {
      failures.push(`ADMIN ${u.email} is still in the root scope`);
      continue;
    }
    const prev = seen.get(u.tenantId);
    if (prev) {
      failures.push(`ADMINs ${prev} and ${u.email} share scope ${u.tenantId}`);
    }
    seen.set(u.tenantId, u.email);
  }

  // No blank scopes anywhere (AuditLog may legitimately be null, not blank).
  for (const [name, delegate] of [...dataTables, ...orphanTables]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blank = await (delegate as any).count({ where: { tenantId: "" } });
    if (blank > 0) failures.push(`${name}: ${blank} row(s) still have an empty scope`);
  }

  // No stop may reference a contact or trip sheet from another scope. The
  // composite FKs make this impossible going forward; this verifies the
  // pre-migration data too.
  const crossContact = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Stop" s JOIN "Contact" c ON s."contactId" = c."id"
    WHERE s."tenantId" <> c."tenantId"
  `;
  if (Number(crossContact[0]?.count ?? 0) > 0) {
    failures.push(`${crossContact[0].count} stop(s) reference a contact in another scope`);
  }

  const crossSheet = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Stop" s JOIN "TripSheet" t ON s."tripSheetId" = t."id"
    WHERE s."tenantId" <> t."tenantId"
  `;
  if (Number(crossSheet[0]?.count ?? 0) > 0) {
    failures.push(`${crossSheet[0].count} stop(s) reference a trip sheet in another scope`);
  }

  // All tokens encrypted.
  const plaintext = (
    await prisma.cloudAccount.findMany({ select: { id: true, accessToken: true } })
  ).filter((a) => !isEncrypted(a.accessToken));
  if (plaintext.length > 0) {
    failures.push(`${plaintext.length} cloud account(s) still hold plaintext tokens`);
  }

  if (failures.length > 0) {
    console.error("\n✗ Post-condition checks FAILED:");
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }

  console.log("\n✓ Backfill complete. All post-conditions passed.");
  console.log(`  Scopes: ${await prisma.tenant.count()}`);
  console.log(`  Root scope retains the existing drivers, trip sheets and contacts.`);
  console.log(`  Use the SUPER_ADMIN scope switcher to review each ADMIN's scope.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
