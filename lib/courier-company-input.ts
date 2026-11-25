/**
 * courier-company-input.ts
 * The rules for a courier company's fields (Contacts → Courier companies),
 * shared by the form and the routes.
 */
import { companyKey } from "./courier-sheet";

export const COURIER_NAME_MAX = 80;
export const COURIER_TEXT_MAX = 120;
export const COURIER_NOTES_MAX = 600;

export interface CourierCompanyInput {
  name: string;
  /** companyKey(name): what "already in your courier companies" is decided on. */
  nameKey: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  accountNumber: string | null;
  notes: string | null;
}

const TEXT_FIELDS = ["contactPerson", "phone", "email", "accountNumber"] as const;

const LABELS: Record<(typeof TEXT_FIELDS)[number] | "notes", string> = {
  contactPerson: "Contact person",
  phone: "Phone",
  email: "Email",
  accountNumber: "Account number",
  notes: "Notes",
};

function cleanLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim() || null;
}

/**
 * Validate the form's fields. `partial` (an edit) accepts any subset: a field
 * left out is not changed. Answers the cleaned values, or the first problem.
 */
export function readCourierCompanyInput(
  body: Record<string, unknown>,
  { partial = false }: { partial?: boolean } = {}
): { ok: true; value: Partial<CourierCompanyInput> } | { ok: false; error: string } {
  const value: Partial<CourierCompanyInput> = {};

  if (!partial || body.name !== undefined) {
    const name = cleanLine(body.name) ?? "";
    const key = companyKey(name);
    if (!key) return { ok: false, error: "Enter the courier company's name." };
    if (name.length > COURIER_NAME_MAX) {
      return { ok: false, error: `A name is at most ${COURIER_NAME_MAX} characters.` };
    }
    value.name = name;
    value.nameKey = key;
  }

  for (const field of TEXT_FIELDS) {
    if (partial && body[field] === undefined) continue;
    const text = cleanLine(body[field]);
    if (text && text.length > COURIER_TEXT_MAX) {
      return { ok: false, error: `${LABELS[field]} is at most ${COURIER_TEXT_MAX} characters.` };
    }
    value[field] = text;
  }
  if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
    return { ok: false, error: "That email address does not look right." };
  }

  if (!partial || body.notes !== undefined) {
    // Notes keep their line breaks; only the ends are trimmed.
    const notes = typeof body.notes === "string" ? body.notes.trim() || null : null;
    if (notes && notes.length > COURIER_NOTES_MAX) {
      return { ok: false, error: `${LABELS.notes} are at most ${COURIER_NOTES_MAX} characters.` };
    }
    value.notes = notes;
  }

  return { ok: true, value };
}
