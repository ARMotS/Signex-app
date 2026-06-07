import { NextRequest, NextResponse } from 'next/server'
import { AuthError } from '@/lib/tenant'

type Handler = (req: NextRequest, ctx?: any) => Promise<NextResponse | Response>

export function withAuth(handler: Handler): Handler {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx)
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      console.error(err)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
