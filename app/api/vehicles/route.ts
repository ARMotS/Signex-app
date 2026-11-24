import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { createVehicle, listVehicles } from "@/lib/vehicles";
import { readVehicleInput, type VehicleInput } from "@/lib/vehicle-registration";

/** GET /api/vehicles — the scope's vehicles (Drivers → Vehicles). Office only. */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);
  return NextResponse.json({ vehicles: await listVehicles(ctx.tenantId) });
});

/**
 * POST /api/vehicles
 * Body: { registration, make?, model?, type?, licenceDiscExpiry? }
 *
 * Created in the caller's own scope; a registration already in it is a 409.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send the vehicle as JSON." }, { status: 400 });
  }
  const input = readVehicleInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await createVehicle(ctx.tenantId, input.value as VehicleInput);
  if (!result.success) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: 409 });
  }
  return NextResponse.json({ vehicle: result.vehicle }, { status: 201 });
});
