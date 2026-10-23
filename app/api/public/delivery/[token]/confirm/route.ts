import { NextRequest, NextResponse } from "next/server";
import { confirmDelivery, type ConfirmOutcome } from "@/lib/courier-confirm";

type Ctx = { params: Promise<{ token: string }> };

const STATUS: Record<ConfirmOutcome, number> = {
  confirmed: 200,
  already_confirmed: 200,
  expired: 410,
  not_found: 404,
};

/**
 * The customer pressed Confirm received (lib/courier-confirm.ts). Public: the
 * link's token is the credential, and there is no session to take a scope
 * from. Rate-limited per IP by the middleware's anonymous budget.
 */
export async function POST(_request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  try {
    const result = await confirmDelivery(token);
    return NextResponse.json(result, { status: STATUS[result.outcome], headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[delivery confirm]", err);
    return NextResponse.json({ error: "Something went wrong — please try again." }, { status: 500 });
  }
}
