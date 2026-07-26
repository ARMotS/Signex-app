import { NextRequest, NextResponse } from "next/server";
import { loginAdmin, loginDriver } from "@/lib/accounts";
import { createSession } from "@/lib/session";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
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
 *
 * Both paths resolve the caller's isolation scope from their own DB row — the
 * client never supplies or influences it.
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

      // The scope now comes from Admin.tenantId directly. It used to be looked
      // up by joining User on email, which meant a missing or drifted User row
      // either blocked login or resolved the wrong scope.
      // SCOPE-EXEMPT: pre-session role lookup, keyed on a globally unique email.
      const user = await UNSAFE_unscopedPrisma.user.findUnique({
        where: { email: String(email).toLowerCase() },
        select: { role: true },
      });

      clearAttempts(ip, "auth");

      await createSession({
        id: result.account!.id,
        role: user?.role === "SUPER_ADMIN" ? "super_admin" : "admin",
        name: result.account!.name,
        email: result.account!.email,
        tenantId: result.account!.tenantId,
      });

      return NextResponse.json({
        success: true,
        account: {
          id: result.account!.id,
          name: result.account!.name,
          email: result.account!.email,
        },
      });
    }

    if (role === "driver") {
      const { name, pin, company } = body;
      if (!pin || !name) {
        return NextResponse.json(
          { error: "Name and PIN are required" },
          { status: 400 }
        );
      }

      // `company` is the tenant SLUG from the per-operator sign-in link. Resolve
      // it to a scope here so the candidate search can be narrowed. It is only a
      // hint: the PIN is what authenticates, and the resulting session scope comes
      // from the matched driver row, never from this value.
      let companyTenantId: string | undefined;
      if (typeof company === "string" && company) {
        // SCOPE-EXEMPT: pre-session slug lookup. Returns an id used only to narrow
        // the candidate set; an unknown slug simply leaves it undefined.
        const tenant = await UNSAFE_unscopedPrisma.tenant.findFirst({
          where: { slug: company },
          select: { id: true },
        });
        companyTenantId = tenant?.id;
      }

      // Driver names are unique per scope, so loginDriver verifies the PIN
      // against every same-named candidate and accepts only a unique match.
      const result = await loginDriver(name, pin, companyTenantId);
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
        account: {
          id: result.account!.id,
          name: result.account!.name,
          active: result.account!.active,
        },
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
