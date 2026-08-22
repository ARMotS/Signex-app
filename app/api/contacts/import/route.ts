import { NextRequest, NextResponse } from "next/server";
import { parseContactSheet } from "@/lib/contact-parser";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { relinkUnmatchedStops, type RelinkSummary } from "@/lib/contact-matcher";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const confirm = formData.get("confirm") === "true";
  const overwrite = formData.get("overwrite") === "true";

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10 MB)" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseContactSheet(buffer, file.type, file.name);

  if (!confirm) {
    return NextResponse.json({ preview: parsed, count: parsed.length });
  }

  let saved = 0;
  let skipped = 0;
  let updated = 0;

  for (const contact of parsed) {
    // Duplicate detection is per-scope: importing a company another ADMIN
    // already has must still create a contact here.
    const existing = await ctx.db.contact.findFirst({
      where: {
        companyName: { equals: contact.companyName.trim(), mode: "insensitive" },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (existing) {
      if (overwrite) {
        await ctx.db.contact.update({
          where: { id: existing.id },
          data: {
            contactPerson: contact.contactPerson?.trim() || undefined,
            email: contact.email?.trim().toLowerCase() || undefined,
            phone: contact.phone?.trim() || undefined,
            altPhone: contact.altPhone?.trim() || undefined,
            address: contact.address?.trim() || undefined,
            notes: contact.notes?.trim() || undefined,
          },
        });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    await ctx.db.contact.create({
      data: {
        companyName: contact.companyName.trim(),
        contactPerson: contact.contactPerson?.trim() || null,
        email: contact.email?.trim().toLowerCase() || null,
        phone: contact.phone?.trim() || null,
        altPhone: contact.altPhone?.trim() || null,
        address: contact.address?.trim() || null,
        notes: contact.notes?.trim() || null,
        source: "SPREADSHEET",
      },
    });
    saved++;
  }

  // Run once for the whole file, not per contact: an import is exactly the case
  // where a batch of signed deliveries is waiting on customers that did not
  // exist yet. Best-effort — the contacts are saved regardless.
  let relinked: RelinkSummary = { linked: 0, nowSendable: 0, sendableStopIds: [] };
  try {
    relinked = await relinkUnmatchedStops(ctx.tenantId);
  } catch (err) {
    console.error("[contacts/import] Could not re-link stops after import:", err);
  }

  return NextResponse.json({ saved, skipped, updated, relinked });
});
