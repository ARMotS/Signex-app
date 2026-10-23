import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runCourierConfirmationJob } from "@/lib/courier-confirm-job";

/** Filing retries and emails for every scope, once a day. */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Constant-time, so the secret cannot be guessed a character at a time. */
function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * The daily courier job (vercel.json). Vercel calls it with
 * `Authorization: Bearer $CRON_SECRET`; anything else is refused, and so is
 * every call when CRON_SECRET is not set.
 */
export async function GET(request: NextRequest) {
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const summary = await runCourierConfirmationJob();
  console.log("[cron] courier confirmations:", JSON.stringify(summary));
  return NextResponse.json(summary);
}
