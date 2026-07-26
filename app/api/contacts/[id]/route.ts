import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

// ─── PATCH ────────────────────────────────────────────────────────────────────

export const PATCH = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await params;

  // Scoped read: a contact in another ADMIN's scope is simply not found — same
  // 404 as an id that does not exist anywhere.
  const record = await ctx.db.contact.findFirst({ where: { id } });
  if (!record) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const body = await request.json();

  const allowedFields = [
    "companyName",
    "contactPerson",
    "email",
    "phone",
    "altPhone",
    "address",
    "notes",
  ] as const;

  const data: Record<string, string | null> = {};

  for (const field of allowedFields) {
    if (field in body) {
      const val = body[field];
      if (val === null || val === "") {
        data[field] = null;
      } else {
        data[field] = field === "email" ? String(val).trim().toLowerCase() : String(val).trim();
      }
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const contact = await ctx.db.contact.update({
    where: { id },
    data,
  });

  return NextResponse.json(contact);
});

// ─── DELETE ───────────────────────────────────────────────────────────────────

export const DELETE = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await params;

  const record = await ctx.db.contact.findFirst({ where: { id } });
  if (!record) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  await ctx.db.contact.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ success: true });
});
