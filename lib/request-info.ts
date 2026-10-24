/**
 * Who is on the other end of a request, as far as its headers say: the client
 * IP and the user agent. Recorded on sessions for the devices list; never an
 * authorisation input.
 */

import { headers } from "next/headers";
import { MAX_USER_AGENT_LENGTH } from "./user-agent";

/**
 * The client's address. On Vercel the first x-forwarded-for entry is the
 * client as Vercel's edge saw it. Null when there is nothing to go on.
 */
export function clientIpFrom(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first.slice(0, 64);
  }
  const realIp = h.get("x-real-ip");
  if (realIp?.trim()) return realIp.trim().slice(0, 64);
  return null;
}

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
}

export function requestInfoFrom(h: Headers): RequestInfo {
  const ua = h.get("user-agent");
  return {
    ip: clientIpFrom(h),
    userAgent: ua ? ua.slice(0, MAX_USER_AGENT_LENGTH) : null,
  };
}

/**
 * The current request's info. Outside a request (a script, a test calling a
 * lib function directly) there are no headers, which is not an error here.
 */
export async function currentRequestInfo(): Promise<RequestInfo> {
  try {
    return requestInfoFrom(await headers());
  } catch {
    return { ip: null, userAgent: null };
  }
}
