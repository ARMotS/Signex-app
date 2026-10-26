/**
 * Scope resolution. The single place the application decides "whose data is
 * this request allowed to touch".
 *
 * The answer is derived ONLY from the HMAC-signed session cookie, server-side.
 * No route reads a tenant id from a body, query string, header or path param.
 */

import { getSession, validateSession } from '@/lib/session'
import { scopedPrisma, type ScopedPrismaClient } from '@/lib/db-scoped'
import { isBranchAllocated } from '@/lib/company'
import { UserRole } from '@prisma/client'

export class AuthError extends Error {
  constructor(public message: string, public status: number = 401) {
    super(message)
  }
}

const ROLE_MAP: Record<string, UserRole> = {
  admin: 'ADMIN',
  driver: 'DRIVER',
  super_admin: 'SUPER_ADMIN',
  company_admin: 'COMPANY_ADMIN',
  ADMIN: 'ADMIN',
  DRIVER: 'DRIVER',
  SUPER_ADMIN: 'SUPER_ADMIN',
}

export interface SessionContext {
  userId: string
  /** The scope this request operates in. For a SUPER_ADMIN or COMPANY_ADMIN
   *  viewing another scope, this is the *viewed* tenant, not its own. */
  tenantId: string
  /** The account's own home scope. Differs from tenantId only while a
   *  SUPER_ADMIN or COMPANY_ADMIN has the scope switcher pointed elsewhere. */
  homeTenantId: string
  /** True when a SUPER_ADMIN or COMPANY_ADMIN is viewing another scope. */
  isViewingOtherScope: boolean
  role: UserRole
  name: string
}

export async function getSessionContext(): Promise<SessionContext> {
  const session = await getSession()
  if (!session) throw new AuthError('Unauthenticated', 401)

  // The cookie's signature proves who it was issued to, not that it is still
  // signed in. Checked on every request, so a logout elsewhere, a password
  // reset or a deactivation ends this session on its next call.
  if (!(await validateSession(session))) {
    throw new AuthError('Your session has ended. Please sign in again.', 401)
  }

  const role = ROLE_MAP[session.role] || 'DRIVER'
  const homeTenantId = session.tenantId as string
  if (!homeTenantId) throw new AuthError('Session carries no scope', 401)

  // Only a SUPER_ADMIN or COMPANY_ADMIN may operate outside its home scope.
  // For ADMIN and DRIVER the field is not read at all, so a session that
  // somehow carries one is still hard-locked to its own tenant.
  //
  // A COMPANY_ADMIN's view is re-checked against its allocations on EVERY
  // request — the cookie only says what it last chose. An allocation removed,
  // or its company deactivated, since then drops it back to its home scope,
  // where getScope() hands it no data at all.
  let viewing: string | null = null
  if (session.viewTenantId) {
    if (role === 'SUPER_ADMIN') {
      viewing = session.viewTenantId
    } else if (
      role === 'COMPANY_ADMIN' &&
      (await isBranchAllocated(session.id, session.viewTenantId))
    ) {
      viewing = session.viewTenantId
    }
  }

  return {
    userId: session.id,
    tenantId: viewing ?? homeTenantId,
    homeTenantId,
    isViewingOtherScope: viewing !== null,
    role,
    name: session.name,
  }
}

/**
 * The standard entry point for every API route and server action.
 *
 * Returns the session context plus `db` — a Prisma client that cannot see
 * outside the resolved scope. Use `db`; do not import `prisma` directly in a
 * route handler.
 */
export async function getScope(): Promise<
  SessionContext & { db: ScopedPrismaClient }
> {
  const ctx = await getSessionContext()
  // A COMPANY_ADMIN's own scope is only where its account lives; it holds no
  // data, and no route may read or write it as though it did. Refused here,
  // once, rather than in every route — including routes with no role check.
  if (ctx.role === 'COMPANY_ADMIN' && !ctx.isViewingOtherScope) {
    throw new AuthError('Choose a branch first', 403)
  }
  return { ...ctx, db: scopedPrisma(ctx.tenantId) }
}

/**
 * Guard for office work in a scope: what an ADMIN may do in its own branch.
 * Passes an ADMIN, a SUPER_ADMIN, and a COMPANY_ADMIN while it is viewing a
 * branch allocated to it (acting there as that branch's admin). A
 * COMPANY_ADMIN in its own company-home scope has no branch to act in.
 */
export function requireOffice(ctx: { role: UserRole; isViewingOtherScope: boolean }) {
  if (ctx.role === 'ADMIN' || ctx.role === 'SUPER_ADMIN') return
  if (ctx.role === 'COMPANY_ADMIN') {
    if (ctx.isViewingOtherScope) return
    throw new AuthError('Choose a branch first', 403)
  }
  throw new AuthError('Forbidden', 403)
}

export function requireRole(
  ctx: { role: UserRole },
  ...roles: UserRole[]
) {
  if (!roles.includes(ctx.role)) throw new AuthError('Forbidden', 403)
}

/**
 * Guard for operations that must run in the caller's OWN scope and never in a
 * scope they are merely viewing — e.g. changing your own password, or anything
 * whose blast radius shouldn't follow the scope switcher.
 */
export function requireHomeScope(ctx: SessionContext) {
  if (ctx.isViewingOtherScope) {
    throw new AuthError(
      'Not available while viewing another scope — switch back first',
      403
    )
  }
}
