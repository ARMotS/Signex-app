/**
 * Fill Stop.invoiceNoNormalized and Collection.invoiceNoNormalized for rows
 * written before the columns existed (migration 20261017130000).
 *
 *   npm run db:backfill-invoice-no           # dry run, reports what it would change
 *   npm run db:backfill-invoice-no -- --apply
 *
 * Idempotent: it rewrites only rows whose stored value disagrees with their
 * scope's current pattern, so a second run reports 0. It is the same function
 * Settings runs when a pattern changes (renormalizeInvoiceNumbers), so the
 * backfill and the app cannot disagree about a value.
 *
 * Only live rows are touched. Completed trips are JSON snapshots, normalized on
 * read.
 */

try { require("dotenv/config"); } catch {}

// A module, not a global script: nothing else is imported at the top level
// (lib/ is imported after dotenv, below).
export {};

const APPLY = process.argv.includes("--apply");

async function main() {
  // Imported after dotenv so lib/db sees DATABASE_URL.
  const { UNSAFE_unscopedPrisma } = await import("../lib/db-scoped");
  const { readInvoiceNoPattern } = await import("../lib/config");
  const { renormalizeInvoiceNumbers } = await import("../lib/trip-data");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing will be written. Re-run with `-- --apply` to commit.\n");
  }

  // SCOPE-EXEMPT: migration script — walks the Tenant registry so the backfill
  // runs once per scope. Every read and write below is scoped to one tenant.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let stops = 0;
  let collections = 0;
  for (const tenant of tenants) {
    const pattern = await readInvoiceNoPattern(tenant.id);
    const counts = await renormalizeInvoiceNumbers(tenant.id, pattern, { apply: APPLY });
    stops += counts.stops;
    collections += counts.collections;
    console.log(
      `${APPLY ? "[apply]" : "[dry-run]"} ${tenant.name} (${tenant.id}): ` +
        `${counts.stops} stops, ${counts.collections} collections` +
        (pattern ? ` — custom pattern ${pattern.source}` : "")
    );
  }

  console.log(`\n${APPLY ? "Updated" : "Would update"} ${stops} stops and ${collections} collections.`);

  if (APPLY) {
    // Post-condition: a dry run straight after must find nothing left to do.
    let left = 0;
    for (const tenant of tenants) {
      const counts = await renormalizeInvoiceNumbers(
        tenant.id,
        await readInvoiceNoPattern(tenant.id),
        { apply: false }
      );
      left += counts.stops + counts.collections;
    }
    if (left > 0) {
      console.error(`${left} rows still disagree — new rows arrived mid-run? Run again.`);
      process.exit(1);
    }
    console.log("Verified: every live row matches its scope's pattern.");
  }

  await UNSAFE_unscopedPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
