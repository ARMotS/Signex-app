/**
 * Scope resolution. The single place the application decides "whose data is
 * this request allowed to touch".
 *
 * The answer is derived ONLY from the HMAC-signed session cookie, server-side.
 * No route reads a tenant id from a body, query string, header or path param.
 */

import { getSession } from '@/lib/session'
import { scopedPrisma, type ScopedPrismaClient } from '@/lib/db-scoped'
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
  ADMIN: 'ADMIN',
  DRIVER: 'DRIVER',
  SUPER_ADMIN: 'SUPER_ADMIN',
}

export interface SessionContext {
  userId: string
  /** The scope this request operates in. For a SUPER_ADMIN viewing another
   *  ADMIN's scope, this is the *viewed* tenant, not the SUPER_ADMIN's own. */
  tenantId: string
  /** The account's own home scope. Differs from tenantId only while a
   *  SUPER_ADMIN has the scope switcher pointed elsewhere. */
  homeTenantId: string
  /** True when a SUPER_ADMIN is viewing someone else's scope. */
  isViewingOtherScope: boolean
  role: UserRole
  name: string
}

export async function getSessionContext(): Promise<SessionContext> {
  const session = await getSession()
  if (!session) throw new AuthError('Unauthenticated', 401)

  const role = ROLE_MAP[session.role] || 'DRIVER'
  const homeTenantId = session.tenantId as string
  if (!homeTenantId) throw new AuthError('Session carries no scope', 401)

  // Only a SUPER_ADMIN may operate outside its home scope. For ADMIN and
  // DRIVER the field is not read at all, so a session that somehow carries one
  // is still hard-locked to its own tenant.
  const viewing =
    role === 'SUPER_ADMIN' && session.viewTenantId ? session.viewTenantId : null

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
  return { ...ctx, db: scopedPrisma(ctx.tenantId) }
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
