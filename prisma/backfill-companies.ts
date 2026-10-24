/**
 * Create a company and attach branches to it, named by their ADMIN usernames
 * (migration 20261025120000 adds companies; it creates none).
 *
 *   npm run db:backfill-companies -- --company "Acme" --admins office.a,office.b
 *   npm run db:backfill-companies -- --company "Acme" --admins office.a,office.b --apply
 *
 * Dry run unless --apply. All or nothing: an unknown username, an account that
 * is not a branch ADMIN, or a branch that already belongs to another company
 * stops the run before anything is written. Idempotent: run it again and every
 * branch reports "already". The logic is backfillCompany() in lib/company.ts,
 * which the isolation suite exercises against a real database.
 *
 * It creates no COMPANY_ADMIN accounts — the SUPER_ADMIN does that, and
 * allocates branch admins to them, from the console.
 */

try { require("dotenv/config"); } catch {}

export {};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const APPLY = process.argv.includes("--apply");
const COMPANY = arg("company");
const ADMINS = arg("admins");

async function main() {
  if (!COMPANY || !ADMINS) {
    console.error(
      'Usage: npm run db:backfill-companies -- --company "<name>" --admins <username>,<username> [--apply]'
    );
    process.exit(2);
  }

  // Imported after dotenv so lib/db sees DATABASE_URL.
  const { backfillCompany } = await import("../lib/company");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing will be written. Re-run with `--apply` to commit.\n");
  }

  const result = await backfillCompany({
    companyName: COMPANY,
    usernames: ADMINS.split(","),
    apply: APPLY,
  });

  console.log(
    `Company "${result.companyName}": ${
      result.company.created ? (APPLY ? "created" : "would be created") : `exists (${result.company.id})`
    }`
  );
  console.log(
    `Company-home scope: ${
      result.homeTenant.created ? (APPLY ? "created" : "would be created") : `exists (${result.homeTenant.id})`
    }`
  );
  for (const b of result.branches) {
    const where = b.tenantName ? `${b.tenantName} (${b.tenantId})` : "—";
    const what =
      b.action === "refused"
        ? `REFUSED: ${b.reason}`
        : b.action === "already"
          ? "already attached"
          : APPLY
            ? "attached"
            : "would attach";
    console.log(`  @${b.username.padEnd(20)} ${where}  ${what}`);
  }

  if (result.branches.some((b) => b.action === "refused")) {
    console.log("\nNothing was written: fix the refused usernames and run again.");
    process.exit(1);
  }
  if (APPLY) console.log(`\nDone. Company id: ${result.company.id}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    const { UNSAFE_unscopedPrisma } = await import("../lib/db-scoped");
    await UNSAFE_unscopedPrisma.$disconnect();
  });
