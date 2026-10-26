/**
 * Cookie-based session management.
 *
 * The cookie carries a signed JSON payload; the session it names is a
 * UserSession row, looked up by the SHA-256 of the cookie's token on EVERY
 * authenticated request (getScope() in lib/tenant.ts calls validateSession).
 * Revoking that row — a logout, a password reset, a deactivation, another
 * device taking the slot — signs the device out on its next request rather
 * than when the 24h cookie runs out.
 *
 * Devices an account may be signed in on at once are SESSION_LIMITS. A
 * DRIVER has one: signing in on a new phone signs the old one out. For an
 * office account a login past the limit is held back and the person is asked
 * first; only if they confirm is the OLDEST device signed out.
 *
 * Rollout: Admin.sessionTokens / sessionToken and Driver.sessionToken are
 * still written, so the previous deploy keeps validating. Remove the legacy
 * writes and adoptLegacySession in the contract deploy.
 */

import crypto from "crypto";
import { cookies } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { currentRequestInfo } from "./request-info";
import { describeUserAgent } from "./user-agent";

const SESSION_COOKIE = "signex-session";
const DEVICE_COOKIE = "signex-device";
const _secret = process.env.SESSION_SECRET;
if (!_secret) {
  throw new Error(
    "SESSION_SECRET environment variable is required. " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
  );
}
const SECRET: string = _secret;

export type SessionRole = "admin" | "driver" | "super_admin" | "company_admin";

