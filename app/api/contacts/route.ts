import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

// ─── GET ──────────────────────────────────────────────────────────────────────

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search")?.trim() || "";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
  const missingEmail = searchParams.get("missingEmail") === "true";
  const skip = (page - 1) * limit;

  const where = {
    tenantId: ctx.tenantId,
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
    prisma.contact.findMany({
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
    prisma.contact.count({ where }),
  ]);

  return NextResponse.json({ contacts, total, page, limit });
});

// ─── POST ─────────────────────────────────────────────────────────────────────

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { companyName, contactPerson, email, phone, altPhone, address, notes } = body;

  if (!companyName?.trim()) {
    return NextResponse.json({ error: "companyName is required" }, { status: 400 });
  }

  const existing = await prisma.contact.findFirst({
    where: {
      tenantId: ctx.tenantId,
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

  const contact = await prisma.contact.create({
    data: {
      tenantId: ctx.tenantId,
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

  return NextResponse.json(contact, { status: 201 });
});
