/**
 * A branch's courier companies (Contacts → Courier companies).
 *
 * Kept apart from Contact on purpose: every customer email finds its
 * recipient by matching Contact.companyName, and a courier company must never
 * be that match. Signex never emails a courier company; the address here is
 * for the office to read. Manual courier dispatch (a later session) picks
 * from this list.
 */
import { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import type { CourierCompanyInput } from "./courier-company-input";

export interface CourierCompanyRow {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  accountNumber: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export type CourierCompanyResult =
  | { success: true; courierCompany: CourierCompanyRow }
  | { success: false; code: "NOT_FOUND" | "DUPLICATE"; error: string };

export type CourierCompanyDeleteResult =
  | { success: true }
  | { success: false; code: "NOT_FOUND"; error: string };

const SELECT = {
  id: true,
  name: true,
  contactPerson: true,
  phone: true,
  email: true,
  accountNumber: true,
  notes: true,
  isActive: true,
  createdAt: true,
} as const;

type Record_ = Prisma.CourierCompanyGetPayload<{ select: typeof SELECT }>;

const toRow = (c: Record_): CourierCompanyRow => ({ ...c, createdAt: c.createdAt.toISOString() });

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const duplicate = (name: string) => ({
  success: false as const,
  code: "DUPLICATE" as const,
  error: `${name} is already in your courier companies.`,
});
const notFound = { success: false as const, code: "NOT_FOUND" as const, error: "Courier company not found" };

/** Every courier company in the scope, active first, then by name. */
export async function listCourierCompanies(tenantId: string): Promise<CourierCompanyRow[]> {
  const rows = await scopedPrisma(tenantId).courierCompany.findMany({
    select: SELECT,
    orderBy: [{ isActive: "desc" }, { nameKey: "asc" }],
  });
  return rows.map(toRow);
}

export async function createCourierCompany(
  tenantId: string,
  input: CourierCompanyInput
): Promise<CourierCompanyResult> {
  const db = scopedPrisma(tenantId);
  let created: Record_;
  try {
    created = await db.courierCompany.create({ data: input, select: SELECT });
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(input.name);
    throw err;
  }

  await logAudit({
    action: "COURIER_COMPANY_CREATE",
    entity: "courierCompany",
    entityId: created.id,
    details: `Courier company added: ${created.name}`,
    tenantId,
  });
  return { success: true, courierCompany: toRow(created) };
}

/** Change a courier company's details or (de)activate it. */
export async function updateCourierCompany(
  tenantId: string,
  id: string,
  input: Partial<CourierCompanyInput> & { isActive?: boolean }
): Promise<CourierCompanyResult> {
  const db = scopedPrisma(tenantId);
  const before = await db.courierCompany.findFirst({ where: { id }, select: SELECT });
  if (!before) return notFound;

  try {
    const { count } = await db.courierCompany.updateMany({ where: { id }, data: input });
    if (count === 0) return notFound;
  } catch (err) {
    if (isUniqueViolation(err)) return duplicate(input.name ?? before.name);
    throw err;
  }

  const changes: string[] = [];
  if (input.name !== undefined && input.name !== before.name) changes.push(`name ${before.name} → ${input.name}`);
  if (input.isActive !== undefined && input.isActive !== before.isActive) {
    changes.push(input.isActive ? "reactivated" : "deactivated");
  }
  for (const field of ["contactPerson", "phone", "email", "accountNumber", "notes"] as const) {
    if (input[field] !== undefined && input[field] !== before[field]) changes.push(field);
  }
  if (changes.length > 0) {
    await logAudit({
      action: "COURIER_COMPANY_UPDATE",
      entity: "courierCompany",
      entityId: id,
      details: `Courier company ${before.name}: ${changes.join(", ")}`,
      tenantId,
    });
  }

  const after = await db.courierCompany.findFirst({ where: { id }, select: SELECT });
  return after ? { success: true, courierCompany: toRow(after) } : notFound;
}

/**
 * Delete a courier company. Nothing refers to one yet; once courier
 * dispatches name them, one that has been used will only deactivate.
 */
export async function deleteCourierCompany(tenantId: string, id: string): Promise<CourierCompanyDeleteResult> {
  const db = scopedPrisma(tenantId);
  const company = await db.courierCompany.findFirst({ where: { id }, select: { name: true } });
  if (!company) return notFound;

  // deleteMany: deleted by someone else meanwhile is a 404, not a throw.
  const { count } = await db.courierCompany.deleteMany({ where: { id } });
  if (count === 0) return notFound;

  await logAudit({
    action: "COURIER_COMPANY_DELETE",
    entity: "courierCompany",
    entityId: id,
    details: `Courier company deleted: ${company.name}`,
    tenantId,
  });
  return { success: true };
}
