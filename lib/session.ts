/**
 * Simple cookie-based session management.
 * Uses a signed JSON payload in an httpOnly cookie.
 * Enforces single active session per user via session tokens stored in DB.
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

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

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

export async function createSession(user: {
  id: string;
  role: "admin" | "driver" | "super_admin";
  name: string;
  email?: string;
  tenantId?: string;
}): Promise<void> {
  const sessionToken = generateSessionToken();

  // Store session token in DB — invalidates any prior session for this user
  if (user.role === "driver") {
    await prisma.driver.update({
      where: { id: user.id },
      data: { sessionToken },
    });
  } else {
    await prisma.admin.update({
      where: { id: user.id },
      data: { sessionToken },
    });
  }

  await writeSessionCookie({
    ...user,
    // A fresh login always starts in the account's own scope.
    viewTenantId: null,
    sessionToken,
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  });
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
        select: { sessionToken: true },
      });
      return admin?.sessionToken === session.sessionToken;
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
        // Clear session token in DB on logout
        if (data.role === "driver") {
          await prisma.driver.update({
            where: { id: data.id },
            data: { sessionToken: null },
          }).catch(() => {});
        } else {
          await prisma.admin.update({
            where: { id: data.id },
            data: { sessionToken: null },
          }).catch(() => {});
        }
      }
    } catch {}
  }

  cookieStore.delete(SESSION_COOKIE);
}
