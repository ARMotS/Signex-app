/**
 * Vehicle rules shared by the Vehicles form and the server. No imports, so the
 * browser runs exactly the code the route validates with.
 *
 * A registration is kept as typed ("CA 123-456") for display, and matched on
 * its key: uppercase, letters and digits only ("CA123456"). That is the only
 * thing an Excel sheet's REGNO is compared on, so "ca 123 456", "CA123-456"
 * and "CA 123-456" all name the same vehicle.
 */

export const VEHICLE_REGISTRATION_MAX = 20;
export const VEHICLE_TEXT_MAX = 40;

/** Suggestions for the type field. Free text: a fleet names its own kinds. */
export const VEHICLE_TYPE_SUGGESTIONS = ["Bakkie", "Truck", "Van", "Panel van", "Car", "Motorbike"];

/** A licence disc this close to expiry is flagged on the list. */
export const LICENCE_DISC_WARN_DAYS = 30;

/** The matching key of a registration; "" when it holds no letter or digit. */
export function vehicleRegistrationKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A registration as it is stored for display: spaces collapsed, uppercase. */
export function cleanRegistration(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().toUpperCase();
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim() || null;
}

export interface VehicleInput {
  registration: string;
  registrationKey: string;
  make: string | null;
  model: string | null;
  type: string | null;
  /** YYYY-MM-DD, or null for none. */
  licenceDiscExpiry: string | null;
}

/**
 * Validate the form's fields. `partial` (an edit) accepts any subset: a field
 * left out is not changed. Answers the cleaned values, or the first problem.
 */
export function readVehicleInput(
  body: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {}
): { ok: true; value: Partial<VehicleInput> } | { ok: false; error: string } {
  const value: Partial<VehicleInput> = {};

  if (!partial || body.registration !== undefined) {
    const registration = cleanRegistration(body.registration);
    const key = vehicleRegistrationKey(registration);
    if (!key) return { ok: false, error: "Enter the vehicle's registration." };
    if (registration.length > VEHICLE_REGISTRATION_MAX) {
      return { ok: false, error: `A registration is at most ${VEHICLE_REGISTRATION_MAX} characters.` };
    }
    value.registration = registration;
    value.registrationKey = key;
  }

  for (const field of ["make", "model", "type"] as const) {
    if (partial && body[field] === undefined) continue;
    const text = cleanText(body[field]);
    if (text && text.length > VEHICLE_TEXT_MAX) {
      return { ok: false, error: `${field[0].toUpperCase()}${field.slice(1)} is at most ${VEHICLE_TEXT_MAX} characters.` };
    }
    value[field] = text;
  }

  if (!partial || body.licenceDiscExpiry !== undefined) {
    const raw = body.licenceDiscExpiry;
    if (raw === null || raw === undefined || raw === "") {
      value.licenceDiscExpiry = null;
    } else if (typeof raw !== "string" || !isCalendarDate(raw)) {
      return { ok: false, error: "Licence disc expiry must be a date." };
    } else {
      value.licenceDiscExpiry = raw;
    }
  }

  return { ok: true, value };
}

function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export type LicenceDiscState = "none" | "ok" | "expiring" | "expired";

/**
 * Where a licence disc stands on `today` (YYYY-MM-DD, the viewer's own day).
 * A disc is valid through its expiry date.
 */
export function licenceDiscState(expiry: string | null, today: string): LicenceDiscState {
  if (!expiry) return "none";
  if (expiry < today) return "expired";
  const days = (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  return days <= LICENCE_DISC_WARN_DAYS ? "expiring" : "ok";
}
