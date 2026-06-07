import { NextRequest, NextResponse } from "next/server";
import { createAdminAccount, getAdminCount } from "@/lib/accounts";
import { createSession, getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

/**
 * POST /api/auth/signup
 * Creates an admin account. Only allowed if no admins exist yet (first-time setup)
 * or if the request comes from an existing admin session.
 */
export async function POST(request: NextRequest) {
  try {
    const { name, email, password } = await request.json();

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: "Name, email, and password are required" },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters" },
        { status: 400 }
      );
    }

    const adminCount = await getAdminCount();
    let tenantId: string;

    if (adminCount > 0) {
      const session = await getSession();
      if (!session || (session.role !== "admin" && session.role !== "super_admin")) {
        return NextResponse.json(
          { error: "Only existing admins can create new admin accounts" },
          { status: 403 }
        );
      }
      tenantId = session.tenantId!;
    } else {
      // First admin — find or create the default tenant
      const defaultTenant = await prisma.tenant.upsert({
        where: { slug: "default" },
        update: {},
        create: { name: "Default", slug: "default" },
      });
      tenantId = defaultTenant.id;
    }

    const result = await createAdminAccount(name, email, password);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // First account is SUPER_ADMIN, subsequent accounts are ADMIN
    const userRole = adminCount === 0 ? "SUPER_ADMIN" : "ADMIN";

    // Create corresponding User record for multi-tenant auth
    await prisma.user.upsert({
      where: { email: email.toLowerCase() },
      update: {},
      create: {
        email: email.toLowerCase(),
        name,
        role: userRole,
        tenantId,
      },
    });

    // Auto-login for first admin
    if (adminCount === 0 && result.account) {
      await createSession({
        id: result.account.id,
        role: "super_admin",
        name: result.account.name,
        email: result.account.email,
        tenantId,
      });
    }

    return NextResponse.json({
      success: true,
      account: result.account,
      firstAdmin: adminCount === 0,
    });
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
