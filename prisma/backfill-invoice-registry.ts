/**
 * Register every invoice already out on a trip, in the archive or on a courier
 * sheet that has no `Invoice` row yet: the one-off for deliveries deployed
 * before the registry (migration 20261017140000). The invoice picker and the
 * allocation state (lib/invoice-allocation.ts) start from the registry.
 *
 *   npm run db:backfill-invoice-registry           # dry run: counts only
 *   npm run db:backfill-invoice-registry -- --apply
 *
 * Only creates rows. An invoice already registered is left exactly as it is
 * (its customer and PDF stay what the latest sheet or the folder said). A new
 * row takes the customer from the newest trip naming it, and a PDF filename
 * only from a live stop, which matched one at deploy; an archived delivery's
 * file may have gone, and the Invoices page fills the name in when it lists
 * the folder. Idempotent: a second run finds nothing to do. Nothing is
 * downloaded and no header is read — `db:backfill-invoice-headers` does that.
 */

try { require("dotenv/config"); } catch {}

// A module, not a global script: nothing else is imported at the top level
// (lib/ is imported after dotenv, below).
export {};

const APPLY = process.argv.includes("--apply");
const ARCHIVE_PAGE = 200;

interface Ref {
  invoiceNo: string;
  pdfFilename: string | null;
  customerName: string | null;
}

async function main() {
  // Imported after dotenv so lib/db sees DATABASE_URL.
  const { UNSAFE_unscopedPrisma, scopedPrisma } = await import("../lib/db-scoped");
  const { readInvoiceNoPattern } = await import("../lib/config");
  const { normalizeInvoiceNo } = await import("../lib/invoice-number");
  const { ensureInvoices } = await import("../lib/invoice-registry");

  if (!APPLY) {
    console.log("\nDRY RUN — nothing will be written. Re-run with `-- --apply`.\n");
  }

  // SCOPE-EXEMPT: migration script — walks the Tenant registry so the backfill
  // runs once per scope. Every read and write below is scoped to one tenant.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  let totalMissing = 0;
  for (const tenant of tenants) {
    const db = scopedPrisma(tenant.id);
    const pattern = await readInvoiceNoPattern(tenant.id);

    // First reference wins (ensureInvoices keeps the first customer it sees),
    // so newest first: live stops, then the archive newest-completed first,
    // then courier lines.
    const refs = new Map<string, Ref>();
    const add = (invoiceNo: string | null | undefined, ref: Omit<Ref, "invoiceNo">) => {
      const raw = invoiceNo?.trim();
      if (!raw) return;
      const key = normalizeInvoiceNo(raw, pattern);
      if (!key || refs.has(key)) return;
      refs.set(key, { invoiceNo: raw, ...ref });
    };

    const stops = await db.stop.findMany({
      where: { invoiceNumber: { not: "" } },
      select: { invoiceNumber: true, invoiceFile: true, customerName: true },
      orderBy: { createdAt: "desc" },
    });
    for (const s of stops) add(s.invoiceNumber, { pdfFilename: s.invoiceFile, customerName: s.customerName });

    let archived = 0;
    for (let cursor: string | undefined; ; ) {
      const page = await db.completedTripSheet.findMany({
        select: { id: true, stops: true },
        orderBy: [{ completedAt: "desc" }, { id: "desc" }],
        take: ARCHIVE_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      archived += page.length;
      for (const trip of page) {
        const list = Array.isArray(trip.stops) ? (trip.stops as { invoiceNumber?: string; customerName?: string }[]) : [];
        for (const s of list) add(s.invoiceNumber, { pdfFilename: null, customerName: s.customerName ?? null });
      }
      cursor = page[page.length - 1].id;
    }

    const courier = await db.courierTripSheetInvoice.findMany({
      select: { invoiceNo: true, invoiceFile: true, courierSheet: { select: { customerName: true } } },
      orderBy: { createdAt: "desc" },
    });
    for (const c of courier) add(c.invoiceNo, { pdfFilename: c.invoiceFile, customerName: c.courierSheet.customerName });

    const keys = [...refs.keys()];
    const existing = new Set<string>();
    for (let i = 0; i < keys.length; i += 1000) {
      const rows = await db.invoice.findMany({
        where: { invoiceNoNormalized: { in: keys.slice(i, i + 1000) } },
        select: { invoiceNoNormalized: true },
      });
      for (const r of rows) existing.add(r.invoiceNoNormalized);
    }
    const missing = keys.filter((k) => !existing.has(k));
    totalMissing += missing.length;

    const summary =
      `${tenant.name}: ${keys.length} invoices named (${stops.length} live stops, ${archived} archived trips, ` +
      `${courier.length} courier lines) — ${missing.length} not registered`;
    if (!APPLY || missing.length === 0) {
      console.log(`[${APPLY ? "apply" : "dry-run"}] ${summary}`);
      if (missing.length > 0) {
        console.log(`    e.g. ${missing.slice(0, 8).map((k) => refs.get(k)!.invoiceNo).join(", ")}`);
      }
      continue;
    }

    // Missing ones only: an existing row's customer and file stay as they are.
    for (let i = 0; i < missing.length; i += 500) {
      await ensureInvoices(
        tenant.id,
        missing.slice(i, i + 500).map((k) => ({ ...refs.get(k)!, stubIfNew: false })),
        pattern,
        { fileAuthority: "fill" }
      );
    }
    const left = await db.invoice.count({ where: { invoiceNoNormalized: { in: missing } } });
    console.log(`[apply] ${summary} — registered ${left}`);
  }

  console.log(`\n${APPLY ? "Done" : "Would register"}: ${totalMissing} invoice(s) across ${tenants.length} scope(s).`);
  await UNSAFE_unscopedPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
