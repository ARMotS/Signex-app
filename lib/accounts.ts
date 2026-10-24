/**
 * Account management — PostgreSQL via Prisma.
 *
 * Every account, whatever its role, signs in with a username and password.
 * Usernames live in the LoginName registry (see prisma/schema.prisma), which is
 * what makes them unique across every role and every scope. Passwords are
 * hashed with Node.js crypto scrypt.
 *
 * Every driver operation is scoped: a driver belongs to exactly one ADMIN's
 * tenant and is invisible to every other ADMIN. Login is the sole exception —
 * it necessarily runs before a scope exists, and its scope is the *output* of
 * the lookup, taken from the matched account row.
 */

import crypto from "crypto";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { revokeSessionsWrite } from "./session";
import {
  normalizeUsername,
  validateUsername,
  validatePassword,
  USERNAME_TAKEN,
  type AppRole,
} from "./credentials";

export type AccountRole = "admin" | "driver";

// ─── Password Hashing ─────────────────────────────────────────────────────

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = crypto.scryptSync(password, salt, 64).toString("hex");
  // Constant-time compare — both sides are fixed-length hex of the same length.
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(computed, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verified against when the username does not exist or has no password, so an
 * unknown name costs the same scrypt round as a known one and response time
 * does not reveal which usernames are real.
 */
let dummyHash: string | null = null;
function getDummyHash(): string {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"));
  return dummyHash;
}

// ─── Usernames ────────────────────────────────────────────────────────────

/**
 * True when the (normalised) username belongs to any account in any scope.
 *
 * This necessarily reveals that a name exists somewhere — the login form has no
 * tenant selector, so uniqueness has to be global, and "Username already taken"
 * is the answer the spec asks for. It reveals nothing else: not the role, the
 * scope, or the account behind it.
 */
export async function isUsernameTaken(username: string): Promise<boolean> {
  // SCOPE-EXEMPT: LoginName is the global sign-in registry and carries no
  // tenantId. Only existence is returned.
  const row = await UNSAFE_unscopedPrisma.loginName.findUnique({
    where: { username: normalizeUsername(username) },
    select: { username: true },
  });
  return row !== null;
}

/**
 * After a write fails, decide whether a username race is why. The availability
 * check runs first, but two creators can claim one name at the same moment —
 * the LoginName primary key settles it, and the loser gets the same message it
 * would have had a second earlier.
 */
async function explainWriteFailure(
  err: unknown,
  username: string | undefined
): Promise<string | null> {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2002" && username && (await isUsernameTaken(username))) {
    return USERNAME_TAKEN;
  }
  return null;
}

// ─── Admin Account Operations ─────────────────────────────────────────────

/**
 * Create an admin account inside a scope.
 *
 * @param tenantId The scope this admin OWNS. For a new ADMIN this must be a
 *                 freshly created tenant — never the creator's own scope, or
 *                 the two admins share data. See app/api/admin/users/route.ts.
 */
export async function createAdminAccount(
  name: string,
  email: string,
  username: string,
  password: string,
  tenantId: string
): Promise<{
  success: boolean;
  error?: string;
  account?: { id: string; name: string; email: string; username: string };
}> {
  const usernameError = validateUsername(username);
  if (usernameError) return { success: false, error: usernameError };
  const passwordError = validatePassword(password);
  if (passwordError) return { success: false, error: passwordError };

  const normalizedUsername = normalizeUsername(username);

  try {
    // SCOPE-EXEMPT: Admin.email is globally unique across the installation, so
    // this collision check must span scopes. It returns only a boolean-ish
    // "already exists" and never surfaces the other scope's row.
    const existing = await UNSAFE_unscopedPrisma.admin.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return { success: false, error: "An account with this email already exists" };
    }

    if (await isUsernameTaken(normalizedUsername)) {
      return { success: false, error: USERNAME_TAKEN };
    }

    // The LoginName row is created in the same statement, so an admin can never
    // exist without its username or the other way round.
    const admin = await scopedPrisma(tenantId).admin.create({
      data: {
        name,
        email: email.toLowerCase(),
        passwordHash: hashPassword(password),
        login: { create: { username: normalizedUsername } },
      },
      select: { id: true, name: true, email: true },
    });

    await logAudit({
      action: "ACCOUNT_CREATE",
      entity: "admin",
      entityId: admin.id,
      userName: admin.name,
      details: `Admin account created: ${normalizedUsername}`,
      metadata: { username: normalizedUsername },
      tenantId,
    });

    return { success: true, account: { ...admin, username: normalizedUsername } };
  } catch (err) {
    const explained = await explainWriteFailure(err, normalizedUsername);
    if (explained) return { success: false, error: explained };
    console.error("Failed to create admin:", err);
    return { success: false, error: "Failed to create account" };
  }
}

