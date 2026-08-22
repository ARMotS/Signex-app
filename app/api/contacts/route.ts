import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { relinkUnmatchedStops, type RelinkSummary } from "@/lib/contact-matcher";

// ─── GET ──────────────────────────────────────────────────────────────────────

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search")?.trim() || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
  const missingEmail = searchParams.get("missingEmail") === "true";
  const skip = (page - 1) * limit;

  // The scoped client injects tenantId — search can only ever match names,
  // phone numbers and emails inside this ADMIN's own scope.
  const where = {
    deletedAt: null,
    ...(missingEmail && { email: null }),
    ...(search && {
      OR: [
        { companyName: { contains: search, mode: "insensitive" as const } },
        { contactPerson: { contains: search, mode: "insensitive" as const } },
        { email: { contains: search, mode: "insensitive" as const } },
      ],
    }),
  };

  const [contacts, total] = await Promise.all([
    ctx.db.contact.findMany({
      where,
      skip,
      take: limit,
      orderBy: { companyName: "asc" },
      select: {
        id: true,
        companyName: true,
        contactPerson: true,
        email: true,
        phone: true,
        altPhone: true,
        address: true,
        notes: true,
        source: true,
        createdAt: true,
        _count: { select: { stops: true } },
      },
    }),
    ctx.db.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, total, page, limit });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { companyName, contactPerson, email, phone, altPhone, address, notes } = body;

  if (!companyName?.trim()) {
    return NextResponse.json({ error: "companyName is required" }, { status: 400 });
  }

  const existing = await ctx.db.contact.findFirst({
    where: {
      companyName: { equals: companyName.trim(), mode: "insensitive" },
      deletedAt: null,
    },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A contact with this company name already exists", existing },
      { status: 409 }
    );
  }

  const contact = await ctx.db.contact.create({
    data: {
      companyName: companyName.trim(),
      contactPerson: contactPerson?.trim() || null,
      email: email?.trim().toLowerCase() || null,
      phone: phone?.trim() || null,
      altPhone: altPhone?.trim() || null,
      address: address?.trim() || null,
      notes: notes?.trim() || null,
      source: "MANUAL",
    },
  });

  // A delivery may already be signed and waiting on exactly this contact.
  // Best-effort: the contact is saved either way, and a re-link problem must
  // never turn a successful add into an error the admin has to decipher.
  let relinked: RelinkSummary = { linked: 0, nowSendable: 0, sendableStopIds: [] };
  try {
    relinked = await relinkUnmatchedStops(ctx.tenantId);
  } catch (err) {
    console.error("[contacts] Could not re-link stops after adding a contact:", err);
  }

  return NextResponse.json({ ...contact, relinked }, { status: 201 });
});
