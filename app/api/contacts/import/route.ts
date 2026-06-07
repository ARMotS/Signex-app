import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseContactSheet } from "@/lib/contact-parser";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const confirm = formData.get("confirm") === "true";

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

  for (const contact of parsed) {
    const existing = await prisma.contact.findFirst({
      where: {
        tenantId: ctx.tenantId,
        companyName: { equals: contact.companyName.trim(), mode: "insensitive" },
        deletedAt: null,
      },
      select: { id: true },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.contact.create({
      data: {
        tenantId: ctx.tenantId,
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

  return NextResponse.json({ saved, skipped });
});
