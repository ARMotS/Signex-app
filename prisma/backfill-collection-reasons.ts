/**
 * Put back collection sheet lines the old reader misfiled. The Reason cell
 * starts right after Returned, left of where that reader looked, so a typed
 * reason became a third text column: the product description landed in
 * shortName, the reason in description, and reasonCode stayed empty (or took a
 * number from inside the reason).
 *
 *   npm run db:backfill-collection-reasons           # dry run, shows what it would change
 *   npm run db:backfill-collection-reasons -- --apply
 *
 * Idempotent: a repaired line has no shortName, so a second run reports 0. Each
 * write is conditional on the line still holding what was read. Lines outlive
 * their trips, so closed-out collections are repaired too. Signed PDFs already
 * filed are the record and are not touched.
 *
 * The rule is misreadSheetLine (lib/collection-confirm.ts). Read the samples the
 * dry run prints before applying: a sheet with a real short-name column and a
 * blank Reason looks the same, and would need leaving out.
 */

try { require("dotenv/config"); } catch {}

// A module, not a global script: nothing else is imported at the top level
// (lib/ is imported after dotenv, below).
export {};

const APPLY = process.argv.includes("--apply");
const SAMPLES_PER_SCOPE = 5;

async function main() {
  // Imported after dotenv so lib/db sees DATABASE_URL.
  const { UNSAFE_unscopedPrisma, scopedPrisma } = await import("../lib/db-scoped");
  const { misreadSheetLine } = await import("../lib/collection-confirm");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing will be written. Re-run with `-- --apply` to commit.\n");
  }

  // SCOPE-EXEMPT: migration script — walks the Tenant registry so the backfill
  // runs once per scope. Every read and write below is scoped to one tenant.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let total = 0;
  let skipped = 0;
  for (const tenant of tenants) {
    const db = scopedPrisma(tenant.id);
    const lines = await db.collectionLine.findMany({
      where: { shortName: { not: null } },
      select: { id: true, itemCode: true, description: true, shortName: true, reasonCode: true },
    });
    const misread = lines.flatMap((line) => {
      const fix = misreadSheetLine(line);
      return fix ? [{ line, fix }] : [];
    });
    if (misread.length === 0) continue;

    let changed = 0;
    for (const { line, fix } of misread) {
      if (!APPLY) {
        changed += 1;
        continue;
      }
      const res = await db.collectionLine.updateMany({
        where: { id: line.id, reasonCode: line.reasonCode, description: line.description, shortName: line.shortName },
        data: fix,
      });
      if (res.count > 0) changed += 1;
      else skipped += 1;
    }
    total += changed;

    console.log(`${APPLY ? "[apply]" : "[dry-run]"} ${tenant.name} (${tenant.id}): ${changed} lines`);
    for (const { line, fix } of misread.slice(0, SAMPLES_PER_SCOPE)) {
      console.log(`    ${line.itemCode ?? "(no product no)"}: description "${fix.description}", reason "${fix.reasonCode}"`);
    }
  }

  console.log(`\n${APPLY ? "Repaired" : "Would repair"} ${total} lines.`);
  if (skipped > 0) console.log(`${skipped} changed while this ran and were left alone. Run again to check them.`);

  await UNSAFE_unscopedPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
