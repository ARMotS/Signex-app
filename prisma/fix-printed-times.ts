/**
 * Correct the UTC times printed on documents filed before the fix (PR #66):
 * signed invoices (and their exceptions page), collection receipts (and the
 * CREDIT NOTE REFERENCE page appended to them), and credit note sign-off
 * pages. A 09:35 signature was printed as 07:35.
 *
 *   npm run db:fix-printed-times                                   # dry run, every scope
 *   npm run db:fix-printed-times -- --tenant "electro city" --file 644690   # narrow it
 *   npm run db:fix-printed-times -- --apply --limit 1              # one file, then look
 *   npm run db:fix-printed-times -- --apply
 *
 * Run it AFTER the fix is deployed, so nothing signed meanwhile is missed.
 *
 * Safe to repeat, and safe on files signed after the fix: a time is changed
 * only when it equals the document's own true instant written in UTC — the
 * invoice's `Signed:<ISO>` subject, the collection's collectedAt, the credit
 * note's signedAt (lib/printed-time-fix.ts). Anything else is left and listed.
 *
 * Before each write the original is saved under --backup-dir (default
 * ./printed-time-backup/, git-ignored). Each write is conditional on the file
 * not having changed since it was read (If-Match), and sets the file's
 * modified time back — the Invoices tab and Backups read it as the signing
 * time. The run reports if OneDrive did not keep it; do the trial with
 * `--limit 1` and check that line before the full run.
 *
 * OneDrive scopes only: a local-folder scope is not reachable from here.
 * Emails already sent cannot be corrected.
 */

try { require("dotenv/config"); } catch {}

export {};

import fs from "fs";
import path from "path";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const TENANT = opt("--tenant")?.toLowerCase();
const FILE = opt("--file")?.toLowerCase();
const LIMIT = opt("--limit") ? Number(opt("--limit")) : Infinity;
const BACKUP_DIR = path.resolve(opt("--backup-dir") ?? "printed-time-backup");
const KINDS = (opt("--only") ?? "invoices,receipts,credits").split(",");

type Kind = "invoices" | "receipts" | "credits";

