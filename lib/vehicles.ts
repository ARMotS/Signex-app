/**
 * A branch's vehicles (Drivers → Vehicles), and the link from a trip sheet's
 * REGNO to one of them.
 *
 * A vehicle is never a default for anything: nothing here reads a driver's
 * last vehicle or pre-fills one. The only automatic link is an Excel sheet's
 * own REGNO matching a vehicle's registration key, made when the trip is
 * saved — never a warning, never required, and the raw REGNO is kept either way.
 */
import { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { vehicleRegistrationKey, type VehicleInput } from "./vehicle-registration";

export interface VehicleRow {
  id: string;
  registration: string;
  make: string | null;
  model: string | null;
  type: string | null;
  isActive: boolean;
  /** YYYY-MM-DD, or null. */
  licenceDiscExpiry: string | null;
  createdAt: string;
  /** Live trip sheets linked to it now. */
  liveTrips: number;
  /** Ever on a trip (live or archived) — such a vehicle can only be deactivated. */
  used: boolean;
}

export type VehicleResult =
  | { success: true; vehicle: VehicleRow }
  | { success: false; code: "NOT_FOUND" | "DUPLICATE"; error: string };

export type VehicleDeleteResult =
  | { success: true }
  | { success: false; code: "NOT_FOUND" | "IN_USE"; error: string };

const toDate = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null);
const toDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const isForeignKeyViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";

const duplicate = (registration: string) => ({
  success: false as const,
  code: "DUPLICATE" as const,
  error: `${registration} is already in your vehicles.`,
});
const notFound = { success: false as const, code: "NOT_FOUND" as const, error: "Vehicle not found" };

type VehicleRecord = Prisma.VehicleGetPayload<{ include: { _count: { select: { tripSheets: true } } } }>;

function toRow(v: VehicleRecord, archived: boolean): VehicleRow {
  return {
    id: v.id,
    registration: v.registration,
    make: v.make,
    model: v.model,
    type: v.type,
    isActive: v.isActive,
    licenceDiscExpiry: toDay(v.licenceDiscExpiry),
    createdAt: v.createdAt.toISOString(),
    liveTrips: v._count.tripSheets,
    used: v._count.tripSheets > 0 || archived,
  };
}

/** Every vehicle in the scope, active first, then by registration. */
export async function listVehicles(tenantId: string): Promise<VehicleRow[]> {
  const db = scopedPrisma(tenantId);
  const [vehicles, archived] = await Promise.all([
    db.vehicle.findMany({
      include: { _count: { select: { tripSheets: true } } },
      orderBy: [{ isActive: "desc" }, { registrationKey: "asc" }],
    }),
    db.completedTripSheet.groupBy({ by: ["vehicleId"], where: { vehicleId: { not: null } } }),
  ]);
  const archivedIds = new Set(archived.map((a) => a.vehicleId));
  return vehicles.map((v) => toRow(v, archivedIds.has(v.id)));
}

async function readRow(tenantId: string, id: string): Promise<VehicleRow | null> {
  const db = scopedPrisma(tenantId);
  const v = await db.vehicle.findFirst({
    where: { id },
    include: { _count: { select: { tripSheets: true } } },
  });
  if (!v) return null;
  const archived = await db.completedTripSheet.count({ where: { vehicleId: id } });
  return toRow(v, archived > 0);
}

export async function createVehicle(tenantId: string, input: VehicleInput): Promise<VehicleResult> {
  const db = scopedPrisma(tenantId);
  let id: string;
  try {
    ({ id } = await db.vehicle.create({
      data: {
        registration: input.registration,
        registrationKey: input.registrationKey,
        make: input.make,
        model: input.model,
        type: input.type,
        licenceDiscExpiry: toDate(input.licenceDiscExpiry),
      },
      select: { id: true },
    }));
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(input.registration);
    throw err;
  }

  await logAudit({
    action: "VEHICLE_CREATE",
    entity: "vehicle",
    entityId: id,
    details: `Vehicle added: ${input.registration}`,
    tenantId,
  });

  return { success: true, vehicle: (await readRow(tenantId, id))! };
}

