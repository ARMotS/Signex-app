/**
 * Username and password rules. Pure — no server imports — so the account
 * forms validate as the user types with exactly the rules the server enforces.
 *
 * The database is the final word on usernames: LoginName's primary key makes
 * them globally unique and a CHECK constraint repeats the format rule, so a
 * caller that skips normalizeUsername() is rejected rather than stored.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const PASSWORD_MIN = 8;
/**
 * scrypt cost grows with input length, so an unbounded password is a cheap way
 * to make the login endpoint expensive. Far above anything a person types.
 */
export const PASSWORD_MAX = 200;

const USERNAME_PATTERN = /^[a-z0-9._]+$/;

export const USERNAME_TAKEN = "Username already taken";

export const USERNAME_HINT = `${USERNAME_MIN}–${USERNAME_MAX} characters: letters, numbers, dots and underscores`;
export const PASSWORD_HINT = `At least ${PASSWORD_MIN} characters, with a letter and a number`;

/**
 * The stored form. "  JDoe " and "jdoe" are the same name — the login form,
 * the availability check and every write all go through this.
 */
export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Returns an error message, or null when the (normalised) name is valid. */
export function validateUsername(raw: unknown): string | null {
  const username = normalizeUsername(raw);
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters`;
  }
  if (!USERNAME_PATTERN.test(username)) {
    return "Username can only contain letters, numbers, dots and underscores";
  }
  return null;
}

/** Returns an error message, or null when the password meets the rules. */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters`;
  }
  if (password.length > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} characters`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return "Password must contain at least one letter and one number";
  }
  return null;
}

export type AppRole = "super_admin" | "admin" | "driver";

/** Where each role lands after signing in, and where it is sent back to. */
export function homePathForRole(role: AppRole | string | undefined): string {
  switch (role) {
    case "super_admin":
      return "/users";
    case "admin":
      return "/dashboard";
    case "driver":
      return "/run";
    default:
      return "/login";
  }
}
