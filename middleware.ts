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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Rate-limit API routes
  if (pathname.startsWith("/api/")) {
    const ip = getClientIp(request);
    const isAuth = isAuthRoute(pathname);

    if (isAuth) {
      // Auth routes: check failed-attempt-based rate limit (only failures are counted)
      const result = checkRateLimit(ip, "auth", RATE_LIMITS.auth);

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

    // General API rate limiting (every request counts)
    const result = checkAndRecordRateLimit(ip, "api", RATE_LIMITS.api);

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

  // Check session cookie exists (lightweight check in middleware)
  const sessionCookie = request.cookies.get("signex-session");
  if (!sessionCookie?.value) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Decode session to check role
  try {
    const [payload] = sessionCookie.value.split(".");
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));

    if (data.exp < Date.now()) {
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
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
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
