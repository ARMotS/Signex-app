import { NextRequest, NextResponse } from 'next/server'
import { AuthError } from '@/lib/tenant'
import { isScopeMiss } from '@/lib/db-scoped'

type Handler = (req: NextRequest, ctx?: any) => Promise<NextResponse | Response>

export function withAuth(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }

      // A scoped query that matched nothing, or an attempt to reach across a
      // scope boundary. Both answer 404 — never 403, never a distinct message —
      // so a caller cannot probe for the existence of another ADMIN's records.
      if (isScopeMiss(err)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
      }

      console.error(err)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