export interface SessionData {
  id: string;
  role: SessionRole;
  name: string;
  email?: string;
  /** The account's OWN isolation scope. Never changes for the life of a session. */
  tenantId?: string;
  /**
   * SUPER_ADMIN / COMPANY_ADMIN only: the scope currently being viewed via the
   * scope switcher. Read exclusively by getSessionContext() in lib/tenant.ts,
   * ignored outright for any other role, and for a COMPANY_ADMIN honoured only
   * while the branch is still allocated to it. Lives inside the HMAC-signed
   * payload, so a client cannot set it — only POST /api/admin/scopes and
   * sign-in can.
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

/** `<issued-at, base36 ms>.<random hex>`. */
function generateSessionToken(now = Date.now()): string {
  return `${now.toString(36)}.${crypto.randomBytes(32).toString("hex")}`;
}

/** What UserSession stores and is looked up by. The token itself never is. */
export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Browsers cap a cookie's lifetime at 400 days. */
const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const DEVICE_ID = /^[a-f0-9]{32}$/;
/** How often a session's lastSeenAt may move. */
export const TOUCH_INTERVAL_MS = 60_000;

/** Devices an account may be signed in on at once, by role. */
export const SESSION_LIMITS: Record<SessionRole, number> = {
  super_admin: 1,
  company_admin: 3,
  admin: 5,
  driver: 1,
};

export type SessionStartPlan =
  | { ok: true; evict: string[] }
  | { ok: false; activeSessions: number };

/**
 * Decide what a new login does to the account's live sessions (ids, oldest
 * first). At the limit the login is REFUSED unless the person confirmed they
 * want the oldest device signed out — a login must never silently sign out
 * someone else who is working. (A driver's login always confirms: one phone.)
 */
export function planSessionStart(
  liveOldestFirst: string[],
  limit: number,
  evictOldest: boolean
): SessionStartPlan {
  if (liveOldestFirst.length >= limit && !evictOldest) {
    return { ok: false, activeSessions: liveOldestFirst.length };
  }
  return {
    ok: true,
    evict: liveOldestFirst.slice(0, Math.max(0, liveOldestFirst.length - limit + 1)),
  };
}

export interface SessionAccount {
  id: string;
  role: SessionRole;
  name: string;
  email?: string;
  tenantId?: string;
}

export interface SessionDevice {
  deviceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

function ownerOf(account: { id: string; role: SessionRole }) {
  return account.role === "driver" ? { driverId: account.id } : { adminId: account.id };
}

/**
 * Record a new session, or refuse it at the device limit. Database only — no
 * cookie; createSession() is the caller that writes one.
 *
 * The account row is locked for the read-decide-write, so two logins racing
 * on one account cannot both see a free slot.
 */
export async function startSession(
  account: { id: string; role: SessionRole },
  options: SessionDevice & { evictOldest?: boolean; now?: number } = {}
): Promise<
  | { ok: true; token: string; expiresAt: number; evicted: number }
  | { ok: false; activeSessions: number }
> {
  const now = options.now ?? Date.now();
  const token = generateSessionToken(now);
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const isDriver = account.role === "driver";
  const owner = ownerOf(account);
  const device = describeUserAgent(options.userAgent);

  return prisma.$transaction(async (tx) => {
    if (isDriver) {
      await tx.$queryRaw`SELECT "id" FROM "Driver" WHERE "id" = ${account.id} FOR UPDATE`;
    } else {
      await tx.$queryRaw`SELECT "id" FROM "Admin" WHERE "id" = ${account.id} FOR UPDATE`;
    }

    const live = await tx.userSession.findMany({
      where: { ...owner, revokedAt: null, expiresAt: { gt: new Date(now) } },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const plan = planSessionStart(
      live.map((s) => s.id),
      SESSION_LIMITS[account.role],
      isDriver || !!options.evictOldest
    );
    if (!plan.ok) return plan;

    if (plan.evict.length > 0) {
      await tx.userSession.updateMany({
        where: { id: { in: plan.evict } },
        data: { revokedAt: new Date(now), revokedReason: isDriver ? "replaced" : "evicted" },
      });
    }

    await tx.userSession.create({
      data: {
        tokenHash: hashSessionToken(token),
        ...owner,
        deviceId: options.deviceId ?? null,
        userAgent: options.userAgent ?? null,
        ipAddress: options.ip ?? null,
        browser: device.browser,
        os: device.os,
        deviceType: device.deviceType,
        createdAt: new Date(now),
        lastSeenAt: new Date(now),
        expiresAt: new Date(expiresAt),
      },
    });

    // Legacy columns, for the previous deploy. A driver's one token; an
    // admin's list minus every token whose session has ended, plus this one.
    if (isDriver) {
      await tx.driver.update({ where: { id: account.id }, data: { sessionToken: token } });
    } else {
      await tx.$executeRaw`
        UPDATE "Admin"
        SET "sessionTokens" = array_append(ARRAY(
              SELECT u.t FROM unnest("sessionTokens") WITH ORDINALITY AS u(t, n)
              WHERE NOT EXISTS (
                SELECT 1 FROM "UserSession" s
                WHERE s."tokenHash" = encode(sha256(convert_to(u.t, 'UTF8')), 'hex')
                  AND (s."revokedAt" IS NOT NULL OR s."expiresAt" <= ${new Date(now)})
              )
              ORDER BY u.n
            ), ${token}),
            "sessionToken" = ${token}
        WHERE "id" = ${account.id}`;
    }

    return { ok: true as const, token, expiresAt, evicted: plan.evict.length };
  });
}

/**
 * A nested write that ends every live session of the account it is attached
 * to, except the one holding `keepToken` (an account changing its own
 * password stays signed in where it did it from). Used inside the same
 * update as the change that makes the sessions untrustworthy, so the two
 * cannot come apart.
 */
export function revokeSessionsWrite(
  reason: "password_reset" | "deactivated" | "role_change",
  keepToken?: string | null
): {
  updateMany: {
    where: Prisma.UserSessionScalarWhereInput;
    data: Prisma.UserSessionUpdateManyMutationInput;
  };
} {
  return {
    updateMany: {
      where: {
        revokedAt: null,
        ...(keepToken ? { tokenHash: { not: hashSessionToken(keepToken) } } : {}),
      },
      data: { revokedAt: new Date(), revokedReason: reason },
    },
  };
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
 * Returns `{ ok: false }` — with NO cookie written — when an office account
 * is already on its device limit and `evictOldest` was not set. The caller
 * asks the person, and retries with `evictOldest: true` if they agree to sign
 * the oldest device out.
 */
export async function createSession(
  user: SessionAccount,
  options: { evictOldest?: boolean; viewTenantId?: string | null } = {}
): Promise<
  | { ok: true; deviceId: string; evicted: number }
  | { ok: false; activeSessions: number }
> {
  const cookieStore = await cookies();
  const existingDevice = cookieStore.get(DEVICE_COOKIE)?.value;
  const deviceId =
    existingDevice && DEVICE_ID.test(existingDevice)
      ? existingDevice
      : crypto.randomBytes(16).toString("hex");

  const info = await currentRequestInfo();
  const started = await startSession(user, {
    evictOldest: options.evictOldest,
    deviceId,
    ip: info.ip,
    userAgent: info.userAgent,
  });
  if (!started.ok) return started;

  // Renewed on every sign-in, so a device in daily use keeps its id.
  cookieStore.set(DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });

  await writeSessionCookie({
    ...user,
    // A fresh login starts in the account's own scope, except a COMPANY_ADMIN,
    // which the caller lands in an allocated branch (re-checked per request).
    viewTenantId: options.viewTenantId ?? null,
    sessionToken: started.token,
    exp: started.expiresAt,
  });
  return { ok: true, deviceId, evicted: started.evicted };
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

/** Read and verify the cookie. Says nothing about whether it was revoked. */
function readSessionCookie(value: string | undefined): SessionData | null {
  if (!value) return null;
  try {
    const [payload, signature] = value.split(".");
    if (signature !== sign(payload)) return null;
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * The signed session cookie, if any. This checks the signature and expiry
 * only — validateSession() is what checks it has not been revoked.
 */
export async function getSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const data = readSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!data) return null;

  if (data.exp < Date.now()) {
    await destroySession();
    return null;
  }
  return data;
}

/**
 * The signed session cookie, verified but with no side effects — no cookie is
 * cleared, nothing is revoked-checked. For the audit log to name who made a
 * request; never an authorisation check (getScope() is).
 */
export async function peekSession(): Promise<SessionData | null> {
  const cookieStore = await cookies();
  const data = readSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  return data && data.exp >= Date.now() ? data : null;
}

/** This browser's signex-device id, if it has one. */
export async function peekDeviceId(): Promise<string | null> {
  const cookieStore = await cookies();
  const id = cookieStore.get(DEVICE_COOKIE)?.value;
  return id && DEVICE_ID.test(id) ? id : null;
}

/**
 * A session signed in by the previous deploy during the rollout has a token
 * in the legacy columns and no UserSession row. Every revocation clears the
 * legacy columns too, so a token still there is live: take it on as a row.
 */
async function adoptLegacySession(session: SessionData, now: number): Promise<boolean> {
  if (session.exp <= now) return false;
  const legacy =
    session.role === "driver"
      ? await prisma.driver.findFirst({
          where: { id: session.id, sessionToken: session.sessionToken },
          select: { id: true },
        })
      : await prisma.admin.findFirst({
          where: {
            id: session.id,
            OR: [
              { sessionTokens: { has: session.sessionToken } },
              { sessionToken: session.sessionToken },
            ],
          },
          select: { id: true },
        });
  if (!legacy) return false;

  const info = await currentRequestInfo();
  const device = describeUserAgent(info.userAgent);
  await prisma.userSession
    .create({
      data: {
        tokenHash: hashSessionToken(session.sessionToken),
        ...ownerOf(session),
        userAgent: info.userAgent,
        ipAddress: info.ip,
        browser: device.browser,
        os: device.os,
        deviceType: device.deviceType,
        expiresAt: new Date(session.exp),
      },
    })
    // A concurrent request adopted it first.
    .catch(() => {});
  return true;
}

/**
 * Whether this session is still signed in: its row exists, belongs to this
 * account, has not been revoked and has not expired. Moves lastSeenAt at most
 * once a minute.
 *
 * A database error propagates rather than reading as "signed out" — a blip
 * must not log a driver out mid-route.
 */
export async function validateSession(
  session: SessionData,
  now: number = Date.now()
): Promise<boolean> {
  const row = await prisma.userSession.findUnique({
    where: { tokenHash: hashSessionToken(session.sessionToken) },
    select: {
      id: true,
      adminId: true,
      driverId: true,
      revokedAt: true,
      expiresAt: true,
      lastSeenAt: true,
    },
  });
  if (!row) return adoptLegacySession(session, now);

  if (row.revokedAt || row.expiresAt.getTime() <= now) return false;
  const owner = session.role === "driver" ? row.driverId : row.adminId;
  if (owner !== session.id) return false;

  if (now - row.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    const { ip } = await currentRequestInfo();
    // Conditional, so concurrent requests write it once. Never fails a request.
    await prisma.userSession
      .updateMany({
        where: { id: row.id, lastSeenAt: { lt: new Date(now - TOUCH_INTERVAL_MS) } },
        data: { lastSeenAt: new Date(now), ...(ip ? { ipAddress: ip } : {}) },
      })
      .catch(() => {});
  }
  return true;
}

/**
 * Sign out the device holding this session, leaving the account's other
 * devices signed in. Conditional on the session still being live: a device
 * that was signed out by a newer login must not, on its way out, revoke the
 * session that replaced it.
 */
export async function revokeSession(session: SessionData, reason = "logout"): Promise<void> {
  await prisma.userSession.updateMany({
    where: {
      tokenHash: hashSessionToken(session.sessionToken),
      ...ownerOf(session),
      revokedAt: null,
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  if (session.role === "driver") {
    await prisma.driver.updateMany({
      where: { id: session.id, sessionToken: session.sessionToken },
      data: { sessionToken: null },
    });
  } else {
    await prisma.$executeRaw`
      UPDATE "Admin"
      SET "sessionTokens" = array_remove("sessionTokens", ${session.sessionToken}),
          "sessionToken" = NULLIF("sessionToken", ${session.sessionToken})
      WHERE "id" = ${session.id}`;
  }
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const data = readSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (data) await revokeSession(data).catch(() => {});
  cookieStore.delete(SESSION_COOKIE);
}
