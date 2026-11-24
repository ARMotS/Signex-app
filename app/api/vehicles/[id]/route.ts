import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { deleteVehicle, updateVehicle } from "@/lib/vehicles";
import { readVehicleInput } from "@/lib/vehicle-registration";

type Ctx = { params: Promise<{ id: string }> };

// Every lookup is scoped: another scope's vehicle is not found, with the same
// 404 as an id that exists nowhere.

/**
 * PUT /api/vehicles/[id]
 * Body: any of { registration, make, model, type, licenceDiscExpiry, isActive }.
 * A field left out is not changed.
 */
export const PUT = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send the changes as JSON." }, { status: 400 });
  }
  const input = readVehicleInput(body, { partial: true });
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "isActive must be true or false." }, { status: 400 });
  }

  const result = await updateVehicle(ctx.tenantId, (await params).id, {
    ...input.value,
    ...(typeof body.isActive === "boolean" && { isActive: body.isActive }),
  });
  if (!result.success) {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.code === "NOT_FOUND" ? 404 : 409 }
    );
  }
  return NextResponse.json({ vehicle: result.vehicle });
});

/**
 * DELETE /api/vehicles/[id] — only a vehicle never on a trip. One that has
 * been answers 409 IN_USE and the page offers Deactivate instead.
 */
export const DELETE = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const result = await deleteVehicle(ctx.tenantId, (await params).id);
  if (!result.success) {
    return NextResponse.json(
      { error: result.error, code: result.code },
      { status: result.code === "NOT_FOUND" ? 404 : 409 }
    );
  }
  return NextResponse.json({ success: true });
});
