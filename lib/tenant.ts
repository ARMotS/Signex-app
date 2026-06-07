import { getSession } from '@/lib/session'
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

export async function getSessionContext() {
  const session = await getSession()
  if (!session) throw new AuthError('Unauthenticated', 401)
  const role = ROLE_MAP[session.role] || 'DRIVER'
  return {
    userId: session.id,
    tenantId: session.tenantId as string,
    role,
  }
}

export function requireRole(
  ctx: { role: UserRole },
  ...roles: UserRole[]
) {
  if (!roles.includes(ctx.role)) throw new AuthError('Forbidden', 403)
}