async function main() {
  const { UNSAFE_unscopedPrisma, scopedPrisma } = await import("../lib/db-scoped");
  const graph = await import("../lib/microsoft-graph");
  const { correctPrintedTimes, signedInstantOf } = await import("../lib/printed-time-fix");
  const { logAudit } = await import("../lib/audit");

  console.log(APPLY ? `\nAPPLYING. Originals are saved to ${BACKUP_DIR}\n` : "\nDRY RUN — nothing will be written. Re-run with `-- --apply` to commit.\n");

  // SCOPE-EXEMPT: migration script — walks the Tenant registry so the fix runs
  // once per scope. Every read and write below uses that one scope's client
  // and that scope's own OneDrive token.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });

  const totals = { files: 0, toFix: 0, written: 0, changedMeanwhile: 0, modifiedNotKept: 0, manual: 0, unexplained: 0, noInstant: 0, errors: 0 };
  let writesLeft = LIMIT;

  for (const tenant of tenants) {
    if (TENANT && !tenant.name.toLowerCase().includes(TENANT) && tenant.id !== TENANT) continue;
    const db = scopedPrisma(tenant.id);
    const account = await db.cloudAccount.findFirst({ where: { provider: "onedrive" }, select: { id: true } });
    if (!account) continue;
    if (!(await graph.getValidAccessToken(tenant.id).catch(() => null))) {
      console.log(`! ${tenant.name}: OneDrive token not usable — skipped`);
      totals.errors += 1;
      continue;
    }
    console.log(`== ${tenant.name} (${tenant.id})`);

    // The true instants each kind of document printed, keyed by filename.
    const instantsFor: Record<Kind, (name: string, pdf: Buffer) => Promise<Date[]>> = {
      invoices: async (_name, pdf) => {
        const at = await signedInstantOf(pdf);
        return at ? [at] : [];
      },
      receipts: async (name) => {
        const cols = await db.collection.findMany({
          where: { signedFilePath: { equals: name, mode: "insensitive" } },
          select: { collectedAt: true, creditNoteLinks: { select: { creditNote: { select: { signedAt: true } } } } },
        });
        return cols.flatMap((c) => [c.collectedAt, ...c.creditNoteLinks.map((l) => l.creditNote.signedAt)]).filter((d): d is Date => !!d);
      },
      credits: async (name) => {
        const notes = await db.creditNote.findMany({
          where: { signedFilename: { equals: name, mode: "insensitive" } },
          select: { signedAt: true },
        });
        return notes.map((n) => n.signedAt).filter((d): d is Date => !!d);
      },
    };
    const lister: Record<Kind, () => Promise<{ id: string; name: string }[]>> = {
      invoices: () => graph.listOneDriveSignedInvoices(tenant.id),
      receipts: () => graph.listOneDriveSignedCollections(tenant.id),
      credits: () => graph.listOneDriveSignedCreditNotes(tenant.id),
    };

    for (const kind of KINDS as Kind[]) {
      if (!lister[kind]) continue;
      let items: { id: string; name: string }[];
      try {
        items = await lister[kind]();
      } catch (err) {
        console.log(`  ! ${kind}: could not list — ${err instanceof Error ? err.message : err}`);
        totals.errors += 1;
        continue;
      }
      if (FILE) items = items.filter((i) => i.name.toLowerCase().includes(FILE));

      for (const item of items) {
        totals.files += 1;
        try {
          // The version first, so the write below is conditional on exactly
          // the bytes this run read.
          const version = await graph.getDriveItemVersion(tenant.id, item.id);
          const pdf = await graph.downloadFileById(tenant.id, item.id);
          const instants = await instantsFor[kind](item.name, pdf);
          if (instants.length === 0) {
            totals.noInstant += 1;
            continue; // e.g. a courier-stamped copy: its times were always SA time
          }
          const r = await correctPrintedTimes(pdf, instants);
          totals.manual += r.manual.length;
          totals.unexplained += r.unexplained.length;
          for (const m of r.manual) console.log(`  ? ${kind}/${item.name}: ${m} — month changes, fix by hand`);
          for (const u of r.unexplained) console.log(`  ? ${kind}/${item.name}: "${u}" matches no known instant — left`);
          if (!r.pdf) continue;

          totals.toFix += 1;
          console.log(`  ${APPLY && writesLeft > 0 ? "fix" : "would fix"} ${kind}/${item.name}: ${r.fixed.join("; ")}`);
          if (!APPLY || writesLeft <= 0) continue;

          const backup = path.join(BACKUP_DIR, tenant.id, kind, item.name);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          fs.writeFileSync(backup, pdf);

          const keep = version.fileSystemInfo?.lastModifiedDateTime ?? version.lastModifiedDateTime;
          const res = await graph.replaceFileContentIfUnchanged(tenant.id, item.id, version.eTag, r.pdf, keep);
          if (!res.replaced) {
            totals.changedMeanwhile += 1;
            console.log(`    changed while this ran — left alone; run again`);
            continue;
          }
          writesLeft -= 1;
          totals.written += 1;
          if (res.lastModifiedDateTime && Date.parse(res.lastModifiedDateTime) !== Date.parse(version.lastModifiedDateTime)) {
            totals.modifiedNotKept += 1;
            console.log(`    ! OneDrive now reports modified ${res.lastModifiedDateTime} (was ${version.lastModifiedDateTime})`);
          }
          await logAudit({
            action: "UPLOAD",
            entity: kind === "invoices" ? "invoice" : kind === "receipts" ? "collection" : "credit_note",
            entityId: item.name,
            tenantId: tenant.id,
            actor: null,
            metadata: { reason: "printed-time-fix", file: item.name, fixed: r.fixed },
          });
        } catch (err) {
          totals.errors += 1;
          console.log(`  ! ${kind}/${item.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  console.log(`
Files read:              ${totals.files}
${APPLY ? "Corrected:              " : "Would correct:          "} ${APPLY ? totals.written : totals.toFix}${APPLY && totals.toFix > totals.written ? ` (of ${totals.toFix} needing it; --limit or changed meanwhile)` : ""}
No true instant on file: ${totals.noInstant}   (nothing to check against — left)
Fix by hand (month):     ${totals.manual}
Unexplained times:       ${totals.unexplained}   (left)
Changed while running:   ${totals.changedMeanwhile}
Modified time not kept:  ${totals.modifiedNotKept}
Errors:                  ${totals.errors}`);

  await UNSAFE_unscopedPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
