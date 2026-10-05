import { NextRequest, NextResponse } from "next/server";
import { login, LOGIN_FAILED } from "@/lib/accounts";
import { createSession } from "@/lib/session";
import { normalizeUsername, homePathForRole } from "@/lib/credentials";
import {
  checkRateLimit,
  recordFailedAttempt,
  clearAttempts,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

/**
 * POST /api/auth/login
 * Body: { username, password }
 *
 * The single sign-in for every role. The account's role and isolation scope
 * come from its own DB row — the client never supplies or influences either —
 * and the response says where that role lands.
 *
 * Two failure counters run side by side: per IP (checked in middleware.ts,
 * sized for a depot behind one address) and per username (checked here — the
 * lockout on guessing at one account).
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

    // Keyed on the name as submitted, whether or not it exists, so being locked
    // out says nothing about which usernames are real.
    const lockout = await checkRateLimit(username, "auth:user", RATE_LIMITS.authUser);
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
        await Promise.all([
          recordFailedAttempt(ip, "auth", RATE_LIMITS.auth),
          recordFailedAttempt(username, "auth:user", RATE_LIMITS.authUser),
        ]);
      }
      return NextResponse.json({ error: result.error }, { status: 401 });
    }

    await Promise.all([clearAttempts(ip, "auth"), clearAttempts(username, "auth:user")]);

    const { account } = result;
    await createSession({
      id: account.id,
      role: account.role,
      name: account.name,
      email: account.email,
      tenantId: account.tenantId,
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
