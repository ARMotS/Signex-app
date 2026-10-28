import { NextRequest, NextResponse } from "next/server";
import { login, LOGIN_FAILED } from "@/lib/accounts";
import { createSession } from "@/lib/session";
import { normalizeUsername, homePathForRole } from "@/lib/credentials";
import { logAudit } from "@/lib/audit";
import { firstAllocatedBranch } from "@/lib/company";
import {
  checkRateLimits,
  recordFailedAttempts,
  clearAttemptsFor,
  RATE_LIMITS,
} from "@/lib/rate-limit";

const ROLE = {
  admin: "ADMIN",
  driver: "DRIVER",
  super_admin: "SUPER_ADMIN",
  company_admin: "COMPANY_ADMIN",
} as const;

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

/**
 * POST /api/auth/login
 * Body: { username, password, confirmEvict? }
 *
 * 409 { code: "SESSION_LIMIT" } when an admin is already signed in on the
 * maximum number of devices; resubmitting with confirmEvict: true signs the
 * oldest of them out and proceeds.
 *
 * The single sign-in for every role. The account's role and isolation scope
 * come from its own DB row — the client never supplies or influences either —
 * and the response says where that role lands.
 *
 * Two failure counters run side by side: per IP (sized for a depot behind one
 * address) and per username (the lockout on guessing at one account). Both
 * are read, recorded and cleared together, one Redis command each time.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  try {
    const body = await request.json().catch(() => ({}));
    const username = normalizeUsername(body?.username);
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json(
        { error: "Enter your username and password" },
        { status: 400 }
      );
    }

    // The username counter is keyed on the name as submitted, whether or not it
    // exists, so being locked out says nothing about which usernames are real.
    const counters = [
      { identifier: ip, group: "auth", config: RATE_LIMITS.auth },
      { identifier: username, group: "auth:user", config: RATE_LIMITS.authUser },
    ];
    const [byIp, lockout] = await checkRateLimits(counters);

    if (!byIp.allowed) {
      return NextResponse.json(
        { error: "Too many failed login attempts. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(byIp.retryAfterSeconds),
            "X-RateLimit-Limit": String(byIp.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil(byIp.resetAt / 1000)),
          },
        }
      );
    }

    if (!lockout.allowed) {
      const minutes = Math.max(1, Math.ceil(lockout.retryAfterSeconds / 60));
      return NextResponse.json(
        {
          error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        },
        { status: 429, headers: { "Retry-After": String(lockout.retryAfterSeconds) } }
      );
    }

    const result = await login(username, password);

    if (!result.success) {
      // Only a wrong credential counts toward a lockout. A deactivated account
      // supplied the right password, so it is not a guess.
      if (result.error === LOGIN_FAILED) {
        await recordFailedAttempts(counters);
      }
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    // Only counters that held something when read are cleared — the usual
    // sign-in has no failures behind it, and a DEL of nothing still costs a
    // command.
    const peeked = [byIp, lockout];
    await clearAttemptsFor(
      counters.filter((c, i) => peeked[i].remaining < c.config.maxAttempts)
    );

    const { account } = result;
    const started = await createSession(
      {
        id: account.id,
        role: account.role,
        name: account.name,
        email: account.email,
        tenantId: account.tenantId,
      },
      {
        evictOldest: body?.confirmEvict === true,
        // A COMPANY_ADMIN's own scope holds no data: start it in a branch it
        // oversees. getSessionContext() re-checks the allocation every request.
        viewTenantId:
          account.role === "company_admin" ? await firstAllocatedBranch(account.id) : null,
      }
    );

    // An office account already on its device limit (SESSION_LIMITS). Nothing
    // was signed in or out; the form asks, and resubmits with confirmEvict if
    // they go ahead. Only reachable with the right password, so it reveals
    // nothing to a guesser.
    if (!started.ok) {
      const n = started.activeSessions;
      return NextResponse.json(
        {
          code: "SESSION_LIMIT",
          activeSessions: n,
          error: `This account is already signed in on ${n === 1 ? "another device" : `${n} devices`}.`,
        },
        { status: 409 }
      );
    }

    // Logged here, not in login(): only now has a session actually started.
    // The device id is passed because its cookie was only just set.
    await logAudit({
      action: "LOGIN",
      entity: account.role === "driver" ? "driver" : "admin",
      entityId: account.id,
      userName: account.name,
      details:
        started.evicted > 0
          ? `Signed in — signed out ${started.evicted} older device${started.evicted === 1 ? "" : "s"}`
          : "Signed in",
      tenantId: account.tenantId,
      actor: { id: account.id, role: ROLE[account.role] },
      deviceId: started.deviceId,
      ...(started.evicted > 0 && { metadata: { evictedDevices: started.evicted } }),
    });

    return NextResponse.json({
      success: true,
      role: account.role,
      redirectTo: homePathForRole(account.role),
      account: { id: account.id, name: account.name },
    });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json({ error: "Login failed" }, { status: 500 });
  }
}
