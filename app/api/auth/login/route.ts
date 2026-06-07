import { NextRequest, NextResponse } from "next/server";
import { loginAdmin, loginDriver } from "@/lib/accounts";
import { createSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { recordFailedAttempt, clearAttempts, RATE_LIMITS } from "@/lib/rate-limit";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

/**
 * POST /api/auth/login
 * Login for both admin and driver accounts.
 * Body: { role: "admin"|"driver", email?, password?, name?, pin? }
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);

  try {
    const body = await request.json();
    const { role } = body;

    if (role === "admin") {
      const { email, password } = body;
      if (!email || !password) {
        return NextResponse.json(
          { error: "Email and password are required" },
          { status: 400 }
        );
      }

      const result = await loginAdmin(email, password);
      if (!result.success) {
        recordFailedAttempt(ip, "auth", RATE_LIMITS.auth);
        return NextResponse.json({ error: result.error }, { status: 401 });
      }

      // Look up User record to get tenantId and role
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
      });

      if (!user) {
        return NextResponse.json(
          { error: "No user account linked to this email" },
          { status: 403 }
        );
      }

      clearAttempts(ip, "auth");

      await createSession({
        id: result.account!.id,
        role: user.role === "SUPER_ADMIN" ? "super_admin" : "admin",
        name: result.account!.name,
        email: result.account!.email,
        tenantId: user.tenantId,
      });

      return NextResponse.json({
        success: true,
        account: result.account,
      });
    }

    if (role === "driver") {
      const { name, pin } = body;
      if (!pin || !name) {
        return NextResponse.json(
          { error: "Name and PIN are required" },
          { status: 400 }
        );
      }

      const result = await loginDriver(name, pin);
      if (!result.success) {
        recordFailedAttempt(ip, "auth", RATE_LIMITS.auth);
        return NextResponse.json({ error: result.error }, { status: 401 });
      }

      clearAttempts(ip, "auth");

      await createSession({
        id: result.account!.id,
        role: "driver",
        name: result.account!.name,
        tenantId: result.account!.tenantId,
      });

      return NextResponse.json({
        success: true,
        account: result.account,
      });
    }

    return NextResponse.json(
      { error: "Invalid role. Use 'admin' or 'driver'" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Login failed" },
      { status: 500 }
    );
  }
}
