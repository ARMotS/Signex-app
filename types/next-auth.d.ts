import { UserRole } from '@prisma/client'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string
      role: UserRole
      tenantId: string
    }
  }
  interface JWT {
    role: UserRole
    tenantId: string
  }
}
