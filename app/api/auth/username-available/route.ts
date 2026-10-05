import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { isUsernameTaken } from "@/lib/accounts";
import { normalizeUsername, validateUsername, USERNAME_TAKEN } from "@/lib/credentials";

/**
 * GET /api/auth/username-available?username=<name>
 *
 * Live availability for the account forms, as the user types. Usernames are
 * unique across every role and scope, so this answers for the whole
 * installation — and therefore is limited to the people who create accounts
 * (ADMIN / SUPER_ADMIN) rather than offered pre-authentication, where it would
 * be a free username-enumeration oracle. It still reveals only existence.
 *
 * Advisory: the create/update routes re-check, and LoginName's primary key is
 * the final word.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const username = normalizeUsername(request.nextUrl.searchParams.get("username"));

  const invalid = validateUsername(username);
  if (invalid) {
    return NextResponse.json({ username, available: false, error: invalid });
  }

  const taken = await isUsernameTaken(username);
  return NextResponse.json({
    username,
    available: !taken,
    ...(taken && { error: USERNAME_TAKEN }),
  });
});
