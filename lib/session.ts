/**
 * Simple cookie-based session management.
 * Uses a signed JSON payload in an httpOnly cookie, revocable via session
 * tokens stored in DB.
 *
 * A DRIVER has one live session: signing in on a new phone signs the old one
 * out. An ADMIN / SUPER_ADMIN may be signed in on up to MAX_ADMIN_SESSIONS
 * devices (office PC, laptop, phone). A login past that is held back and the
 * person is asked first; only if they confirm is the OLDEST device signed out.
 * Expired sessions do not count, so a closed browser frees its slot within a
 * day.
 */

import crypto from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";

const SESSION_COOKIE = "signex-session";
const _secret = process.env.SESSION_SECRET;
if (!_secret) {
  throw new Error(
    "SESSION_SECRET environment variable is required. " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
  );
}
const SECRET: string = _secret;

export interface SessionData {
  id: string;
  role: "admin" | "driver" | "super_admin";
  name: string;
  email?: string;
  /** The account's OWN isolation scope. Never changes for the life of a session. */
  tenantId?: string;
  /**
   * SUPER_ADMIN only: the scope currently being viewed via the scope switcher.
   * Read exclusively by getScope() in lib/tenant.ts, and ignored outright for
   * any role other than super_admin. Lives inside the HMAC-signed payload, so a
   * client cannot set it — only POST /api/admin/scopes can.
   */
  viewTenantId?: string | null;
  sessionToken: string;
  exp: number;
}

function sign(data: string): string {
  const hmac = crypto.createHmac("sha256", SECRET);
  hmac.update(data);
  return hmac.digest("hex");
}

/**
 * `<issued-at, base36 ms>.<random hex>`. The issue time lets the session list
 * tell a live device from a cookie that has long since expired: a browser that
 * was simply closed never logs out, and without this its token would hold one
 * of the account's device slots forever.
 */
function generateSessionToken(now = Date.now()): string {
  return `${now.toString(36)}.${crypto.randomBytes(32).toString("hex")}`;
}

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Devices an ADMIN / SUPER_ADMIN may be signed in on at once. */
export const MAX_ADMIN_SESSIONS = 3;

/**
 * Whether a stored token can still belong to a live cookie. A token from
 * before issue times were embedded (bare hex) has an unknown age and is
 * treated as live; there is at most one per admin, carried over by the
 * migration, and it leaves the list like any other.
 */
export function isSessionTokenLive(token: string, now = Date.now()): boolean {
  const dot = token.indexOf(".");
  if (dot === -1) return true;
  const issuedAt = parseInt(token.slice(0, dot), 36);
  return Number.isFinite(issuedAt) && now - issuedAt < SESSION_MAX_AGE_SECONDS * 1000;
}

export type AdminSessionPlan =
  | { ok: true; tokens: string[] }
  | { ok: false; activeSessions: number };

/**
 * Decide what a new admin login does to the session list (oldest first).
 *
 * Expired tokens are dropped first, so only devices that can really still be
 * signed in count. At the limit the login is REFUSED unless the person has
 * confirmed they want the oldest device signed out — a 4th login must never
 * silently sign out someone else who is working.
 */
export function planAdminSession(
  current: string[],
  token: string,
  evictOldest: boolean,
  now = Date.now()
): AdminSessionPlan {
  const live = current.filter((t) => isSessionTokenLive(t, now));
  if (live.length >= MAX_ADMIN_SESSIONS && !evictOldest) {
    return { ok: false, activeSessions: live.length };
  }
  return { ok: true, tokens: [...live, token].slice(-MAX_ADMIN_SESSIONS) };
}

/**
 * Record a new admin session, or refuse it at the device limit.
 *
 * The row is locked for the read-decide-write, so two logins racing on one
 * account cannot both see a free slot, nor drop each other's token.
 * `sessionToken` is still written for the previous deploy (see schema).
 */
export async function addAdminSession(
  adminId: string,
  token: string,
  evictOldest: boolean
): Promise<AdminSessionPlan> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ sessionTokens: string[] }[]>`
      SELECT "sessionTokens" FROM "Admin" WHERE "id" = ${adminId} FOR UPDATE`;
    const plan = planAdminSession(rows[0]?.sessionTokens ?? [], token, evictOldest);
    if (plan.ok) {
      await tx.admin.update({
        where: { id: adminId },
        data: { sessionTokens: plan.tokens, sessionToken: token },
      });
    }
    return plan;
  });
}

