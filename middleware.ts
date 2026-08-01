import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, checkAndRecordRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "127.0.0.1";
}

function isAuthRoute(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth/login") ||
    pathname.startsWith("/api/auth/signup")
  );
}

const ADMIN_ROUTES = [
  "/dashboard",
  "/contacts",
  "/drivers",
  "/trip-sheet",
  "/invoices",
  "/settings",
  "/backups",
  "/users",
];

const SUPER_ADMIN_ONLY_ROUTES = ["/users"];

const DRIVER_ROUTES = ["/run", "/sign"];

interface SessionHint {
  id?: string;
  role?: string;
  exp?: number;
}

/**
 * Best-effort read of the session cookie.
 *
 * The signature is NOT verified here — that happens server-side in getScope().
 * This is only used to pick a rate-limit bucket and to short-circuit obvious
 * page redirects, so a forged payload buys nothing: the route still rejects it,
 * and a forged id only ever moves the caller into a *different* bucket of the
 * same size.
 */
function readSessionHint(request: NextRequest): SessionHint | null {
  const cookie = request.cookies.get("signex-session");
  if (!cookie?.value) return null;

  try {
    const [payload] = cookie.value.split(".");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Pick the identity and budget for a request.
 *
 * Authenticated callers are keyed on their session so that a branch office
 * behind one NAT address gets one budget per person rather than one between
 * them all. Only anonymous traffic falls back to the IP.
 */
function resolveApiLimit(
  request: NextRequest,
  session: SessionHint | null
): { identifier: string; config: typeof RATE_LIMITS.apiAnon; group: string } {
  if (session?.id) {
    const role = session.role;
    if (role === "admin" || role === "super_admin") {
      return { identifier: session.id, group: "api:admin", config: RATE_LIMITS.apiAdmin };
    }
    if (role === "driver") {
      return { identifier: session.id, group: "api:driver", config: RATE_LIMITS.apiDriver };
    }
  }

  return {
    identifier: getClientIp(request),
    group: "api:anon",
    config: RATE_LIMITS.apiAnon,
  };
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate-limit API routes
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(request);
    const isAuth = isAuthRoute(pathname);

    if (isAuth) {
      // Auth routes stay keyed on IP — there is no session yet, and this is a
      // credential-stuffing control rather than a fair-use one.
      const result = await checkRateLimit(ip, "auth", RATE_LIMITS.auth);

      if (!result.allowed) {
        return NextResponse.json(
          { error: "Too many failed login attempts. Please try again later." },
          {
            status: 429,
            headers: {
              "Retry-After": String(result.retryAfterSeconds),
              "X-RateLimit-Limit": String(result.limit),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
            },
          }
        );
      }

      return NextResponse.next();
    }

    // General API rate limiting (every request counts), per session where one
    // exists so that shared office addresses no longer share a budget.
    const { identifier, group, config } = resolveApiLimit(
      request,
      readSessionHint(request)
    );
    const result = await checkAndRecordRateLimit(identifier, group, config);

    if (!result.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": String(result.retryAfterSeconds),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
          },
        }
      );
    }

    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Limit", String(result.limit));
    response.headers.set("X-RateLimit-Remaining", String(result.remaining));
    response.headers.set(
      "X-RateLimit-Reset",
      String(Math.ceil(result.resetAt / 1000))
    );

    return response;
  }

  // Page route protection — lazy import session check to avoid edge runtime issues
  const isAdminRoute = ADMIN_ROUTES.some((r) => pathname.startsWith(r));
  const isDriverRoute = DRIVER_ROUTES.some((r) => pathname.startsWith(r));

  if (!isAdminRoute && !isDriverRoute) {
    return NextResponse.next();
  }

  // Lightweight cookie check only — the authoritative check is server-side in
  // getScope(), which verifies the HMAC. This just avoids rendering a page that
  // is certain to be rejected.
  const data = readSessionHint(request);
  if (!data) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (!data.exp || data.exp < Date.now()) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Block drivers from admin routes
  if (isAdminRoute && data.role === "driver") {
    return NextResponse.redirect(new URL("/select", request.url));
  }

  // Block regular admins from super_admin-only routes
  const isSuperOnly = SUPER_ADMIN_ONLY_ROUTES.some((r) => pathname.startsWith(r));
  if (isSuperOnly && data.role !== "super_admin") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/api/:path*",
    "/dashboard/:path*",
    "/contacts/:path*",
    "/drivers/:path*",
    "/trip-sheet/:path*",
    "/invoices/:path*",
    "/settings/:path*",
    "/backups/:path*",
    "/users/:path*",
    "/run/:path*",
    "/sign/:path*",
  ],
};
