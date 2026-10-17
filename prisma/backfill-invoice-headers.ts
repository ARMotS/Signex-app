/**
 * Register every invoice already in each scope's invoice folder and read its
 * header (invoice date, Deliver to, Invoice to) — the one-off for invoices that
 * existed before the registry (migration 20261017140000).
 *
 *   npm run db:backfill-invoice-headers           # dry run: counts only
 *   npm run db:backfill-invoice-headers -- --apply
 *
 * After it, nothing needs running again: the Invoices page, deploys and
 * uploads keep the registry current, and each header is read once.
 *
 * Idempotent and resumable. Each PDF is downloaded and read on this machine;
 * only a scan with no text layer is sent to Claude, which needs
 * ANTHROPIC_API_KEY (without it those invoices are recorded as unread and can
 * be filled in by hand on the Invoices page).
 */

try { require("dotenv/config"); } catch {}

// A module, not a global script: nothing else is imported at the top level
// (lib/ is imported after dotenv, below).
export {};

const APPLY = process.argv.includes("--apply");
const BATCH = 25;

async function main() {
  // Imported after dotenv so lib/db sees DATABASE_URL.
  const { UNSAFE_unscopedPrisma, scopedPrisma } = await import("../lib/db-scoped");
  const { readInvoiceNoPattern } = await import("../lib/config");
  const { listInvoiceFiles } = await import("../lib/invoices");
  const { ensureInvoices, fillInvoiceHeaders } = await import("../lib/invoice-registry");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing will be written or downloaded. Re-run with `-- --apply`.\n");
  }

  // SCOPE-EXEMPT: migration script — walks the Tenant registry so the backfill
  // runs once per scope. Every read and write below is scoped to one tenant.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  for (const tenant of tenants) {
    const files = await listInvoiceFiles(tenant.id);
    const db = scopedPrisma(tenant.id);

    if (!APPLY) {
      const unread = await db.invoice.count({ where: { headerSource: null } });
      console.log(`[dry-run] ${tenant.name}: ${files.length} PDFs in the folder, ${unread} registered invoices unread`);
      continue;
    }

    await ensureInvoices(
      tenant.id,
      files.map((f) => ({ invoiceNo: f.name, pdfFilename: f.filename })),
      await readInvoiceNoPattern(tenant.id),
      { fileAuthority: "fill" }
    );

    let read = 0;
    let failed = 0;
    // Each pass bumps the attempt count of what it touched, so the loop ends:
    // an invoice that cannot be read drops out after its last attempt.
    for (;;) {
      const batch = await fillInvoiceHeaders(tenant.id, { limit: BATCH });
      read += batch.read;
      failed += batch.failed;
      if (batch.read + batch.failed === 0) break;
      process.stdout.write(`\r[apply] ${tenant.name}: ${read} read, ${failed} failed…`);
    }
    const left = await db.invoice.count({ where: { headerSource: null, pdfFilename: { not: null } } });
    console.log(`\r[apply] ${tenant.name}: ${files.length} PDFs — ${read} headers read, ${left} left unread`);
    if (left > 0) {
      const sample = await db.invoice.findMany({
        where: { headerSource: null, pdfFilename: { not: null } },
        select: { invoiceNo: true, headerError: true },
        take: 5,
      });
      for (const s of sample) console.log(`    ${s.invoiceNo}: ${s.headerError ?? "not attempted"}`);
    }
  }

  await UNSAFE_unscopedPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
