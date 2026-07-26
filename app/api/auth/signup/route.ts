import { NextResponse } from "next/server";
import { createAdminAccount, getAdminCount } from "@/lib/accounts";
import { createSession } from "@/lib/session";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";

/**
 * POST /api/auth/signup
 *
 * First-run bootstrap ONLY: creates the very first account, as SUPER_ADMIN, in
 * the root scope.
 *
 * The previous version also let an existing admin create further admins, taking
 * `tenantId` from the creator's session — which put every new ADMIN in the
 * creator's scope and was the root cause of cross-ADMIN data visibility. Admin
 * creation now lives solely at POST /api/admin/users, which mints a fresh scope
 * per ADMIN.
 */
export async function POST(request: Request) {
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

    if (adminCount > 0) {
      return NextResponse.json(
        {
          error:
            "Signup is closed. Only the SUPER_ADMIN can create admin accounts, via the Users page.",
        },
        { status: 403 }
      );
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    // SCOPE-EXEMPT: first-run bootstrap. The root scope belongs to the
    // SUPER_ADMIN; every ADMIN created later gets its own tenant.
    const rootTenant = await UNSAFE_unscopedPrisma.tenant.upsert({
      where: { slug: "default" },
      update: {},
      create: { name: "Default", slug: "default" },
    });

    const result = await createAdminAccount(
      name,
      normalizedEmail,
      password,
      rootTenant.id
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await UNSAFE_unscopedPrisma.user.upsert({
      where: { email: normalizedEmail },
      update: {},
      create: {
        email: normalizedEmail,
        name,
        role: "SUPER_ADMIN",
        tenantId: rootTenant.id,
      },
    });

    if (result.account) {
      await createSession({
        id: result.account.id,
        role: "super_admin",
        name: result.account.name,
        email: result.account.email,
        tenantId: rootTenant.id,
      });
    }

    return NextResponse.json({
      success: true,
      account: result.account,
      firstAdmin: true,
    });
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 }
    );
  }
}
