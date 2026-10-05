/**
 * Page routing by role. The middleware's cookie read is a hint, not the
 * authority — every API route re-checks with getScope()/requireRole() — but it
 * is what stops a driver even rendering an admin page by typing its URL.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

function pageRequest(path: string, role?: string): NextRequest {
  const request = new NextRequest(`http://localhost${path}`);
  if (role) {
    const payload = Buffer.from(
      JSON.stringify({ id: "x", role, exp: Date.now() + 60_000 })
    ).toString("base64");
    request.cookies.set("signex-session", `${payload}.sig`);
  }
  return request;
}

/** Where the middleware sends this request, or null when it lets it through. */
async function landing(path: string, role?: string): Promise<string | null> {
  const res = await middleware(pageRequest(path, role));
  const location = res.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("page routing by role", () => {
  it("sends a signed-out visitor on any protected page to the login", async () => {
    for (const path of ["/dashboard", "/users", "/run", "/sign/abc", "/collect/abc"]) {
      expect(await landing(path)).toBe("/login");
    }
  });

  it("never lets a driver render an admin page", async () => {
    for (const path of ["/dashboard", "/drivers", "/users", "/collections", "/settings/x"]) {
      expect(await landing(path, "driver")).toBe("/run");
    }
  });

  it("keeps office accounts out of the driver app", async () => {
    expect(await landing("/run", "admin")).toBe("/dashboard");
    expect(await landing("/collect/abc", "admin")).toBe("/dashboard");
    expect(await landing("/sign/abc", "super_admin")).toBe("/users");
  });

  it("keeps an ADMIN out of the super-admin console", async () => {
    expect(await landing("/users", "admin")).toBe("/dashboard");
    expect(await landing("/users", "super_admin")).toBeNull();
  });

  it("lets each role through to its own pages", async () => {
    expect(await landing("/dashboard", "admin")).toBeNull();
    expect(await landing("/dashboard", "super_admin")).toBeNull();
    expect(await landing("/run", "driver")).toBeNull();
    expect(await landing("/collect/abc", "driver")).toBeNull();
  });

  it("does not mistake /collections (admin) for /collect (driver)", async () => {
    expect(await landing("/collections", "admin")).toBeNull();
    expect(await landing("/collections", "driver")).toBe("/run");
  });

  it("redirects the retired driver PIN sign-in to the one login", async () => {
    expect(await landing("/select")).toBe("/login");
    expect(await landing("/select/admin-abc123")).toBe("/login");
  });
});