/** Revoke one admin session, leaving the account's other devices signed in. */
export async function removeAdminSession(adminId: string, token: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Admin"
    SET "sessionTokens" = array_remove("sessionTokens", ${token}),
        "sessionToken" = NULLIF("sessionToken", ${token})
    WHERE "id" = ${adminId}`;
}

/** Serialise, sign and write the session cookie. */
async function writeSessionCookie(session: SessionData): Promise<void> {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64");
  const signature = sign(payload);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, `${payload}.${signature}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Start a session and write its cookie.
 *
 * Returns `{ ok: false }` — with NO cookie written — when an admin is already
 * signed in on MAX_ADMIN_SESSIONS devices and `evictOldest` was not set. The
 * caller asks the person, and retries with `evictOldest: true` if they agree
 * to sign the oldest device out.
 */
export async function createSession(
  user: {
    id: string;
    role: "admin" | "driver" | "super_admin";
    name: string;
    email?: string;
    tenantId?: string;
  },
  options: { evictOldest?: boolean } = {}
): Promise<{ ok: true } | { ok: false; activeSessions: number }> {
  const sessionToken = generateSessionToken();

  // Store session token in DB. A driver's replaces any prior session; an
  // admin's joins the list, up to MAX_ADMIN_SESSIONS.
  if (user.role === "driver") {
    await prisma.driver.update({
      where: { id: user.id },
      data: { sessionToken },
    });
  } else {
    const plan = await addAdminSession(user.id, sessionToken, !!options.evictOldest);
    if (!plan.ok) return plan;
  }

  await writeSessionCookie({
    ...user,
    // A fresh login always starts in the account's own scope.
    viewTenantId: null,
    sessionToken,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
  return { ok: true };
}

/**
 * SUPER_ADMIN scope switcher: re-issue the current session cookie with a
 * different `viewTenantId`, leaving identity, session token and expiry intact.
 *
 * Callers MUST have already verified the caller is a SUPER_ADMIN and that the
 * target tenant exists — this function performs no authorization of its own.
 * Pass `null` to return to the account's own scope.
 */
export async function setViewScope(viewTenantId: string | null): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;

  await writeSessionCookie({ ...session, viewTenantId });
  return true;
}

export async function getSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE);

  if (!cookie?.value) return null;

  try {
    const [payload, signature] = cookie.value.split(".");
    const expectedSignature = sign(payload);

    if (signature !== expectedSignature) return null;

    const data: SessionData = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8")
    );

    if (data.exp < Date.now()) {
      await destroySession();
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Validate that the session token matches what's stored in DB.
 * Returns false if another login has invalidated this session.
 */
export async function validateSessionToken(session: SessionData): Promise<boolean> {
  try {
    if (session.role === "driver") {
      const driver = await prisma.driver.findUnique({
        where: { id: session.id },
        select: { sessionToken: true },
      });
      return driver?.sessionToken === session.sessionToken;
    } else {
      const admin = await prisma.admin.findUnique({
        where: { id: session.id },
        select: { sessionTokens: true, sessionToken: true },
      });
      // sessionToken: a login served by the previous deploy during the
      // rollout wrote only that column. It is always cleared alongside the
      // list, so it never keeps a revoked session alive.
      return (
        !!admin &&
        (admin.sessionTokens.includes(session.sessionToken) ||
          admin.sessionToken === session.sessionToken)
      );
    }
  } catch {
    return false;
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE);

  if (cookie?.value) {
    try {
      const [payload, signature] = cookie.value.split(".");
      const expectedSignature = sign(payload);
      if (signature === expectedSignature) {
        const data: SessionData = JSON.parse(
          Buffer.from(payload, "base64").toString("utf-8")
        );
        // Revoke THIS device's token only. Conditional on the token still being
        // ours: a device that was signed out by a newer login must not, on its
        // way out, revoke the session that replaced it.
        if (data.role === "driver") {
          await prisma.driver.updateMany({
            where: { id: data.id, sessionToken: data.sessionToken },
            data: { sessionToken: null },
          }).catch(() => {});
        } else {
          await removeAdminSession(data.id, data.sessionToken).catch(() => {});
        }
      }
    } catch {}
  }

  cookieStore.delete(SESSION_COOKIE);
}