/**
 * Update an admin credential row, matched by its current email.
 * Only touches the Admin table and its LoginName; the companion User row is
 * updated separately by the caller.
 *
 * A password change signs the account out on every device except the one
 * whose token is `keepSessionToken` — set when an account changes its own
 * password and should stay signed in where it did it from.
 */
export async function updateAdminAccount(
  tenantId: string,
  currentEmail: string,
  updates: { name?: string; email?: string; username?: string; password?: string },
  options: { keepSessionToken?: string } = {}
): Promise<{ success: boolean; error?: string }> {
  const changingPassword = updates.password !== undefined && updates.password !== "";
  if (changingPassword) {
    const passwordError = validatePassword(updates.password);
    if (passwordError) return { success: false, error: passwordError };
  }

  let newUsername: string | undefined;
  if (updates.username !== undefined && updates.username !== "") {
    const usernameError = validateUsername(updates.username);
    if (usernameError) return { success: false, error: usernameError };
    newUsername = normalizeUsername(updates.username);
  }

  try {
    const db = scopedPrisma(tenantId);

    // Scoped lookup: an admin outside this scope is simply not found, so a
    // SUPER_ADMIN cannot rewrite another scope's credentials by guessing an email.
    const admin = await db.admin.findFirst({
      where: { email: currentEmail.toLowerCase() },
      include: { login: { select: { username: true } } },
    });
    if (!admin) {
      return { success: false, error: "Admin credentials not found" };
    }

    // SCOPE-EXEMPT: Admin.email is globally unique, so a rename must not collide
    // with an account in another scope. Only existence is used.
    if (updates.email !== undefined && updates.email.toLowerCase() !== admin.email) {
      const clash = await UNSAFE_unscopedPrisma.admin.findUnique({
        where: { email: updates.email.toLowerCase() },
      });
      if (clash) {
        return { success: false, error: "An account with this email already exists" };
      }
    }

    const renaming = newUsername !== undefined && newUsername !== admin.login?.username;
    if (renaming && (await isUsernameTaken(newUsername!))) {
      return { success: false, error: USERNAME_TAKEN };
    }

    // Only a token that is still live is kept — a device already signed out
    // must not be revived by the password change it made on its way out. (The
    // nested revoke below only ever touches live sessions, so it cannot revive
    // one either.)
    const keep =
      options.keepSessionToken && admin.sessionTokens.includes(options.keepSessionToken)
        ? options.keepSessionToken
        : null;

    await db.admin.update({
      where: { id: admin.id },
      data: {
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.email !== undefined && { email: updates.email.toLowerCase() }),
        ...(changingPassword && {
          passwordHash: hashPassword(updates.password!),
          // A reset password must lock out whoever held the old one, now —
          // on every device but the caller's own when they changed it themselves.
          sessions: revokeSessionsWrite("password_reset", options.keepSessionToken),
          sessionToken: keep,
          sessionTokens: keep ? [keep] : [],
        }),
        ...(renaming && {
          login: {
            upsert: {
              create: { username: newUsername! },
              update: { username: newUsername! },
            },
          },
        }),
      },
    });

    // One entry per kind of change, so a password reset or a rename can be
    // found on its own. The password itself is never logged.
    const subject = {
      entity: "admin",
      entityId: admin.id,
      userName: updates.name || admin.name,
      tenantId,
    };
    if (changingPassword) {
      const self = options.keepSessionToken !== undefined;
      await logAudit({
        ...subject,
        action: "PASSWORD_CHANGE",
        details: self
          ? "Changed their own password — other devices signed out"
          : "Password reset — signed out of every device",
        metadata: { self },
      });
    }
    if (renaming) {
      const from = admin.login?.username ?? null;
      await logAudit({
        ...subject,
        action: "USERNAME_CHANGE",
        details: `Username ${from ?? "(none)"} → ${newUsername}`,
        metadata: { from, to: newUsername },
      });
    }
    const newEmail = updates.email?.toLowerCase();
    const fields = [
      ...(updates.name !== undefined && updates.name !== admin.name ? ["name"] : []),
      ...(newEmail !== undefined && newEmail !== admin.email ? ["email"] : []),
    ];
    if (fields.length > 0) {
      await logAudit({
        ...subject,
        action: "ACCOUNT_UPDATE",
        details: `Updated ${fields.join(" and ")}`,
        metadata: {
          fields,
          ...(fields.includes("name") && { name: { from: admin.name, to: updates.name } }),
          ...(fields.includes("email") && { email: { from: admin.email, to: newEmail } }),
        },
      });
    }

    return { success: true };
  } catch (err) {
    const explained = await explainWriteFailure(err, newUsername);
    if (explained) return { success: false, error: explained };
    console.error("Failed to update admin:", err);
    return { success: false, error: "Failed to update admin credentials" };
  }
}

