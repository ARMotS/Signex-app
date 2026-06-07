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

interface SessionData {
  id: string;
  role: "admin" | "driver" | "super_admin";
  name: string;
  email?: string;
  tenantId?: string;
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

  const session: SessionData = {
    ...user,
    sessionToken,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };

  const payload = Buffer.from(JSON.stringify(session)).toString("base64");
  const signature = sign(payload);
  const value = `${payload}.${signature}`;

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60, // 24 hours
  });
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