/**
 * Change a vehicle's details or (de)activate it. A changed registration does
 * not move existing links: a trip linked to this vehicle stays linked to it.
 */
export async function updateVehicle(
  tenantId: string,
  id: string,
  input: Partial<VehicleInput> & { isActive?: boolean }
): Promise<VehicleResult> {
  const db = scopedPrisma(tenantId);
  const before = await db.vehicle.findFirst({ where: { id } });
  if (!before) return notFound;

  const data: Prisma.VehicleUpdateManyMutationInput = {};
  if (input.registration !== undefined) {
    data.registration = input.registration;
    data.registrationKey = input.registrationKey;
  }
  if (input.make !== undefined) data.make = input.make;
  if (input.model !== undefined) data.model = input.model;
  if (input.type !== undefined) data.type = input.type;
  if (input.licenceDiscExpiry !== undefined) data.licenceDiscExpiry = toDate(input.licenceDiscExpiry);
  if (input.isActive !== undefined) data.isActive = input.isActive;

  try {
    const { count } = await db.vehicle.updateMany({ where: { id }, data });
    if (count === 0) return notFound;
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(input.registration ?? before.registration);
    throw err;
  }

  const changes: string[] = [];
  if (input.registration !== undefined && input.registration !== before.registration) {
    changes.push(`registration ${before.registration} → ${input.registration}`);
  }
  if (input.isActive !== undefined && input.isActive !== before.isActive) {
    changes.push(input.isActive ? "reactivated" : "deactivated");
  }
  for (const field of ["make", "model", "type"] as const) {
    if (input[field] !== undefined && input[field] !== before[field]) changes.push(field);
  }
  if (
    input.licenceDiscExpiry !== undefined &&
    input.licenceDiscExpiry !== toDay(before.licenceDiscExpiry)
  ) {
    changes.push("licence disc expiry");
  }
  if (changes.length > 0) {
    await logAudit({
      action: "VEHICLE_UPDATE",
      entity: "vehicle",
      entityId: id,
      details: `Vehicle ${before.registration}: ${changes.join(", ")}`,
      tenantId,
    });
  }

  return { success: true, vehicle: (await readRow(tenantId, id))! };
}

/**
 * Delete a vehicle that has never been on a trip. One that has — live or in
 * the completed archive — is deactivated instead, so a trip's record never
 * loses the vehicle it names.
 */
export async function deleteVehicle(tenantId: string, id: string): Promise<VehicleDeleteResult> {
  const db = scopedPrisma(tenantId);
  const vehicle = await db.vehicle.findFirst({ where: { id } });
  if (!vehicle) return notFound;

  const inUse = {
    success: false as const,
    code: "IN_USE" as const,
    error: `${vehicle.registration} has been on a trip, so it cannot be deleted. Deactivate it instead.`,
  };

  const [live, archived] = await Promise.all([
    db.tripSheet.count({ where: { vehicleId: id } }),
    db.completedTripSheet.count({ where: { vehicleId: id } }),
  ]);
  if (live + archived > 0) return inUse;

  try {
    // deleteMany: a vehicle deleted by someone else meanwhile is a 404, not a throw.
    const { count } = await db.vehicle.deleteMany({ where: { id } });
    if (count === 0) return notFound;
  } catch (err) {
    // A trip linked to it between the count and the delete (RESTRICT FK).
    if (isForeignKeyViolation(err)) return inUse;
    throw err;
  }

  await logAudit({
    action: "VEHICLE_DELETE",
    entity: "vehicle",
    entityId: id,
    details: `Vehicle deleted: ${vehicle.registration}`,
    tenantId,
  });
  return { success: true };
}

/**
 * The scope's vehicle a REGNO names, or null. Exact registration-key match
 * only — never fuzzy, never "the driver's usual vehicle". An inactive vehicle
 * still matches: the sheet says it drove, and that is the fact to record.
 */
export async function vehicleIdForRegNo(tenantId: string, regNo: string | null | undefined): Promise<string | null> {
  const key = vehicleRegistrationKey(regNo);
  if (!key) return null;
  const vehicle = await scopedPrisma(tenantId).vehicle.findFirst({
    where: { registrationKey: key },
    select: { id: true },
  });
  return vehicle?.id ?? null;
}