/**
 * Delete an admin credential row by email. Its LoginName goes with it
 * (ON DELETE CASCADE). The companion User row is deleted separately by the caller.
 */
export async function deleteAdminAccount(
  tenantId: string,
  email: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Scoped delete: an email belonging to another scope matches zero rows rather
    // than deleting that scope's admin.
    const res = await scopedPrisma(tenantId).admin.deleteMany({
      where: { email: email.toLowerCase() },
    });

    if (res.count === 0) {
      return { success: false, error: "Admin credentials not found" };
    }

    await logAudit({
      action: "ACCOUNT_DELETE",
      entity: "admin",
      details: `Admin account deleted: ${email.toLowerCase()}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete admin:", err);
    return { success: false, error: "Failed to delete admin credentials" };
  }
}

// ─── Login ────────────────────────────────────────────────────────────────

/** The only message a failed credential check ever produces. */
export const LOGIN_FAILED = "Incorrect username or password";

export type LoginResult =
  | {
      success: true;
      account: {
        id: string;
        role: AppRole;
        name: string;
        email?: string;
        tenantId: string;
      };
    }
  | { success: false; error: string };

/**
 * Sign any account in by username + password.
 *
 * One lookup in the LoginName registry resolves the account, its role and its
 * scope. Nothing about the scope comes from the client.
 *
 * Wrong username, wrong password, and a driver who has no password yet all
 * return LOGIN_FAILED after the same scrypt work, so neither the message nor
 * the timing says which part was wrong. Deactivation is reported only AFTER the
 * password verifies, so it cannot be used to discover which usernames exist.
 */
export async function login(rawUsername: string, password: string): Promise<LoginResult> {
  const username = normalizeUsername(rawUsername);

  // SCOPE-EXEMPT: pre-session. LoginName is the global sign-in registry and the
  // username is globally unique, so this resolves to at most one account; the
  // session's scope is taken from that account's own row.
  const entry = validateUsername(username)
    ? null
    : await UNSAFE_unscopedPrisma.loginName.findUnique({
        where: { username },
        select: {
          admin: {
            select: {
              id: true,
              name: true,
              email: true,
              passwordHash: true,
              active: true,
              tenantId: true,
            },
          },
          driver: {
            select: {
              id: true,
              name: true,
              passwordHash: true,
              active: true,
              tenantId: true,
            },
          },
        },
      });

  const stored = entry?.admin?.passwordHash ?? entry?.driver?.passwordHash ?? null;
  const passwordOk =
    typeof password === "string" &&
    verifyPassword(password, stored ?? getDummyHash()) &&
    stored !== null;

  if (!passwordOk || !entry) {
    // Logged for known and unknown names alike, so the write adds no timing
    // difference between them. The name is recorded only when it is a real
    // account: an unknown one may be a password typed into the wrong box.
    const known = entry?.admin ?? entry?.driver ?? null;
    await logAudit({
      action: "LOGIN_FAILED",
      entity: entry?.admin ? "admin" : entry?.driver ? "driver" : "auth",
      entityId: known?.id,
      userName: known ? username : undefined,
      details: !known
        ? "Unknown username"
        : stored === null
          ? "No password set yet"
          : "Wrong password",
      tenantId: known?.tenantId ?? null,
      actor: null,
    });
    return { success: false, error: LOGIN_FAILED };
  }

  // The right password for a deactivated account: refused, and recorded.
  const refuseDeactivated = (kind: "admin" | "driver", id: string, tenantId: string) =>
    logAudit({
      action: "LOGIN_FAILED",
      entity: kind,
      entityId: id,
      userName: username,
      details: "Account deactivated",
      tenantId,
      actor: null,
    });

  if (entry.admin) {
    const admin = entry.admin;
    if (!admin.active) {
      await refuseDeactivated("admin", admin.id, admin.tenantId);
      return {
        success: false,
        error: "This account has been deactivated. Contact your administrator.",
      };
    }

    // Role lives on User, keyed by the same globally unique email.
    // SCOPE-EXEMPT: pre-session role lookup on the User registry.
    const user = await UNSAFE_unscopedPrisma.user.findUnique({
      where: { email: admin.email.toLowerCase() },
      select: { role: true },
    });

    // The sign-in itself is logged by the login route once a session has
    // actually started — a login held at the device limit is not one.
    return {
      success: true,
      account: {
        id: admin.id,
        role: user?.role === "SUPER_ADMIN" ? "super_admin" : "admin",
        name: admin.name,
        email: admin.email,
        tenantId: admin.tenantId,
      },
    };
  }

  const driver = entry.driver!;
  if (!driver.active) {
    await refuseDeactivated("driver", driver.id, driver.tenantId);
    return {
      success: false,
      error: "This account has been deactivated. Contact your administrator.",
    };
  }

  return {
    success: true,
    account: {
      id: driver.id,
      role: "driver",
      name: driver.name,
      tenantId: driver.tenantId,
    },
  };
}

// ─── Driver Account Operations ────────────────────────────────────────────

export async function createDriverAccount(
  name: string,
  username: string,
  password: string,
  tenantId: string
): Promise<{
  success: boolean;
  error?: string;
  account?: { id: string; name: string; active: boolean; username: string };
}> {
  const usernameError = validateUsername(username);
  if (usernameError) return { success: false, error: usernameError };
  const passwordError = validatePassword(password);
  if (passwordError) return { success: false, error: passwordError };

  const normalizedUsername = normalizeUsername(username);

  try {
    const db = scopedPrisma(tenantId);

    // Name uniqueness is per-scope — it is what trip sheets match on. A global
    // check would leak the fact that another ADMIN already employs this name.
    const existing = await db.driver.findFirst({ where: { name } });

    if (existing) {
      return { success: false, error: "A driver with this name already exists" };
    }

    if (await isUsernameTaken(normalizedUsername)) {
      return { success: false, error: USERNAME_TAKEN };
    }

    const driver = await db.driver.create({
      data: {
        name,
        passwordHash: hashPassword(password),
        login: { create: { username: normalizedUsername } },
      },
      select: { id: true, name: true, active: true },
    });

    await logAudit({
      action: "DRIVER_CREATE",
      entity: "driver",
      entityId: driver.id,
      userName: driver.name,
      details: `Driver created: ${driver.name} (${normalizedUsername})`,
      tenantId,
    });

    return { success: true, account: { ...driver, username: normalizedUsername } };
  } catch (err) {
    const explained = await explainWriteFailure(err, normalizedUsername);
    if (explained) return { success: false, error: explained };
    console.error("Failed to create driver:", err);
    return { success: false, error: "Failed to create driver account" };
  }
}

export async function listDrivers(tenantId: string): Promise<
  {
    id: string;
    name: string;
    active: boolean;
    createdAt: Date;
    username: string | null;
    canSignIn: boolean;
  }[]
> {
  const drivers = await scopedPrisma(tenantId).driver.findMany({
    select: {
      id: true,
      name: true,
      active: true,
      createdAt: true,
      passwordHash: true,
      login: { select: { username: true } },
    },
    orderBy: { name: "asc" },
  });

  // The hash itself never leaves this function.
  return drivers.map(({ passwordHash, login, ...d }) => ({
    ...d,
    username: login?.username ?? null,
    canSignIn: login !== null && passwordHash !== null,
  }));
}

/**
 * Update a driver, including setting or resetting their sign-in.
 *
 * A driver created before usernames existed has neither a username nor a
 * password, and needs both before they can sign in — so a password alone is
 * refused for them rather than leaving a half-set account.
 */
export async function updateDriver(
  tenantId: string,
  id: string,
  updates: { name?: string; active?: boolean; username?: string; password?: string }
): Promise<{ success: boolean; error?: string }> {
  const changingPassword = updates.password !== undefined && updates.password !== "";
  if (changingPassword) {
    const passwordError = validatePassword(updates.password);
    if (passwordError) return { success: false, error: passwordError };
  }

  let newUsername: string | undefined;
  if (updates.username !== undefined && updates.username !== "") {
    const usernameError = validateUsername(updates.username);
    if (usernameError) return { success: false, error: usernameError };
    newUsername = normalizeUsername(updates.username);
  }

  try {
    const db = scopedPrisma(tenantId);

    // Scoped read: a driver in another tenant is simply not found.
    const driver = await db.driver.findFirst({
      where: { id },
      include: { login: { select: { username: true } } },
    });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    const hasUsername = driver.login !== null || newUsername !== undefined;
    const hasPassword = driver.passwordHash !== null || changingPassword;
    if ((newUsername !== undefined || changingPassword) && !(hasUsername && hasPassword)) {
      return {
        success: false,
        error: "This driver has no login yet — set both a username and a password",
      };
    }

    // Renaming must not collide within the scope.
    if (updates.name !== undefined && updates.name !== driver.name) {
      const clash = await db.driver.findFirst({ where: { name: updates.name } });
      if (clash) {
        return { success: false, error: "A driver with this name already exists" };
      }
    }

    const renaming = newUsername !== undefined && newUsername !== driver.login?.username;
    if (renaming && (await isUsernameTaken(newUsername!))) {
      return { success: false, error: USERNAME_TAKEN };
    }

    // The LoginName is written through the driver, on the scoped client — so
    // this can only ever attach a username to a driver in the caller's scope.
    await db.driver.update({
      where: { id },
      data: {
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.active !== undefined && { active: updates.active }),
        ...(changingPassword && { passwordHash: hashPassword(updates.password!) }),
        // A reset password must lock out whoever held the old one, now; a
        // deactivated driver is signed out rather than left working until
        // their cookie expires.
        ...((changingPassword || updates.active === false) && {
          sessionToken: null,
          sessions: revokeSessionsWrite(changingPassword ? "password_reset" : "deactivated"),
        }),
        ...(renaming && {
          login: {
            upsert: {
              create: { username: newUsername! },
              update: { username: newUsername! },
            },
          },
        }),
      },
    });

    // One entry per kind of change. Never the password itself.
    const subject = {
      entity: "driver",
      entityId: id,
      userName: updates.name ?? driver.name,
      tenantId,
    };
    if (changingPassword) {
      await logAudit({
        ...subject,
        action: "PASSWORD_CHANGE",
        details: "Password reset — signed out",
      });
    }
    if (renaming) {
      const from = driver.login?.username ?? null;
      await logAudit({
        ...subject,
        action: "USERNAME_CHANGE",
        details: `Username ${from ?? "(none)"} → ${newUsername}`,
        metadata: { from, to: newUsername },
      });
    }
    if (updates.active !== undefined && updates.active !== driver.active) {
      await logAudit({
        ...subject,
        action: updates.active ? "ACCOUNT_REACTIVATE" : "ACCOUNT_DEACTIVATE",
        details: updates.active ? "Driver reactivated" : "Driver deactivated — signed out",
      });
    }
    if (updates.name !== undefined && updates.name !== driver.name) {
      await logAudit({
        ...subject,
        action: "DRIVER_UPDATE",
        details: `Renamed ${driver.name} → ${updates.name}`,
        metadata: { name: { from: driver.name, to: updates.name } },
      });
    }

    return { success: true };
  } catch (err) {
    const explained = await explainWriteFailure(err, newUsername);
    if (explained) return { success: false, error: explained };
    console.error("Failed to update driver:", err);
    return { success: false, error: "Failed to update driver" };
  }
}

export async function deleteDriver(
  tenantId: string,
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    const driver = await db.driver.findFirst({ where: { id } });
    if (!driver) {
      return { success: false, error: "Driver not found" };
    }

    await db.driver.delete({ where: { id } });

    await logAudit({
      action: "DRIVER_DELETE",
      entity: "driver",
      entityId: id,
      userName: driver.name,
      details: `Driver deleted: ${driver.name}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete driver:", err);
    return { success: false, error: "Failed to delete driver" };
  }
}

/**
 * Set an ADMIN's active flag. SUPER_ADMIN-only operation, so it deliberately
 * spans scopes: the Users console manages ADMINs who each live in their own
 * tenant. Callers MUST have already checked the role.
 *
 * Drivers under the ADMIN are untouched by design — deactivating an office
 * account should not strand drivers mid-route.
 */
export async function setAdminActive(
  adminId: string,
  active: boolean
): Promise<{ success: boolean; error?: string }> {
  try {
    // SCOPE-EXEMPT: SUPER_ADMIN admin-management across scopes. Role-gated by
    // the caller; the target is addressed by primary key, never by a filter that
    // could sweep up rows the caller did not name.
    const admin = await UNSAFE_unscopedPrisma.admin.findUnique({
      where: { id: adminId },
      select: { id: true, name: true, email: true, tenantId: true },
    });
    if (!admin) return { success: false, error: "Admin not found" };

    await UNSAFE_unscopedPrisma.admin.update({
      where: { id: adminId },
      data: {
        active,
        // Revoking every session logs a deactivated admin out of all their
        // devices immediately rather than letting cookies run to expiry.
        ...(active
          ? {}
          : {
              sessions: revokeSessionsWrite("deactivated"),
              sessionToken: null,
              sessionTokens: [],
            }),
      },
    });

    await logAudit({
      action: active ? "ACCOUNT_REACTIVATE" : "ACCOUNT_DEACTIVATE",
      entity: "admin",
      entityId: admin.id,
      userName: admin.name,
      details: `Admin ${active ? "reactivated" : "deactivated — signed out of every device"}: ${admin.email}`,
      tenantId: admin.tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to change admin active state:", err);
    return { success: false, error: "Failed to update admin" };
  }
}

/**
 * Total admin accounts across the installation. Used only to detect first-run
 * bootstrap, so it is deliberately global.
 */
export async function getAdminCount(): Promise<number> {
  // SCOPE-EXEMPT: installation-wide bootstrap check; returns a count, no rows.
  return UNSAFE_unscopedPrisma.admin.count();
}
